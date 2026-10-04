/** Produces restorable JSON, readable Markdown, and attachment files for every backup target. */
import {
  backupAttachmentPath,
  backupCompleteBody,
  backupCompletePath,
  backupManifestPath,
  parseMarkdownBackupManifest,
  type MarkdownBackupAttachmentEntry,
  type MarkdownBackupManifest,
  type MarkdownBackupNoteEntry,
  type MarkdownBackupNoteState,
  MARKDOWN_BACKUP_FORMAT,
  MARKDOWN_BACKUP_VERSION,
} from '@shared/backup-format'
import { APP_VERSION, LIMITS } from '@shared/constants'
import { extractAttachmentIds } from '@shared/markdown-utils'
import { truncateText } from '@shared/text-utils'
import type { ExportBundle } from '@shared/types'
import { estimateZipSizeFromSizes } from '@shared/zip'
import {
  hasAttachmentStorage,
  isAttachmentObjectStorage,
  readAttachmentObjectStream,
} from '../attachments/backend'
import { attachmentObjectKey } from '../attachments/keys'
import { NOTE_COLUMNS_FULL, toFolder, toNote, toTag, type FolderRow, type NoteRow, type TagRow } from '../db/rows'
import type { Env } from '../env'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { safeAttachmentMime } from '../lib/image'

export type BackupFileKind = 'note' | 'attachment' | 'readme' | 'manifest' | 'complete'

export interface BackupFile {
  path: string
  byteLength: number
  sha256: string
  contentType: string
  kind: BackupFileKind
  open: () => Promise<ReadableStream<Uint8Array>>
}

export interface MaterializedBackupFile {
  path: string
  body: Uint8Array
  contentType: string
}

export interface Snapshot {
  payloadFiles: BackupFile[]
  manifestFile: BackupFile
  completeFile: BackupFile
  noteCount: number
  attachmentCount: number
  bytes: number
  stamp: string
  createdAt: Date
}

interface AttachmentSnapshotRow {
  id: string
  user_id: string
  filename: string
  mime: string
  size: number
  sha256: string
  storage: string
  created_at: number
}

