import { Hono, type Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { MOMENTS_FOLDER_NAME } from '@shared/blog/tags'
import { LIMITS } from '@shared/constants'
import { extractAttachmentIds } from '@shared/markdown-utils'
import type { Attachment } from '@shared/types'
import {
  hasAttachmentStorage,
  readAttachmentObjectStream,
} from '../attachments/backend'
import { drainAttachmentCleanup } from '../attachments/cleanup'
import { collectAttachmentReferences } from '../attachments/references'
import {
  attachmentCleanupTarget,
  attachmentObjectKey,
  type AttachmentObjectStorage,
} from '../attachments/keys'
import { persistAttachmentWithinQuota } from '../attachments/storage'
import { BLOG_SESSION_COOKIE, getBlogPrivateTag, validateBlogSession } from '../blog/auth'
import { checkBlogFileAccess } from '../blog/queries'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, isValidSlug, newId } from '../lib/id'
import { isInlineSafe } from '../lib/image'
import { FORM_BODY_LIMITS, readFormDataWithinLimit } from '../lib/request'
import { consumeAttemptBudget, ThrottleError } from '../lib/throttle'
import { shareAssetCookieName, verifyShareAssetSession } from '../lib/share-asset-session'
import { requireAuth } from '../middleware/auth'

export const filesRoutes = new Hono<AppBindings>()

interface AttachmentRow {
  id: string
  user_id: string
  note_id: string | null
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  storage: AttachmentObjectStorage
  created_at: number
}

const ATTACHMENT_LIST_PAGE_SIZE = 500
const ATTACHMENT_SCAN_PAGE_SIZE = 100

function encodeContentDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function parseAttachmentListCursor(value: string | undefined): { createdAt: number; id: string } | null {
  if (!value) return null
  const match = /^(\d{1,16})\.([0-9a-hjkmnp-tv-z]{26})$/.exec(value)
  const createdAt = Number(match?.[1])
  if (!match || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw ApiError.badRequest('Invalid attachment cursor')
  }
  return { createdAt, id: match[2]! }
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    noteId: row.note_id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    url: `/api/files/${row.id}`,
    createdAt: row.created_at,
  }
}

async function collectAttachmentIdsThroughBoundary(
  db: D1Database,
  userId: string,
  boundary: { created_at: number; id: string },
): Promise<Set<string>> {
  const ids = new Set<string>()
  let cursor: { createdAt: number; id: string } | null = null
  while (true) {
    const query: D1PreparedStatement = cursor
      ? db.prepare(
          `SELECT created_at, id FROM attachments WHERE user_id = ?1
            AND (created_at < ?2 OR (created_at = ?2 AND id <= ?3))
            AND (created_at > ?4 OR (created_at = ?4 AND id > ?5))
           ORDER BY created_at ASC, id ASC LIMIT ?6`,
        ).bind(
          userId,
          boundary.created_at,
          boundary.id,
          cursor.createdAt,
          cursor.id,
          ATTACHMENT_SCAN_PAGE_SIZE,
        )
      : db.prepare(
          `SELECT created_at, id FROM attachments WHERE user_id = ?1
            AND (created_at < ?2 OR (created_at = ?2 AND id <= ?3))
           ORDER BY created_at ASC, id ASC LIMIT ?4`,
        ).bind(userId, boundary.created_at, boundary.id, ATTACHMENT_SCAN_PAGE_SIZE)
    const rows: Array<{ created_at: number; id: string }> = (await query.all<{
      created_at: number
      id: string
    }>()).results
    if (!rows.length) break
    for (const row of rows) ids.add(row.id)
    const last = rows[rows.length - 1]!
    cursor = { createdAt: last.created_at, id: last.id }
    if (rows.length < ATTACHMENT_SCAN_PAGE_SIZE) break
  }
  return ids
}


