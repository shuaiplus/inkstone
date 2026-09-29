import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import type { SyncDeletion, SyncResponse } from '@shared/types'
import type { AppBindings } from '../env'
import { NOTE_COLUMNS, toFolder, toNoteSummary, toTag, type FolderRow, type NoteRow, type TagRow } from '../db/rows'
import { ApiError } from '../lib/errors'
import { clampInt } from '../lib/request'
import { requireAuth } from '../middleware/auth'

export const syncRoutes = new Hono<AppBindings>()

export const CHANGE_BOUNDS_SQL = `SELECT
  (SELECT seq FROM changes WHERE user_id = ?1 ORDER BY seq ASC LIMIT 1) AS lo,
  (SELECT seq FROM changes WHERE user_id = ?1 ORDER BY seq DESC LIMIT 1) AS hi`

const FOLDER_SELECT = `f.id, f.parent_id, f.name, f.icon, f.color, f.position, f.created_at, f.updated_at`

const TAG_SELECT = `t.id, t.name, t.color, t.created_at,
  (SELECT COUNT(*) FROM note_tags nt JOIN notes n ON n.id = nt.note_id
    WHERE nt.tag_id = t.id AND n.user_id = t.user_id
      AND n.deleted_at IS NULL AND n.is_archived = 0) AS note_count`


syncRoutes.get('/', requireAuth, async (c) => {
  const userId = c.get('userId')
  const since = clampInt(c.req.query('since'), 0, Number.MAX_SAFE_INTEGER, 0)
  const after = (c.req.query('after') ?? '').slice(0, 128)

  const bounds = await c.env.DB.prepare(CHANGE_BOUNDS_SQL)
    .bind(userId)
    .first<{ lo: number | null; hi: number | null }>()

  const lo = bounds?.lo ?? 0
  const hi = bounds?.hi ?? 0


  const needFull = since <= 0 || (lo > 0 && since < lo - 1)
  // A non-empty `after` key always means the caller is mid-way through a
  // full snapshot page chain; keep serving snapshot pages regardless of
  // `since`, so following the returned nextKey can never silently drop
  // remaining pages.
  if (needFull || after) {
    const requestedSnapshot = clampInt(
      c.req.query('snapshot'),
      0,
      Number.MAX_SAFE_INTEGER,
      hi,
    )
    const snapshotCursor = after ? Math.min(requestedSnapshot, hi) : hi
    return c.json(await fullSnapshot(c.env.DB, userId, snapshotCursor, after))
  }

  if (since >= hi) {
    const body: SyncResponse = {
      // Never move the client's cursor backwards, even if it reported a
      // seq ahead of the server (e.g. data was trimmed).
      cursor: Math.max(since, hi),
      full: false,
      hasMore: false,
      nextKey: null,
      facetsFull: false,
      settingsChanged: false,
      profileChanged: false,
      siteChanged: false,
      notes: [],
      folders: [],
      tags: [],
      deletions: [],
      serverTime: Date.now(),
    }
    return c.json(body)
  }

  const { results: changes } = await c.env.DB.prepare(
    `SELECT seq, entity, entity_id, op FROM changes
      WHERE user_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3`,
  )
    .bind(userId, since, LIMITS.syncBatchSize)
    .all<{ seq: number; entity: string; entity_id: string; op: string }>()

  const cursor = changes.length ? changes[changes.length - 1]!.seq : since
  const hasMore = changes.length === LIMITS.syncBatchSize && cursor < hi


  const latest = new Map<string, { entity: string; id: string; op: string }>()
  for (const ch of changes) {
    latest.set(`${ch.entity}:${ch.entity_id}`, { entity: ch.entity, id: ch.entity_id, op: ch.op })
  }

  const noteIds: string[] = []
  const folderIds: string[] = []
  const tagIds: string[] = []
  const deletions: SyncDeletion[] = []

  for (const item of latest.values()) {
    if (item.op === 'delete') {
      if (item.entity === 'note' || item.entity === 'folder' || item.entity === 'tag') {
        deletions.push({ entity: item.entity, id: item.id })
      }
      continue
    }
    if (item.entity === 'note') noteIds.push(item.id)
    else if (item.entity === 'folder') folderIds.push(item.id)
    else if (item.entity === 'tag') tagIds.push(item.id)
  }
  const facetsFull = [...latest.values()].some((item) => item.entity === 'note')
  const settingsChanged = [...latest.values()].some((item) => item.entity === 'settings')
  const profileChanged = [...latest.values()].some((item) => item.entity === 'profile')
  const siteChanged = [...latest.values()].some((item) => item.entity === 'site')

  const notes = await loadInChunks(noteIds, (ids) =>
    c.env.DB.prepare(
      `SELECT ${NOTE_COLUMNS} FROM notes n
        WHERE n.user_id = ?1 AND n.id IN (${placeholders(ids.length, 2)})`,
    )
      .bind(userId, ...ids)
      .all<NoteRow>(),
  )

  const folders = facetsFull
    ? (
        await c.env.DB.prepare(
          `SELECT ${FOLDER_SELECT} FROM folders f
            WHERE f.user_id = ?1 AND f.deleted_at IS NULL
            ORDER BY f.position ASC, f.created_at ASC, f.id ASC`,
        )
          .bind(userId)
          .all<FolderRow>()
      ).results
    : await loadInChunks(folderIds, (ids) =>
        c.env.DB.prepare(
          `SELECT ${FOLDER_SELECT} FROM folders f
            WHERE f.user_id = ?1 AND f.deleted_at IS NULL
              AND f.id IN (${placeholders(ids.length, 2)})`,
        )
          .bind(userId, ...ids)
          .all<FolderRow>(),
      )

  const tags = facetsFull
    ? (
        await c.env.DB.prepare(
          `SELECT ${TAG_SELECT} FROM tags t
           WHERE t.user_id = ?1 ORDER BY t.name COLLATE NOCASE`,
        )
          .bind(userId)
          .all<TagRow>()
      ).results
    : await loadInChunks(tagIds, (ids) =>
        c.env.DB.prepare(
          `SELECT ${TAG_SELECT} FROM tags t
           WHERE t.user_id = ?1 AND t.id IN (${placeholders(ids.length, 2)})`,
        )
          .bind(userId, ...ids)
          .all<TagRow>(),
      )

  const gotNotes = new Set(notes.map((n) => n.id))
  for (const id of noteIds) if (!gotNotes.has(id)) deletions.push({ entity: 'note', id })
  const gotFolders = new Set(folders.map((f) => f.id))
  for (const id of folderIds) if (!gotFolders.has(id)) deletions.push({ entity: 'folder', id })
  const gotTags = new Set(tags.map((t) => t.id))
  for (const id of tagIds) if (!gotTags.has(id)) deletions.push({ entity: 'tag', id })

  const body: SyncResponse = {
    cursor,
    full: false,
    hasMore,
    nextKey: null,
    facetsFull,
    settingsChanged,
    profileChanged,
    siteChanged,
    notes: notes.map(toNoteSummary),
    folders: folders.map(toFolder),
    tags: tags.map(toTag),
    deletions,
    serverTime: Date.now(),
  }
  return c.json(body)
})