const encoder = new TextEncoder()
const NOTE_PAGE_SIZE = 100
const ATTACHMENT_LOOKUP_BATCH = 200
const ATTACHMENT_REFERENCE_RE =
  /(?:https?:\/\/[^/\s<>"']+)?\/api\/files\/([0-9a-hjkmnp-tv-z]{26})(?=$|[\s>)\]"'?#])/g

export async function buildSnapshot(env: Env, userId: string): Promise<Snapshot> {
  const folderResult = await env.DB.prepare(
    `SELECT f.id, f.parent_id, f.name, f.icon, f.color, f.position, f.created_at, f.updated_at
       FROM folders f WHERE f.user_id = ?1 ORDER BY f.position ASC, f.id ASC`,
  ).bind(userId).all<FolderRow>()
  const folders = folderResult.results.map(toFolder)
  const folderPaths = buildFolderPaths(folders)
  const attachmentsById = new Map<string, AttachmentSnapshotRow>()

  const attachmentPathByHash = new Map<string, string>()
  const attachmentPathById = new Map<string, string>()
  const selectedAttachmentsByHash = new Map<string, AttachmentSnapshotRow>()

  const now = new Date()
  const stamp = formatStamp(now)
  const noteFiles: BackupFile[] = []
  const noteEntries: MarkdownBackupNoteEntry[] = []
  const usedPaths = new Set<string>()
  let afterId = ''

  while (true) {
    const page = await env.DB.prepare(
      `SELECT ${NOTE_COLUMNS_FULL} FROM notes n
        WHERE n.user_id = ?1 AND n.id > ?2 ORDER BY n.id ASC LIMIT ?3`,
    ).bind(userId, afterId, NOTE_PAGE_SIZE).all<NoteRow>()
    if (!page.results.length) break

    const missingAttachmentIds = new Set<string>()
    for (const row of page.results) {
      for (const id of extractAttachmentIds(row.content)) {
        if (!attachmentsById.has(id)) missingAttachmentIds.add(id)
      }
    }
    await loadReferencedAttachments(env.DB, userId, missingAttachmentIds, attachmentsById)

    for (const row of page.results) {
      const note = toNote(row)
      const noteAttachmentIds = new Set(extractAttachmentIds(note.content))
      for (const id of noteAttachmentIds) {
        const attachment = attachmentsById.get(id)
        if (!attachment) {
          throw new Error(`A referenced attachment is missing from the database: ${id}`)
        }
        validateAttachmentRow(attachment)
        if (!selectedAttachmentsByHash.has(attachment.sha256)) {
          selectedAttachmentsByHash.set(attachment.sha256, attachment)
          attachmentPathByHash.set(
            attachment.sha256,
            backupAttachmentPath(attachment.sha256, safeSegment(attachment.filename)),
          )
        }
        attachmentPathById.set(id, attachmentPathByHash.get(attachment.sha256)!)
      }

      const state: MarkdownBackupNoteState = note.deletedAt
        ? 'trash'
        : note.isArchived ? 'archived' : 'notes'
      const folderInfo = note.folderId ? folderPaths.get(note.folderId) : undefined
      const folder = folderInfo?.path ?? ''
      const base = `${safeSegment(note.title || 'Untitled note')}--${note.id.slice(-8)}`
      let path = `${state}/${folder ? `${folder}/` : ''}${base}.md`
      let suffix = 2
      while (usedPaths.has(path.toLowerCase())) {
        path = `${state}/${folder ? `${folder}/` : ''}${base}-${suffix++}.md`
      }
      usedPaths.add(path.toLowerCase())

      const rendered = renderNoteBody(note.content, path, attachmentPathById, noteAttachmentIds)
      const bytes = encoder.encode(rendered)
      const sha256 = await sha256Hex(bytes)
      const attachmentHashes = [...new Set(
        [...noteAttachmentIds].map((id) => attachmentsById.get(id)!.sha256),
      )].sort()
      const entry: MarkdownBackupNoteEntry = {
        id: note.id,
        path,
        title: note.title,
        folder: folderInfo?.names ?? [],
        attachmentHashes,
        state,
        archived: note.isArchived,
        bytes: bytes.byteLength,
        sha256,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        deletedAt: note.deletedAt,
      }
      noteEntries.push(entry)
      noteFiles.push({
        path,
        byteLength: bytes.byteLength,
        sha256,
        contentType: 'text/markdown; charset=utf-8',
        kind: 'note',
        open: () => openPlannedNote(
          env,
          userId,
          row.id,
          row.rev,
          path,
          sha256,
          attachmentPathById,
          noteAttachmentIds,
        ),
      })
    }

    afterId = page.results.at(-1)!.id
    if (page.results.length < NOTE_PAGE_SIZE) break
  }

  const selectedAttachmentRows = [...selectedAttachmentsByHash.values()]
    .sort((a, b) => a.sha256.localeCompare(b.sha256))

  const attachmentEntries: MarkdownBackupAttachmentEntry[] = selectedAttachmentRows.map((row) => ({
    path: attachmentPathByHash.get(row.sha256)!,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    createdAt: row.created_at,
  }))
  const attachmentFiles: BackupFile[] = selectedAttachmentRows.map((row) => ({
    path: attachmentPathByHash.get(row.sha256)!,
    byteLength: row.size,
    sha256: row.sha256,
    contentType: row.mime,
    kind: 'attachment',
    open: () => openVerifiedAttachment(env, row),
  }))

  const readmeFile = await staticFile(
    'README.txt',
    readme(stamp, noteEntries, attachmentEntries.length),
    'text/plain; charset=utf-8',
    'readme',
  )
  const manifest: MarkdownBackupManifest = {
    format: MARKDOWN_BACKUP_FORMAT,
    version: MARKDOWN_BACKUP_VERSION,
    appVersion: APP_VERSION,
    createdAt: now.toISOString(),
    snapshot: stamp,
    notes: noteEntries,
    attachments: attachmentEntries,
  }
  if (!parseMarkdownBackupManifest(manifest)) {
    throw new Error('The backup contains metadata that cannot be restored safely')
  }
  const manifestFile = await staticFileAsync(
    backupManifestPath(stamp),
    encoder.encode(JSON.stringify(manifest, null, 2)),
    'application/json; charset=utf-8',
    'manifest',
  )
  if (manifestFile.byteLength > LIMITS.importUploadMaxBytes) {
    throw new Error(`The backup manifest exceeds ${formatBytes(LIMITS.importUploadMaxBytes)}`)
  }
  const completeFile = await staticFile(
    backupCompletePath(stamp),
    backupCompleteBody(manifestFile.sha256),
    'text/plain; charset=utf-8',
    'complete',
  )
  const payloadFiles = [...noteFiles, ...attachmentFiles, readmeFile]
  const allFiles = [...payloadFiles, manifestFile, completeFile]

  return {
    payloadFiles,
    manifestFile,
    completeFile,
    noteCount: noteEntries.length,
    attachmentCount: attachmentEntries.length,
    bytes: allFiles.reduce((sum, file) => sum + file.byteLength, 0),
    stamp,
    createdAt: now,
  }
}

async function loadReferencedAttachments(
  db: D1Database,
  userId: string,
  ids: ReadonlySet<string>,
  target: Map<string, AttachmentSnapshotRow>,
): Promise<void> {
  const values = [...ids]
  for (let offset = 0; offset < values.length; offset += ATTACHMENT_LOOKUP_BATCH) {
    const chunk = values.slice(offset, offset + ATTACHMENT_LOOKUP_BATCH)
    const { results } = await db.prepare(
      `SELECT id, user_id, filename, mime, size, sha256, storage, created_at
         FROM attachments
        WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`,
    ).bind(userId, JSON.stringify(chunk)).all<AttachmentSnapshotRow>()
    for (const row of results) target.set(row.id, row)
  }
}

export async function materializeSnapshot(snapshot: Snapshot): Promise<MaterializedBackupFile[]> {
  const files = [...snapshot.payloadFiles, snapshot.manifestFile, snapshot.completeFile]
  assertArchiveSizesCanBeRestored(files)
  const materialized: MaterializedBackupFile[] = []
  for (const file of files) {
    const body = await readBackupFile(file)
    if ((await sha256Hex(body)) !== file.sha256) {
      throw new Error(`Backup file changed while the archive was being created: ${file.path}`)
    }
    materialized.push({ path: file.path, body, contentType: file.contentType })
  }
  return materialized
}

async function readBackupFile(file: BackupFile): Promise<Uint8Array> {
  const reader = (await file.open()).getReader()
  const body = new Uint8Array(file.byteLength)
  let offset = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (offset + value.byteLength > body.byteLength) {
        throw new Error(`Backup source size changed: ${file.path}`)
      }
      body.set(value, offset)
      offset += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (offset !== body.byteLength) throw new Error(`Backup source size changed: ${file.path}`)
  return body
}

export async function buildJsonExport(env: Env, userId: string): Promise<Uint8Array> {
  const [folderRows, tagRows, userRows] = await env.DB.batch([
    env.DB.prepare(
      `SELECT f.id, f.parent_id, f.name, f.icon, f.color, f.position, f.created_at, f.updated_at
         FROM folders f WHERE f.user_id = ?1 AND f.deleted_at IS NULL ORDER BY f.position ASC`,
    ).bind(userId),
    env.DB.prepare(`SELECT t.id, t.name, t.color, t.created_at FROM tags t WHERE t.user_id = ?1`).bind(userId),
    env.DB.prepare(`SELECT login, name FROM users WHERE id = ?1`).bind(userId),
  ])
  const user = (userRows.results[0] as { login: string; name: string } | undefined) ?? null
  const metadata: Omit<ExportBundle, 'notes' | 'attachments'> = {
    format: 'inkstone-export',
    version: 1,
    exportedAt: Date.now(),
    user: { login: user?.login ?? 'unknown', name: user?.name ?? '' },
    folders: (folderRows as D1Result<FolderRow>).results.map(toFolder),
    tags: (tagRows as D1Result<TagRow>).results.map(toTag),
  }
  const chunks: Uint8Array[] = []
  let byteLength = 0
  const append = (value: string) => {
    const chunk = encoder.encode(value)
    byteLength += chunk.byteLength
    assertBundleByteLengthCanBeRestored(byteLength)
    chunks.push(chunk)
  }

  append(`${JSON.stringify(metadata).slice(0, -1)},"notes":[`)
  let afterId = ''
  let firstNote = true
  while (true) {
    const page = await env.DB.prepare(
      `SELECT ${NOTE_COLUMNS_FULL} FROM notes n
        WHERE n.user_id = ?1 AND n.id > ?2 ORDER BY n.id ASC LIMIT ?3`,
    ).bind(userId, afterId, NOTE_PAGE_SIZE).all<NoteRow>()
    if (!page.results.length) break

    for (const row of page.results) {
      append(`${firstNote ? '' : ','}${JSON.stringify(toNote(row))}`)
      firstNote = false
    }

    afterId = page.results.at(-1)!.id
    if (page.results.length < NOTE_PAGE_SIZE) break
  }
  append('],"attachments":[]}')

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  assertBundleCanBeRestored(bytes)
  return bytes
}

export function assertArchiveCanBeRestored(files: readonly MaterializedBackupFile[]): void {
  assertArchiveSizesCanBeRestored(
    files.map((file) => ({ path: file.path, byteLength: file.body.byteLength })),
  )
}

function assertArchiveSizesCanBeRestored(
  files: readonly { path: string; byteLength: number }[],
): void {
  if (files.length > LIMITS.importArchiveEntriesMax) {
    throw ApiError.tooLarge(
      `The complete backup contains ${files.length} files, exceeding the restore limit of ${LIMITS.importArchiveEntriesMax}`,
    )
  }
  const expandedBytes = files.reduce((sum, file) => sum + file.byteLength, 0)
  if (!Number.isSafeInteger(expandedBytes) || expandedBytes > LIMITS.importArchiveExpandedMaxBytes) {
    throw ApiError.tooLarge(
      `Use folder restore when a backup exceeds ${formatBytes(LIMITS.importArchiveExpandedMaxBytes)}`,
    )
  }
  if (estimateZipSizeFromSizes(files) > LIMITS.importUploadMaxBytes) {
    throw ApiError.tooLarge(
      `Use folder restore when a backup exceeds ${formatBytes(LIMITS.importUploadMaxBytes)}`,
    )
  }
}

export function assertBundleCanBeRestored(bundle: Uint8Array): void {
  assertBundleByteLengthCanBeRestored(bundle.byteLength)
}

function assertBundleByteLengthCanBeRestored(byteLength: number): void {
  if (byteLength > LIMITS.importBundleMaxBytes) {
    throw ApiError.tooLarge(
      `The JSON export exceeds ${formatBytes(LIMITS.importBundleMaxBytes)} restore limit`,
    )
  }
}

function renderNoteBody(
  content: string,
  notePath: string,
  attachmentPaths: ReadonlyMap<string, string>,
  referencedIds: ReadonlySet<string>,
): string {
  return content.replace(ATTACHMENT_REFERENCE_RE, (match, id: string) => {
    if (!referencedIds.has(id)) return match
    const attachmentPath = attachmentPaths.get(id)
    return attachmentPath ? relativeBackupUrl(notePath, attachmentPath) : match
  })
}

async function openPlannedNote(
  env: Env,
  userId: string,
  noteId: string,
  expectedRev: number,
  notePath: string,
  expectedSha256: string,
  attachmentPaths: ReadonlyMap<string, string>,
  referencedIds: ReadonlySet<string>,
): Promise<ReadableStream<Uint8Array>> {
  const row = await env.DB.prepare(
    `SELECT ${NOTE_COLUMNS_FULL} FROM notes n
      WHERE n.user_id = ?1 AND n.id = ?2 AND n.rev = ?3`,
  ).bind(userId, noteId, expectedRev).first<NoteRow>()
  if (!row) throw new Error(`A note changed while the backup was running: ${noteId}`)
  const bytes = encoder.encode(renderNoteBody(row.content, notePath, attachmentPaths, referencedIds))
  if ((await sha256Hex(bytes)) !== expectedSha256) {
    throw new Error(`A note changed while the backup was running: ${row.title}`)
  }
  return streamBytes(bytes)
}

async function openVerifiedAttachment(
  env: Env,
  row: AttachmentSnapshotRow,
): Promise<ReadableStream<Uint8Array>> {
  if (!isAttachmentObjectStorage(row.storage) || !hasAttachmentStorage(env, row.storage)) {
    throw new Error(`Attachment storage is unavailable: ${row.filename}`)
  }
  const object = await readAttachmentObjectStream(env, row.storage, attachmentObjectKey(row))
  if (!object) throw new Error(`Attachment data is missing: ${row.filename}`)
  if (object.size !== null && object.size !== row.size) {
    await object.body.cancel().catch(() => {})
    throw new Error(`Attachment checksum does not match: ${row.filename}`)
  }
  if (object.metadata?.sha256 && object.metadata.sha256 !== row.sha256) {
    await object.body.cancel().catch(() => {})
    throw new Error(`Attachment checksum metadata does not match: ${row.filename}`)
  }
  if (object.metadata?.mime && object.metadata.mime !== row.mime) {
    await object.body.cancel().catch(() => {})
    throw new Error(`Attachment type metadata does not match: ${row.filename}`)
  }
  return verifyAttachmentStream(object.body, row)
}

function verifyAttachmentStream(
  source: ReadableStream<Uint8Array>,
  row: AttachmentSnapshotRow,
): ReadableStream<Uint8Array> {
  const digest = new crypto.DigestStream('SHA-256')
  const digestWriter = digest.getWriter()
  const prefixLimit = 64 * 1024
  let prefix = new Uint8Array(0)
  let bytes = 0

  const fail = async (message: string): Promise<never> => {
    await digestWriter.abort(message).catch(() => {})
    throw new Error(message)
  }

  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      bytes += chunk.byteLength
      if (bytes > row.size) await fail(`Attachment size does not match: ${row.filename}`)
      if (prefix.byteLength < prefixLimit) {
        const take = Math.min(prefixLimit - prefix.byteLength, chunk.byteLength)
        const next = new Uint8Array(prefix.byteLength + take)
        next.set(prefix)
        next.set(chunk.subarray(0, take), prefix.byteLength)
        prefix = next
      }
      await digestWriter.write(chunk)
      controller.enqueue(chunk)
    },
    async flush() {
      if (bytes !== row.size) await fail(`Attachment size does not match: ${row.filename}`)
      if (safeAttachmentMime(prefix, row.mime) !== row.mime) {
        await fail(`Attachment type metadata does not match: ${row.filename}`)
      }
      await digestWriter.close()
      const actual = bytesToHex(new Uint8Array(await digest.digest))
      if (actual !== row.sha256) {
        throw new Error(`Attachment checksum does not match: ${row.filename}`)
      }
    },
  }))
}