filesRoutes.post('/', requireAuth, async (c) => {
  const userId = c.get('userId')
  try {
    await consumeAttemptBudget(c.env.DB, [{
      key: `attachment-upload:${userId}`,
      maxAttempts: LIMITS.attachmentUploadsPerHour,
      windowMs: 60 * 60 * 1000,
      lockMs: 60 * 60 * 1000,
    }])
  } catch (error) {
    if (error instanceof ThrottleError) {
      throw new ApiError(
        429,
        'too_many_attempts',
        `Too many uploads. Try again in ${error.retryAfterSec} seconds`,
        { retryAfter: error.retryAfterSec },
      )
    }
    throw error
  }

  const form = await readFormDataWithinLimit(c.req, FORM_BODY_LIMITS.attachment)

  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('Missing file field')

  if (file.size > LIMITS.attachmentMaxBytes) {
    throw ApiError.tooLarge('The file exceeds the 25 MB limit')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const id = newId()
  const rawNoteId = form.get('noteId')
  const noteId = typeof rawNoteId === 'string' && rawNoteId ? rawNoteId.slice(0, 128) : null
  if (noteId) {
    const owned = await c.env.DB.prepare(
      `SELECT id FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
    )
      .bind(noteId, userId)
      .first<{ id: string }>()
    if (!owned) throw ApiError.badRequest('The associated note does not exist')
  }
  const now = Date.now()
  const stored = await persistAttachmentWithinQuota(c.env, {
    id,
    userId,
    noteId,
    filename: file.name || 'file',
    reportedMime: file.type,
    bytes,
    createdAt: now,
  })

  const attachment: Attachment = {
    id,
    noteId,
    filename: stored.filename,
    mime: stored.mime,
    size: bytes.byteLength,
    width: stored.width,
    height: stored.height,
    url: `/api/files/${id}`,
    createdAt: now,
  }
  return c.json(attachment, 201)
})


async function blogFileAccess(c: Context<AppBindings>, userId: string): Promise<boolean> {
  const token = getCookie(c, BLOG_SESSION_COOKIE(userId))
  return Boolean(token && (await validateBlogSession(c.env.DB, userId, token)))
}

filesRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Attachment not found')
  const shareSlug = c.req.query('share')

  const row = await c.env.DB.prepare(
    `SELECT id, user_id, note_id, filename, mime, size, width, height, storage, created_at
       FROM attachments WHERE id = ?1`,
  )
    .bind(id)
    .first<AttachmentRow>()
  if (!row) throw ApiError.notFound('Attachment not found')

  const userId = c.get('userId')
  let allowed = Boolean(userId && userId === row.user_id)
  if (!allowed && isValidSlug(shareSlug)) {
    const privateTag = await getBlogPrivateTag(c.env.DB, row.user_id)
    const share = await c.env.DB.prepare(
      `SELECT s.slug, s.password_hash,
              (EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
                        WHERE nt.note_id = s.note_id AND t.user_id = s.user_id AND t.name = ?4)
                OR EXISTS (SELECT 1 FROM folders f WHERE f.id = n.folder_id
                            AND f.name = ?5 AND f.parent_id IS NULL AND f.deleted_at IS NULL)) AS blog_private,
              s.user_id, n.content
         FROM shares s
          JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
         WHERE s.slug = ?1 AND s.user_id = ?2 AND n.deleted_at IS NULL
           AND (s.expires_at IS NULL OR s.expires_at > ?3)`,
    )
      .bind(shareSlug, row.user_id, Date.now(), privateTag, MOMENTS_FOLDER_NAME)
      .first<{
        slug: string
        password_hash: string | null
        blog_private: number
        user_id: string
        content: string
      }>()
    allowed = Boolean(
      share &&
        extractAttachmentIds(share.content).includes(row.id) &&
        ((!share.password_hash ||
          (await verifyShareAssetSession(
            c.env.DB,
            getCookie(c, shareAssetCookieName(shareSlug)),
            share.slug,
            share.password_hash,
          ))) ||
          (share.blog_private === 1 && (await blogFileAccess(c, share.user_id)))),
    )
    if (!share) {
      // New-style blog slug (blog_posts.slug, no shares row): public posts
      // are free, private posts need a blog session.
      const blog = await checkBlogFileAccess(
        c.env.DB,
        shareSlug,
        row.id,
        await blogFileAccess(c, row.user_id),
      )
      allowed = blog.allowed
    }
  }
  if (!allowed) throw ApiError.unauthenticated('You do not have access to this attachment')

  const headers = new Headers({
    'Content-Type': row.mime,
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `${isInlineSafe(row.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeContentDispositionFilename(row.filename)}`,
    'X-Content-Type-Options': 'nosniff',
  })

  if (!hasAttachmentStorage(c.env, row.storage)) {
    throw new ApiError(
      503,
      'storage_unavailable',
      `${row.storage === 'r2' ? 'R2' : 'Workers KV'} attachment storage is not bound, so the attachment cannot be read`,
    )
  }
  const object = await readAttachmentObjectStream(c.env, row.storage, attachmentObjectKey(row))
  if (!object) throw ApiError.notFound('Attachment data is missing')
  return new Response(object.body as BodyInit, { headers })
})


filesRoutes.get('/', requireAuth, async (c) => {
  const userId = c.get('userId')
  const cursor = parseAttachmentListCursor(c.req.query('cursor'))
  const statement = cursor
    ? c.env.DB.prepare(
        `SELECT id, user_id, note_id, filename, mime, size, width, height, storage, created_at
           FROM attachments WHERE user_id = ?1
            AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
          ORDER BY created_at DESC, id DESC LIMIT ?4`,
      ).bind(userId, cursor.createdAt, cursor.id, ATTACHMENT_LIST_PAGE_SIZE + 1)
    : c.env.DB.prepare(
        `SELECT id, user_id, note_id, filename, mime, size, width, height, storage, created_at
           FROM attachments WHERE user_id = ?1
          ORDER BY created_at DESC, id DESC LIMIT ?2`,
      ).bind(userId, ATTACHMENT_LIST_PAGE_SIZE + 1)
  const { results } = await statement.all<AttachmentRow>()
  const page = results.slice(0, ATTACHMENT_LIST_PAGE_SIZE)
  const hasMore = results.length > ATTACHMENT_LIST_PAGE_SIZE
  const references = await collectAttachmentReferences(
    c.env.DB,
    userId,
    new Set(page.map((row) => row.id)),
  )
  return c.json({
    files: page.map((row) => ({
      ...toAttachment(row),
      references: references.get(row.id) ?? 0,
    })),
    nextCursor: hasMore
      ? `${page[page.length - 1]!.created_at}.${page[page.length - 1]!.id}`
      : null,
  })
})

filesRoutes.delete('/:id', requireAuth, async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const row = await c.env.DB.prepare(
    `SELECT id, user_id, filename, mime, storage FROM attachments WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(id, userId)
    .first<AttachmentRow>()
  if (!row) throw ApiError.notFound('Attachment not found')

  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
       SELECT ?1, user_id, ?2 FROM attachments WHERE id = ?3 AND user_id = ?4`,
    ).bind(
      attachmentCleanupTarget(row.storage, attachmentObjectKey(row)),
      Date.now(),
      id,
      userId,
    ),
  ]
  statements.push(
    c.env.DB.prepare(
      `DELETE FROM import_mappings
        WHERE user_id = ?1 AND entity = 'attachment' AND target_id = ?2`,
    ).bind(userId, id),
  )
  statements.push(
    c.env.DB.prepare(`DELETE FROM attachments WHERE id = ?1 AND user_id = ?2`).bind(id, userId),
  )
  const results = await c.env.DB.batch(statements)
  if (!results.at(-1)?.meta.changes) throw ApiError.notFound('Attachment not found')

  const cleanup = await drainAttachmentCleanup(c.env, userId).catch((error) => {
    console.warn('[inkstone] Attachment deletion will retry later:', error)
    return { processed: 0, pending: true }
  })
  return c.json({ ok: true, cleanupPending: cleanup.pending })
})

filesRoutes.post('/prune', requireAuth, async (c) => {
  const userId = c.get('userId')

  const [boundaryResult, cursorResult] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT created_at, id FROM attachments
        WHERE user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).bind(userId),
    c.env.DB.prepare(
      `SELECT seq FROM changes WHERE user_id = ?1 AND entity = 'note'
        ORDER BY seq DESC LIMIT 1`,
    ).bind(userId),
  ])
  const boundary = (boundaryResult as D1Result<{ created_at: number; id: string }>).results[0]
  if (!boundary) return c.json({ removed: 0, freedBytes: 0 })
  const scanCursor = (cursorResult as D1Result<{ seq: number }>).results[0]?.seq ?? 0
  const attachmentIds = await collectAttachmentIdsThroughBoundary(c.env.DB, userId, boundary)
  const referenced = await collectAttachmentReferences(c.env.DB, userId, attachmentIds)

  let removed = 0
  let freedBytes = 0
  let statements: D1PreparedStatement[] = []
  const operations: Array<
    { kind: 'queue' | 'mapping' } | { kind: 'delete'; file: AttachmentRow }
  > = []

  const flush = async () => {
    if (!statements.length) return
    const results = await c.env.DB.batch(statements)
    results.forEach((result, index) => {
      const operation = operations[index]
      if (operation?.kind === 'delete' && result.meta.changes) {
        removed += 1
        freedBytes += operation.file.size
      }
    })
    statements = []
    operations.length = 0
  }

  let pageCursor: { createdAt: number; id: string } | null = null
  while (true) {
    const query: D1PreparedStatement = pageCursor
      ? c.env.DB.prepare(
          `SELECT id, user_id, note_id, filename, mime, size, width, height, storage, created_at
             FROM attachments WHERE user_id = ?1
              AND (created_at < ?2 OR (created_at = ?2 AND id <= ?3))
              AND (created_at > ?4 OR (created_at = ?4 AND id > ?5))
            ORDER BY created_at ASC, id ASC LIMIT ?6`,
        ).bind(
          userId,
          boundary.created_at,
          boundary.id,
          pageCursor.createdAt,
          pageCursor.id,
          ATTACHMENT_SCAN_PAGE_SIZE,
        )
      : c.env.DB.prepare(
          `SELECT id, user_id, note_id, filename, mime, size, width, height, storage, created_at
             FROM attachments WHERE user_id = ?1
              AND (created_at < ?2 OR (created_at = ?2 AND id <= ?3))
            ORDER BY created_at ASC, id ASC LIMIT ?4`,
        ).bind(userId, boundary.created_at, boundary.id, ATTACHMENT_SCAN_PAGE_SIZE)
    const files: AttachmentRow[] = (await query.all<AttachmentRow>()).results
    if (!files.length) break

    for (const file of files) {
      if (referenced.has(file.id)) continue
      const guard = `id = ?1 AND user_id = ?2 AND NOT EXISTS (
        SELECT 1 FROM changes c
         WHERE c.user_id = ?2 AND c.entity = 'note' AND c.seq > ?3
      )`
      const needed = 3
      if (statements.length + needed > 100) await flush()
      statements.push(
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
           SELECT ?4, user_id, ?5 FROM attachments WHERE ${guard}`,
        ).bind(
          file.id,
          userId,
          scanCursor,
          attachmentCleanupTarget(file.storage, attachmentObjectKey(file)),
          Date.now(),
        ),
      )
      operations.push({ kind: 'queue' })
      statements.push(
        c.env.DB.prepare(
          `DELETE FROM import_mappings
            WHERE user_id = ?1 AND entity = 'attachment' AND target_id = ?2
              AND EXISTS (
                SELECT 1 FROM attachments a
                 WHERE a.id = ?2 AND a.user_id = ?1 AND NOT EXISTS (
                   SELECT 1 FROM changes c
                    WHERE c.user_id = ?1 AND c.entity = 'note' AND c.seq > ?3
                 )
              )`,
        ).bind(userId, file.id, scanCursor),
      )
      operations.push({ kind: 'mapping' })
      statements.push(
        c.env.DB.prepare(`DELETE FROM attachments WHERE ${guard}`).bind(file.id, userId, scanCursor),
      )
      operations.push({ kind: 'delete', file })
    }
    const last: AttachmentRow = files[files.length - 1]!
    pageCursor = { createdAt: last.created_at, id: last.id }
    if (files.length < ATTACHMENT_SCAN_PAGE_SIZE) break
  }
  await flush()

  const cleanup = await drainAttachmentCleanup(c.env, userId).catch((error) => {
    console.warn('[inkstone] Attachment cleanup will retry later:', error)
    return { processed: 0, pending: true }
  })
  return c.json({ removed, freedBytes, cleanupPending: cleanup.pending })
})