syncRoutes.get('/ws', requireAuth, async (c) => {
  if (!c.env.SYNC_HUB) {
    throw new ApiError(503, 'storage_unavailable', 'The realtime channel is disabled; polling will be used')
  }
  const origin = c.req.header('Origin')
  if (origin && origin !== new URL(c.req.url).origin) {
    throw ApiError.forbidden('The realtime connection origin is not trusted')
  }
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    throw ApiError.badRequest('This endpoint accepts only WebSocket upgrade requests')
  }

  const userId = c.get('userId')
  const stub = c.env.SYNC_HUB.get(c.env.SYNC_HUB.idFromName(userId))
  return stub.fetch(
    new Request('https://sync-hub.internal/connect', {
      headers: c.req.raw.headers,
    }),
  )
})


async function fullSnapshot(
  db: D1Database,
  userId: string,
  cursor: number,
  after: string,
): Promise<SyncResponse> {
  const [notes, folders, tags] = await Promise.all([
    db
      .prepare(
        `SELECT ${NOTE_COLUMNS} FROM notes n WHERE n.user_id = ?1
          AND n.id > ?2 ORDER BY n.id ASC LIMIT ?3`,
      )
      .bind(userId, after, LIMITS.syncBatchSize + 1)
      .all<NoteRow>(),
    !after
      ? db
          .prepare(
            `SELECT ${FOLDER_SELECT} FROM folders f WHERE f.user_id = ?1 AND f.deleted_at IS NULL
              ORDER BY f.position ASC`,
          )
          .bind(userId)
          .all<FolderRow>()
      : Promise.resolve({ results: [] as FolderRow[] }),
    !after
      ? db
          .prepare(
            `SELECT ${TAG_SELECT} FROM tags t
             WHERE t.user_id = ?1 ORDER BY t.name COLLATE NOCASE`,
          )
          .bind(userId)
          .all<TagRow>()
      : Promise.resolve({ results: [] as TagRow[] }),
  ])
  const pageNotes = notes.results.slice(0, LIMITS.syncBatchSize)
  const hasMore = notes.results.length > LIMITS.syncBatchSize

  return {
    cursor,
    full: true,
    hasMore,
    nextKey: hasMore ? pageNotes[pageNotes.length - 1]!.id : null,
    facetsFull: true,
    settingsChanged: true,
    profileChanged: true,
    siteChanged: true,
    notes: pageNotes.map(toNoteSummary),
    folders: folders.results.map(toFolder),
    tags: tags.results.map(toTag),
    deletions: [],
    serverTime: Date.now(),
  }
}

function placeholders(count: number, start: number): string {
  return Array.from({ length: count }, (_, i) => `?${start + i}`).join(', ')
}

async function loadInChunks<T>(
  ids: string[],
  load: (chunk: string[]) => Promise<{ results: T[] }>,
): Promise<T[]> {
  if (!ids.length) return []
  const chunks: string[][] = []
  for (let index = 0; index < ids.length; index += 80) {
    chunks.push(ids.slice(index, index + 80))
  }
  const pages = await Promise.all(chunks.map(load))
  return pages.flatMap((page) => page.results)
}