function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function validateAttachmentRow(row: AttachmentSnapshotRow): void {
  if (!/^[0-9a-hjkmnp-tv-z]{26}$/.test(row.id)) throw new Error('Attachment metadata contains an invalid ID')
  if (!row.filename || row.filename.length > 180) throw new Error(`Invalid attachment filename: ${row.id}`)
  if (!Number.isSafeInteger(row.size) || row.size < 0 || row.size > LIMITS.attachmentMaxBytes) {
    throw new Error(`Invalid attachment size: ${row.filename}`)
  }
  if (!/^[0-9a-f]{64}$/.test(row.sha256)) throw new Error(`Invalid attachment checksum: ${row.filename}`)
  if (!isAttachmentObjectStorage(row.storage)) throw new Error(`Invalid attachment storage type: ${row.filename}`)
}

async function staticFile(
  path: string,
  text: string,
  contentType: string,
  kind: BackupFileKind,
): Promise<BackupFile> {
  const bytes = encoder.encode(text)
  return staticFileAsync(path, bytes, contentType, kind)
}

async function staticFileAsync(
  path: string,
  bytes: Uint8Array,
  contentType: string,
  kind: BackupFileKind,
): Promise<BackupFile> {
  const sha256 = await sha256Hex(bytes)
  return {
    path,
    byteLength: bytes.byteLength,
    sha256,
    contentType,
    kind,
    open: async () => streamBytes(bytes),
  }
}

interface BackupFolderPath {
  path: string
  names: string[]
}

function buildFolderPaths(folders: { id: string; parentId: string | null; name: string }[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const cache = new Map<string, BackupFolderPath>()
  const resolve = (id: string, visiting = new Set<string>()): BackupFolderPath => {
    if (cache.has(id)) return cache.get(id)!
    const folder = byId.get(id)
    if (!folder || visiting.has(id) || visiting.size >= LIMITS.folderDepthMax) {
      return { path: '', names: [] }
    }
    const next = new Set(visiting).add(id)
    const parent = folder.parentId
      ? resolve(folder.parentId, next)
      : { path: '', names: [] }
    const segment = safeSegment(folder.name)
    const value = {
      path: parent.path ? `${parent.path}/${segment}` : segment,
      names: [...parent.names, folder.name],
    }
    cache.set(id, value)
    return value
  }
  for (const folder of folders) resolve(folder.id)
  return cache
}

export function safeSegment(name: string): string {
  const normalized = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  const cleaned = truncateText(normalized, 80).replace(/[\s.]+$/g, '')
  if (!cleaned) return 'Untitled'
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)
    ? `_${cleaned}`
    : cleaned
}

function relativeBackupUrl(fromFile: string, toFile: string): string {
  const from = fromFile.split('/').slice(0, -1)
  const to = toFile.split('/')
  let common = 0
  while (common < from.length && common < to.length && from[common] === to[common]) common++
  const parts = [
    ...Array.from({ length: from.length - common }, () => '..'),
    ...to.slice(common),
  ]
  return parts.map((part) => part === '..' ? part : encodeURIComponent(part)).join('/')
}

export function formatStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}-${ms}`
}

function readme(
  stamp: string,
  notes: readonly MarkdownBackupNoteEntry[],
  attachments: number,
): string {
  const active = notes.filter((note) => note.state === 'notes').length
  const archived = notes.filter((note) => note.state === 'archived').length
  const trash = notes.filter((note) => note.state === 'trash').length
  return `Inkstone Markdown backup\n\nSnapshot (UTC): ${stamp}\nTotal notes: ${notes.length}\nActive: ${active}\nArchived: ${archived}\nTrash: ${trash}\nAttachments: ${attachments}\n\nnotes/ contains ordinary notes in their folder hierarchy.\narchived/ contains archived notes in their folder hierarchy.\ntrash/ contains trashed notes in their folder hierarchy.\nattachments/ contains referenced files in their original bytes; the checksum in each filename prevents collisions.\nmanifest.json records note state, timestamps, paths, and checksums.\n\nRestore this ZIP directly in Inkstone. For a backup larger than the browser upload limit, extract it and select the extracted folder instead.\nA backup is valid only when its COMPLETE file is present and matches manifest.json.\n`
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.ceil(bytes / (1024 * 1024))} MB`
    : `${Math.ceil(bytes / 1024)} KB`
}
