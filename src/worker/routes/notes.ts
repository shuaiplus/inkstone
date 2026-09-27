import { Hono } from 'hono'
import { blogTierOfTags } from '@shared/blog/tags'
import { LIMITS } from '@shared/constants'
import { countText, deriveExcerpt, extractTags, normalizeLinkKey, replaceWikiLinkTarget } from '@shared/markdown-utils'
import { duplicateNoteTitle, sliceText, truncateText, utf8ByteLength } from '@shared/text-utils'
import type {
  CreateNoteBody,
  ListNotesResponse,
  Note,
  PatchNoteBody,
  SortKey,
  SortOrder,
  ViewKind,
} from '@shared/types'
import { syncBlogShare, withdrawBlogShare } from '../blog/publish'
import type { AppBindings } from '../env'
import { NOTE_COLUMNS, NOTE_COLUMNS_FULL, splitTags, toNote, toNoteSummary, type NoteRow } from '../db/rows'
import {
  buildNoteDerivedStatements,
  changeStatement,
  FTS_QUEUE_CONFLICT_SQL,
  LINK_TARGET_SUBQUERY,
  pruneOrphanTags,
} from '../db/writes'
import { fromBase64Url, fromUtf8, sha256Hex, toBase64Url, utf8 } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { broadcastCursor, scheduleFtsDrain } from '../lib/notify'
import { assertContentSize, clampInt, JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { aiDeleteNeededSql, enqueueNoteIndex, noteIndexQueueStatement } from '../mcp/ai-search'

export const notesRoutes = new Hono<AppBindings>()

notesRoutes.use('*', requireAuth)


const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000

const SNAPSHOT_DIFF_THRESHOLD = 400

interface NotesListCursor {
  view: ViewKind
  sort: SortKey
  order: SortOrder
  pinned: number
  value: string | number
  id: string
}

type ParsedNotesListCursor =
  | { kind: 'first' }
  | { kind: 'legacy'; offset: number }
  | { kind: 'keyset'; cursor: NotesListCursor }

const NOTE_VIEWS = new Set<ViewKind>(['all', 'recent', 'starred', 'unfiled', 'archived', 'trash', 'folder', 'tag'])
const NOTE_SORTS = new Set<SortKey>(['updated', 'created', 'title'])


notesRoutes.get('/', async (c) => {
  const userId = c.get('userId')
  const requestedView = c.req.query('view') as ViewKind | undefined
  const requestedSort = c.req.query('sort') as SortKey | undefined
  const view = requestedView && NOTE_VIEWS.has(requestedView) ? requestedView : 'all'
  const sort = requestedSort && NOTE_SORTS.has(requestedSort) ? requestedSort : 'updated'
  const order: SortOrder = c.req.query('order') === 'asc' ? 'asc' : 'desc'
  const limit = clampInt(c.req.query('limit'), 1, 1000, 500)
  const cursor = parseNotesListCursor(c.req.query('cursor'), view, sort, order)

  const binds: unknown[] = [userId]
  let where = 'n.user_id = ?1'

  if (view === 'trash') {
    where += ' AND n.deleted_at IS NOT NULL'
  } else {
    where += ' AND n.deleted_at IS NULL'
    where += view === 'archived' ? ' AND n.is_archived = 1' : ' AND n.is_archived = 0'
  }

  if (view === 'starred') where += ' AND n.is_starred = 1'
  if (view === 'unfiled') where += ' AND n.folder_id IS NULL'

  if (view === 'folder') {
    const folderId = c.req.query('folderId')
    if (!folderId) throw ApiError.badRequest('Missing folderId')
    binds.push(folderId)
    where += ` AND n.folder_id = ?${binds.length}`
  }

  if (view === 'tag') {
    const tag = c.req.query('tag')
    if (!tag) throw ApiError.badRequest('Missing tag')
    binds.push(tag)
    where += ` AND EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
                 WHERE nt.note_id = n.id AND t.user_id = n.user_id
                   AND t.name = ?${binds.length} COLLATE NOCASE)`
  }

  const countWhere = where
  const countBinds = [...binds]

  const dir = order === 'asc' ? 'ASC' : 'DESC'
  const valueColumn = view === 'trash'
    ? 'n.deleted_at'
    : sort === 'created'
      ? 'n.created_at'
      : sort === 'title'
        ? 'n.title'
        : 'n.updated_at'
  const valueCollation = sort === 'title' && view !== 'trash' ? ' COLLATE NOCASE' : ''
  const orderBy =
    view === 'trash'
      ? `n.deleted_at ${dir}, n.id ASC`
      : ({
          updated: `n.is_pinned DESC, n.updated_at ${dir}, n.id ASC`,
          created: `n.is_pinned DESC, n.created_at ${dir}, n.id ASC`,
          title: `n.is_pinned DESC, n.title COLLATE NOCASE ${dir}, n.id ASC`,
        }[sort] ?? `n.is_pinned DESC, n.updated_at ${dir}, n.id ASC`)

  if (cursor.kind === 'keyset') {
    const comparison = order === 'asc' ? '>' : '<'
    if (view === 'trash') {
      binds.push(cursor.cursor.value, cursor.cursor.value, cursor.cursor.id)
      const valueBind = binds.length - 2
      const repeatedValueBind = binds.length - 1
      const idBind = binds.length
      where += ` AND (${valueColumn}${valueCollation} ${comparison} ?${valueBind}
        OR (${valueColumn}${valueCollation} = ?${repeatedValueBind} AND n.id > ?${idBind}))`
    } else {
      binds.push(
        cursor.cursor.pinned,
        cursor.cursor.pinned,
        cursor.cursor.value,
        cursor.cursor.value,
        cursor.cursor.id,
      )
      const firstPinnedBind = binds.length - 4
      const repeatedPinnedBind = binds.length - 3
      const valueBind = binds.length - 2
      const repeatedValueBind = binds.length - 1
      const idBind = binds.length
      where += ` AND (n.is_pinned < ?${firstPinnedBind}
        OR (n.is_pinned = ?${repeatedPinnedBind} AND (
          ${valueColumn}${valueCollation} ${comparison} ?${valueBind}
          OR (${valueColumn}${valueCollation} = ?${repeatedValueBind} AND n.id > ?${idBind})
        )))`
    }
  }

  const listSql = cursor.kind === 'legacy'
    ? `SELECT ${NOTE_COLUMNS} FROM notes n WHERE ${where} ORDER BY ${orderBy}
       LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
    : `SELECT ${NOTE_COLUMNS} FROM notes n WHERE ${where} ORDER BY ${orderBy}
       LIMIT ?${binds.length + 1}`
  const listStatement = cursor.kind === 'legacy'
    ? c.env.DB.prepare(listSql).bind(...binds, limit + 1, cursor.offset)
    : c.env.DB.prepare(listSql).bind(...binds, limit + 1)
  const [countResult, listResult] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM notes n WHERE ${countWhere}`).bind(...countBinds),
    listStatement,
  ])

  const total = Number((countResult?.results?.[0] as { total?: unknown } | undefined)?.total ?? 0)
  const rows = listResult?.results as NoteRow[] | undefined ?? []
  const pageRows = rows.slice(0, limit)
  const notes = pageRows.map(toNoteSummary)
  const body: ListNotesResponse = {
    notes,
    total,
    nextCursor: rows.length > limit && pageRows.length
      ? encodeNotesListCursor(pageRows[pageRows.length - 1]!, view, sort, order)
      : null,
  }
  return c.json(body)
})


notesRoutes.post('/trash/empty', async (c) => {
  const userId = c.get('userId')
  const { ftsEnabled } = c.get('database')
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL`,
  )
    .bind(userId)
    .first<{ count: number }>()
  let purged = 0
  let deletionCursor: number | undefined

  if ((row?.count ?? 0) > 0) {
    const trashed = `SELECT id FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL`
    const statements = [
      c.env.DB.prepare(`DELETE FROM note_tags WHERE note_id IN (${trashed})`).bind(userId),
      c.env.DB.prepare(`DELETE FROM links WHERE source_note_id IN (${trashed})`).bind(userId),
      c.env.DB.prepare(
        `UPDATE links SET target_note_id = ${LINK_TARGET_SUBQUERY}
          WHERE user_id = ?1 AND target_note_id IN (${trashed})`,
      ).bind(userId),
      c.env.DB.prepare(`DELETE FROM note_versions WHERE note_id IN (${trashed})`).bind(userId),
      c.env.DB.prepare(
        `DELETE FROM share_asset_sessions WHERE slug IN (
           SELECT slug FROM shares WHERE user_id = ?1 AND note_id IN (${trashed})
         )`,
      ).bind(userId),
      c.env.DB.prepare(`DELETE FROM shares WHERE note_id IN (${trashed})`).bind(userId),
      c.env.DB.prepare(`UPDATE attachments SET note_id = NULL WHERE note_id IN (${trashed})`).bind(userId),
      c.env.DB.prepare(
        `DELETE FROM import_mappings
          WHERE user_id = ?1 AND entity = 'note' AND target_id IN (${trashed})`,
      ).bind(userId),
    ]
    if (ftsEnabled) {
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO fts_index_queue (user_id, note_id, kind, created_at)
           SELECT ?1, id, 'delete', ?2
             FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL
           ${FTS_QUEUE_CONFLICT_SQL}`,
        ).bind(userId, Date.now()),
      )
    }
    statements.push(
      c.env.DB.prepare(
        `INSERT OR REPLACE INTO ai_index_queue (user_id, note_id, kind, created_at)
         SELECT ?1, id, 'delete', ?2
           FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL
             AND ${aiDeleteNeededSql('?1', 'notes.id')}`,
      ).bind(userId, Date.now()),
      c.env.DB
        .prepare(
          `INSERT INTO changes (user_id, entity, entity_id, op, at)
           SELECT ?1, 'note', id, 'delete', ?2
             FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL`,
        )
        .bind(userId, Date.now()),
      c.env.DB
        .prepare(`SELECT seq FROM changes WHERE user_id = ?1 ORDER BY seq DESC LIMIT 1`)
        .bind(userId),
      c.env.DB
        .prepare(`DELETE FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL`)
        .bind(userId),
    )
    const results = await c.env.DB.batch(statements)
    const changeResult = results.at(-2) as D1Result<{ seq: number }> | undefined
    purged = results.at(-1)?.meta.changes ?? 0
    deletionCursor = changeResult?.results?.at(-1)?.seq
    if (purged) scheduleFtsDrain(c)
  }
  await pruneOrphanTags(c.env.DB, userId)
  await broadcastCursor(c, deletionCursor)
  return c.json({ purged })
})


notesRoutes.get('/:id', async (c) => {
  const note = await loadNote(c.env.DB, c.get('userId'), c.req.param('id'))
  return c.json(note)
})

notesRoutes.post('/', async (c) => {
  const userId = c.get('userId')
  const { ftsEnabled } = c.get('database')
  const body = await readJson<CreateNoteBody>(c, JSON_BODY_LIMITS.note)

  if (body.content !== undefined && typeof body.content !== 'string') {
    throw ApiError.badRequest('content must be a string')
  }
  if (body.title !== undefined && typeof body.title !== 'string') {
    throw ApiError.badRequest('title must be a string')
  }
  if (body.folderId !== undefined && body.folderId !== null && typeof body.folderId !== 'string') {
    throw ApiError.badRequest('folderId must be a string or null')
  }
  if (body.isStarred !== undefined && typeof body.isStarred !== 'boolean') {
    throw ApiError.badRequest('isStarred must be a boolean')
  }
  if (body.id !== undefined && !isValidId(body.id)) {
    throw ApiError.badRequest('id must be a valid note id')
  }
  const content = typeof body.content === 'string' ? body.content : ''
  assertContentSize(content)

  const id = body.id ?? newId()
  if (body.id) {
    const existing = await c.env.DB.prepare(
      `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
    )
      .bind(id, userId)
      .first<NoteRow>()
    if (existing) return c.json(toNote(existing))
    const collision = await c.env.DB.prepare(`SELECT user_id FROM notes WHERE id = ?1`)
      .bind(id)
      .first<{ user_id: string }>()
    if (collision) throw ApiError.conflict('This note id is already in use')
  }
  const now = Date.now()
  const title = resolveNoteTitle(body.title)
  const excerpt = deriveExcerpt(content)
  const { words, chars } = countText(content)
  const hash = await sha256Hex(content)
  const folderId = await resolveFolderId(c.env.DB, userId, body.folderId ?? null)

  const insert = c.env.DB.prepare(
    `INSERT OR IGNORE INTO notes (id, user_id, folder_id, title, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, 0, ?9, 0, ?10, ?11, ?12, ?12)`,
  )
    .bind(id, userId, folderId, title, content, excerpt, words, chars, body.isStarred ? 1 : 0, now, hash, now)
  const derived = buildNoteDerivedStatements({
    db: c.env.DB,
    userId,
    noteId: id,
    title,
    content,
    ftsEnabled,
    expectedRev: 1,
    expectedContentHash: hash,
    expectedTitle: title,
    expectedUpdatedAt: now,
  }).statements
  const createChange = c.env.DB.prepare(
    `INSERT INTO changes (user_id, entity, entity_id, op, at)
     SELECT ?1, 'note', ?2, 'upsert', ?3
      WHERE EXISTS (
        SELECT 1 FROM notes
         WHERE id = ?2 AND user_id = ?1 AND rev = 1
           AND content_hash = ?4 AND title = ?5 AND created_at = ?3 AND updated_at = ?3
      )`,
  ).bind(userId, id, now, hash, title)
  const [insertResult] = await c.env.DB.batch([insert, ...derived, createChange])
  const created = await c.env.DB.prepare(
    `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
  )
    .bind(id, userId)
    .first<NoteRow>()
  if (!created) throw ApiError.conflict('This note id is already in use')
  await broadcastCursor(c)
  if (insertResult?.meta.changes) {
    await syncBlogShare(c.env.DB, userId, id, extractTags(content))
    await enqueueNoteIndex(c.env.DB, userId, id, 'embed')
    scheduleFtsDrain(c)
  }
  const note = toNote(created)
  return c.json(note, insertResult?.meta.changes ? 201 : 200)
})

notesRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const { ftsEnabled } = c.get('database')
  const body = await readJson<PatchNoteBody>(c, JSON_BODY_LIMITS.note)

  const row = await c.env.DB.prepare(
    `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
  )
    .bind(id, userId)
    .first<NoteRow>()
  if (!row) {
    const deletion = await c.env.DB.prepare(
      `SELECT MAX(seq) AS seq FROM changes
        WHERE user_id = ?1 AND entity = 'note' AND entity_id = ?2 AND op = 'delete'`,
    )
      .bind(userId, id)
      .first<{ seq: number | null }>()
    throw ApiError.notFound('Note not found', { deletionCursor: deletion?.seq ?? null })
  }

  if (!Number.isInteger(body.rev) || body.rev < 1) {
    throw ApiError.badRequest('rev must be a positive integer')
  }
  if (body.rev !== row.rev) {
    throw ApiError.conflict('This note was modified elsewhere', { server: toNote(row) })
  }
  if (body.content !== undefined && typeof body.content !== 'string') {
    throw ApiError.badRequest('content must be a string')
  }
  if (body.title !== undefined && typeof body.title !== 'string') {
    throw ApiError.badRequest('title must be a string')
  }
  if (body.folderId !== undefined && body.folderId !== null && typeof body.folderId !== 'string') {
    throw ApiError.badRequest('folderId must be a string or null')
  }
  for (const [key, value] of [
    ['isPinned', body.isPinned],
    ['isStarred', body.isStarred],
    ['isArchived', body.isArchived],
    ['quiet', body.quiet],
    ['preserveVersion', body.preserveVersion],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw ApiError.badRequest(`${key} must be a boolean`)
    }
  }

  const now = Math.max(Date.now(), row.updated_at + 1)
  const sets: string[] = []
  const binds: unknown[] = []
  let contentChanged = false
  let newTitle = row.title
  let newContent = row.content
  let newHash = row.content_hash
  const resolvedTitle = resolveNoteTitle(body.title, row.title)

  if (typeof body.content === 'string' && body.content !== row.content) {
    assertContentSize(body.content)
    const hash = await sha256Hex(body.content)
    if (hash !== row.content_hash) {
      contentChanged = true
      newHash = hash
      newContent = body.content
      newTitle = resolvedTitle
      const { words, chars } = countText(body.content)
      push(sets, binds, 'content', body.content)
      push(sets, binds, 'content_hash', hash)
      push(sets, binds, 'title', newTitle)
      push(sets, binds, 'excerpt', deriveExcerpt(body.content))
      push(sets, binds, 'word_count', words)
      push(sets, binds, 'char_count', chars)
    }
  } else if (resolvedTitle !== row.title) {
    newTitle = resolvedTitle
    push(sets, binds, 'title', newTitle)
  }

  if (body.folderId !== undefined && body.folderId !== row.folder_id) {
    push(sets, binds, 'folder_id', await resolveFolderId(c.env.DB, userId, body.folderId))
  }
  if (typeof body.isPinned === 'boolean' && Number(body.isPinned) !== row.is_pinned) push(sets, binds, 'is_pinned', body.isPinned ? 1 : 0)
  if (typeof body.isStarred === 'boolean' && Number(body.isStarred) !== row.is_starred) push(sets, binds, 'is_starred', body.isStarred ? 1 : 0)
  if (typeof body.isArchived === 'boolean' && Number(body.isArchived) !== row.is_archived) push(sets, binds, 'is_archived', body.isArchived ? 1 : 0)

  if (!sets.length) return c.json(toNote(row))

  push(sets, binds, 'updated_at', now)
  const nextRev = row.rev + 1
  push(sets, binds, 'rev', nextRev)
  const mutationGuard = `EXISTS (SELECT 1 FROM notes
    WHERE id = ?1 AND user_id = ?2 AND rev = ?3
      AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
  const mutationValues = [id, userId, nextRev, newHash, newTitle, now] as const

  binds.push(id, userId, body.rev)
  const update = c.env.DB.prepare(
    `UPDATE notes SET ${sets.join(', ')}
      WHERE id = ?${binds.length - 2} AND user_id = ?${binds.length - 1} AND rev = ?${binds.length}`,
  ).bind(...binds)

  const statements: D1PreparedStatement[] = [update]
  let derivedTags: string[] | null = null

  if (contentChanged && !body.quiet && row.content) {
    const bigChange = Math.abs(newContent.length - row.content.length) >= SNAPSHOT_DIFF_THRESHOLD
    const snapshotId = newId()
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
          WHERE ${shiftSqlPlaceholders(mutationGuard, 7)}
            AND (?14 = 1
                 OR NOT EXISTS (SELECT 1 FROM note_versions WHERE note_id = ?2)
                 OR ?15 - COALESCE((SELECT MAX(created_at) FROM note_versions WHERE note_id = ?2), 0) > ?16
                 OR ?17 = 1)`,
      ).bind(
        snapshotId, id, userId, row.title, row.content, utf8ByteLength(row.content), now,
        ...mutationValues,
        body.preserveVersion ? 1 : 0, now, SNAPSHOT_INTERVAL_MS, bigChange ? 1 : 0,
      ),
      c.env.DB.prepare(
        `DELETE FROM note_versions WHERE note_id = ?1
           AND EXISTS (SELECT 1 FROM note_versions WHERE id = ?9)
           AND ${shiftSqlPlaceholders(mutationGuard, 1)}
           AND id IN (
             SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`,
      ).bind(id, ...mutationValues, LIMITS.versionsPerNote, snapshotId),
    )
  }

  if (row.deleted_at === null && (contentChanged || newTitle !== row.title)) {
    const derived = buildNoteDerivedStatements({
      db: c.env.DB,
      userId,
      noteId: id,
      title: newTitle,
      content: newContent,
      ftsEnabled,
      titleChanged: newTitle !== row.title,
      previousTitle: row.title,
      expectedRev: nextRev,
      expectedContentHash: newHash,
      expectedTitle: newTitle,
      expectedUpdatedAt: now,
    })
    statements.push(...derived.statements)
    derivedTags = derived.tags
    if (contentChanged && !sameTagSet(splitTags(row.tag_names), derived.tags)) {
      statements.push(
        c.env.DB.prepare(
          `DELETE FROM tags WHERE user_id = ?1 AND is_manual = 0
             AND ${shiftSqlPlaceholders(mutationGuard, 1)}
             AND NOT EXISTS (SELECT 1 FROM note_tags WHERE tag_id = tags.id)`,
        ).bind(userId, ...mutationValues),
      )
    }
  }

  statements.push(
    c.env.DB.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', ?2, 'upsert', ?3
        WHERE ${shiftSqlPlaceholders(mutationGuard, 3)}
       RETURNING seq`,
    ).bind(userId, id, now, ...mutationValues),
  )

  const results = await c.env.DB.batch(statements)
  const updateResult = results[0]
  if (!updateResult?.meta.changes) {
    const current = await loadNote(c.env.DB, userId, id)
    throw ApiError.conflict('This note was modified elsewhere', { server: current })
  }
  if (contentChanged) {
    await syncBlogShare(c.env.DB, userId, id, derivedTags ?? extractTags(newContent), splitTags(row.tag_names))
  }
  const changeResult = results.at(-1) as D1Result<{ seq: number }> | undefined
  let rewroteInbound = false
  if (newTitle !== row.title) {
    const ambiguous = await c.env.DB.prepare(
      `SELECT 1 AS found FROM notes
        WHERE user_id = ?1 AND id <> ?2 AND deleted_at IS NULL AND title_key IN (?3, ?4)
        LIMIT 1`,
    ).bind(
      userId,
      id,
      normalizeLinkKey(row.title),
      normalizeLinkKey(newTitle),
    ).first<{ found: number }>()
    if (!ambiguous) {
      const rewrite = await rewriteInboundWikiLinks(
        c.env.DB,
        userId,
        id,
        row.title,
        newTitle,
        ftsEnabled,
      )
      if (rewrite.skipped) {
        console.warn(`Could not update ${rewrite.skipped} wiki-link source notes after renaming note ${id}`)
      }
      rewroteInbound = rewrite.rewritten > 0
    } else {
      await c.env.DB.prepare(
        `UPDATE links SET target_note_id = ${LINK_TARGET_SUBQUERY}
          WHERE user_id = ?1 AND target_key = ?2
            AND EXISTS (SELECT 1 FROM notes
              WHERE id = ?3 AND user_id = ?1 AND rev = ?4
                AND title = ?5 AND updated_at = ?6 AND deleted_at IS NULL)`,
      ).bind(
        userId,
        normalizeLinkKey(row.title),
        id,
        nextRev,
        newTitle,
        now,
      ).run()
    }
  }
  await broadcastCursor(c, rewroteInbound ? undefined : changeResult?.results?.[0]?.seq)
  if (contentChanged || newTitle !== row.title) {
    await enqueueNoteIndex(c.env.DB, userId, id, 'embed')
    scheduleFtsDrain(c)
  }
  const nextTags = contentChanged ? (derivedTags ?? extractTags(newContent)) : null
  return c.json(toNote(applyPatchRow(row, sets, binds, nextTags)))
})

notesRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const { ftsEnabled } = c.get('database')

  const row = await loadNoteRow(c.env.DB, userId, id)
  if (row.deleted_at !== null) throw ApiError.notFound('The note does not exist or is in the trash')
  const now = Math.max(Date.now(), row.updated_at + 1)
  const nextRev = row.rev + 1
  const guard = `EXISTS (SELECT 1 FROM notes
    WHERE id = ?1 AND user_id = ?2 AND rev = ?3 AND deleted_at IS NOT NULL)`
  const statements = [
    c.env.DB.prepare(
      `UPDATE notes SET deleted_at = ?1, updated_at = ?1, rev = ?2
        WHERE id = ?3 AND user_id = ?4 AND rev = ?5 AND deleted_at IS NULL`,
    ).bind(now, nextRev, id, userId, row.rev),
    c.env.DB.prepare(`DELETE FROM links WHERE source_note_id = ?1 AND ${shiftSqlPlaceholders(guard, 1)}`)
      .bind(id, id, userId, nextRev),
    c.env.DB.prepare(
      `UPDATE links SET target_note_id = ${LINK_TARGET_SUBQUERY}
        WHERE target_note_id = ?1 AND user_id = ?2 AND ${shiftSqlPlaceholders(guard, 2)}`,
    ).bind(id, userId, id, userId, nextRev),
  ]
  if (ftsEnabled) {
    statements.push(
      c.env.DB.prepare(
         `INSERT INTO fts_index_queue (user_id, note_id, kind, created_at)
          SELECT ?1, ?2, 'delete', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
          ${FTS_QUEUE_CONFLICT_SQL}`,
      ).bind(userId, id, now, id, userId, nextRev),
    )
  }
  statements.push(
    c.env.DB.prepare(
      `INSERT OR REPLACE INTO ai_index_queue (user_id, note_id, kind, created_at)
       SELECT ?1, ?2, 'delete', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
         AND ${aiDeleteNeededSql('?1', '?2')}`,
    ).bind(userId, id, now, id, userId, nextRev),
  )
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', ?2, 'upsert', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
       RETURNING seq`,
    ).bind(userId, id, now, id, userId, nextRev),
  )
  const results = await c.env.DB.batch(statements)
  const updated = results[0]
  if (!updated?.meta.changes) {
    throw ApiError.conflict('This note was modified elsewhere', { server: await loadNote(c.env.DB, userId, id) })
  }
  if (blogTierOfTags(splitTags(row.tag_names)) !== 'none') {
    await withdrawBlogShare(c.env.DB, userId, id)
  }
  const changeResult = results.at(-1) as D1Result<{ seq: number }> | undefined
  await broadcastCursor(c, changeResult?.results?.[0]?.seq)
  scheduleFtsDrain(c)
  const note = toNote({ ...row, deleted_at: now, updated_at: now, rev: nextRev })
  return c.json(note)
})

notesRoutes.post('/:id/restore', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const { ftsEnabled } = c.get('database')
  const row = await loadNoteRow(c.env.DB, userId, id)
  if (row.deleted_at === null) throw ApiError.badRequest('The note is not in the trash')

  const now = Math.max(Date.now(), row.updated_at + 1)
  const nextRev = row.rev + 1
  const update = c.env.DB.prepare(
    `UPDATE notes SET deleted_at = NULL, updated_at = ?1, rev = ?2
      WHERE id = ?3 AND user_id = ?4 AND rev = ?5 AND deleted_at IS NOT NULL`,
  ).bind(now, nextRev, id, userId, row.rev)
  const derived = buildNoteDerivedStatements({
    db: c.env.DB,
    userId,
    noteId: id,
    title: row.title,
    content: row.content,
    ftsEnabled,
    titleChanged: true,
    expectedRev: nextRev,
    expectedContentHash: row.content_hash,
    expectedTitle: row.title,
    expectedUpdatedAt: now,
  }).statements
  const change = c.env.DB.prepare(
    `INSERT INTO changes (user_id, entity, entity_id, op, at)
     SELECT ?1, 'note', ?2, 'upsert', ?3
      WHERE EXISTS (SELECT 1 FROM notes WHERE id = ?2 AND user_id = ?1 AND rev = ?4 AND deleted_at IS NULL)`,
  ).bind(userId, id, now, nextRev)
  const [updated] = await c.env.DB.batch([update, ...derived, change])
  if (!updated?.meta.changes) {
    throw ApiError.conflict('This note was modified elsewhere', { server: await loadNote(c.env.DB, userId, id) })
  }
  await syncBlogShare(c.env.DB, userId, id, extractTags(row.content))
  await broadcastCursor(c)
  await enqueueNoteIndex(c.env.DB, userId, id, 'embed')
  scheduleFtsDrain(c)
  const note = await loadNote(c.env.DB, userId, id)
  return c.json(note)
})

notesRoutes.delete('/:id/purge', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const { ftsEnabled } = c.get('database')
  const row = await loadNoteRow(c.env.DB, userId, id)
  if (row.deleted_at === null) throw ApiError.notFound('The note does not exist or is not in the trash')
  const guard = `EXISTS (SELECT 1 FROM notes
    WHERE id = ?1 AND user_id = ?2 AND rev = ?3 AND deleted_at IS NOT NULL)`
  const guarded = (sql: string) => c.env.DB
    .prepare(`${sql} AND ${shiftSqlPlaceholders(guard, 1)}`)
    .bind(id, id, userId, row.rev)
  const statements: D1PreparedStatement[] = [
    guarded(`DELETE FROM note_tags WHERE note_id = ?1`),
    guarded(`DELETE FROM links WHERE source_note_id = ?1`),
    c.env.DB.prepare(
      `UPDATE links SET target_note_id = ${LINK_TARGET_SUBQUERY}
        WHERE target_note_id = ?1 AND user_id = ?2 AND ${shiftSqlPlaceholders(guard, 2)}`,
    ).bind(id, userId, id, userId, row.rev),
    guarded(`DELETE FROM note_versions WHERE note_id = ?1`),
    c.env.DB.prepare(
      `DELETE FROM share_asset_sessions
        WHERE slug IN (SELECT slug FROM shares WHERE note_id = ?1 AND user_id = ?2)
          AND ${shiftSqlPlaceholders(guard, 2)}`,
    ).bind(id, userId, id, userId, row.rev),
    guarded(`DELETE FROM shares WHERE note_id = ?1`),
    guarded(`UPDATE attachments SET note_id = NULL WHERE note_id = ?1`),
    c.env.DB.prepare(
      `DELETE FROM import_mappings
        WHERE user_id = ?1 AND entity = 'note' AND target_id = ?2
          AND EXISTS (SELECT 1 FROM notes
            WHERE id = ?2 AND user_id = ?1 AND rev = ?3 AND deleted_at IS NOT NULL)`,
    ).bind(userId, id, row.rev),
  ]
  if (ftsEnabled) {
    statements.push(
      c.env.DB.prepare(
         `INSERT INTO fts_index_queue (user_id, note_id, kind, created_at)
          SELECT ?1, ?2, 'delete', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
          ${FTS_QUEUE_CONFLICT_SQL}`,
      ).bind(userId, id, Date.now(), id, userId, row.rev),
    )
  }
  statements.push(
    c.env.DB.prepare(
      `INSERT OR REPLACE INTO ai_index_queue (user_id, note_id, kind, created_at)
       SELECT ?1, ?2, 'delete', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
         AND ${aiDeleteNeededSql('?1', '?2')}`,
    ).bind(userId, id, Date.now(), id, userId, row.rev),
  )
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', ?2, 'delete', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
       RETURNING seq`,
    ).bind(userId, id, Date.now(), id, userId, row.rev),
    c.env.DB.prepare(
      `DELETE FROM notes WHERE id = ?1 AND user_id = ?2 AND rev = ?3 AND deleted_at IS NOT NULL`,
    ).bind(id, userId, row.rev),
    c.env.DB.prepare(`DELETE FROM tags
      WHERE user_id = ?1 AND is_manual = 0
        AND NOT EXISTS (SELECT 1 FROM note_tags WHERE tag_id = tags.id)`)
      .bind(userId),
  )
  const results = await c.env.DB.batch(statements)
  const changeResult = results.at(-3) as D1Result<{ seq: number }> | undefined
  const deleted = results.at(-2)
  if (!deleted?.meta.changes) throw ApiError.conflict('Note state changed. Refresh and try again')
  const broadcastedCursor = await broadcastCursor(c, changeResult?.results?.[0]?.seq)
  const deletionCursor = changeResult?.results[0]?.seq
  scheduleFtsDrain(c)
  return c.json({
    ok: true,
    cursor: Number.isSafeInteger(deletionCursor) ? deletionCursor! : broadcastedCursor,
  })
})

notesRoutes.post('/:id/duplicate', async (c) => {
  const userId = c.get('userId')
  const { ftsEnabled } = c.get('database')
  const source = await loadNoteRow(c.env.DB, userId, c.req.param('id'))
  const body = c.req.header('Content-Type')?.includes('application/json')
    ? await readJson<{ id?: string }>(c, JSON_BODY_LIMITS.small)
    : {}
  if (body.id !== undefined && !isValidId(body.id)) {
    throw ApiError.badRequest('id must be a valid note id')
  }

  const id = body.id ?? newId()
  if (body.id) {
    const existing = await c.env.DB.prepare(
      `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
    ).bind(id, userId).first<NoteRow>()
    if (existing) return c.json(toNote(existing))
    const collision = await c.env.DB.prepare(`SELECT user_id FROM notes WHERE id = ?1`)
      .bind(id)
      .first<{ user_id: string }>()
    if (collision) throw ApiError.conflict('This note id is already in use')
  }
  const now = Date.now()
  const title = duplicateNoteTitle(source.title, LIMITS.titleMaxLength)
  const content = source.content
  const hash = await sha256Hex(content)

  const insert = c.env.DB.prepare(
    `INSERT INTO notes (id, user_id, folder_id, title, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, 0, 0, ?9, ?10, ?11, ?12, ?12)`,
  )
    .bind(
      id,
      userId,
      source.folder_id,
      title,
      content,
      source.excerpt,
      source.word_count,
      source.char_count,
      source.is_archived,
      now,
      hash,
      now,
    )
  const derived = buildNoteDerivedStatements({
    db: c.env.DB,
    userId,
    noteId: id,
    title,
    content,
    ftsEnabled,
    expectedRev: 1,
    expectedContentHash: hash,
    expectedTitle: title,
    expectedUpdatedAt: now,
  }).statements
  try {
    await c.env.DB.batch([insert, ...derived, changeStatement(c.env.DB, userId, 'note', id, 'upsert')])
  } catch (error) {
    if (body.id) {
      const existing = await c.env.DB.prepare(
        `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
      ).bind(id, userId).first<NoteRow>()
      if (existing) return c.json(toNote(existing))
      const collision = await c.env.DB.prepare(`SELECT user_id FROM notes WHERE id = ?1`)
        .bind(id)
        .first<{ user_id: string }>()
      if (collision) throw ApiError.conflict('This note id is already in use')
    }
    throw error
  }
  await syncBlogShare(c.env.DB, userId, id, extractTags(content))
  await broadcastCursor(c)
  await enqueueNoteIndex(c.env.DB, userId, id, 'embed')
  scheduleFtsDrain(c)
  const note = await loadNote(c.env.DB, userId, id)
  return c.json(note, 201)
})


notesRoutes.get('/:id/versions', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, note_id, title, length(CAST(content AS BLOB)) AS size, created_at FROM note_versions
       WHERE note_id = ?1 AND user_id = ?2 ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(c.req.param('id'), c.get('userId'))
    .all<{ id: string; note_id: string; title: string; size: number; created_at: number }>()

  return c.json({
    versions: results.map((r) => ({
      id: r.id,
      noteId: r.note_id,
      title: r.title,
      size: r.size,
      createdAt: r.created_at,
    })),
  })
})

notesRoutes.get('/:id/versions/:versionId', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT id, note_id, title, content, length(CAST(content AS BLOB)) AS size, created_at FROM note_versions
       WHERE id = ?1 AND note_id = ?2 AND user_id = ?3`,
  )
    .bind(c.req.param('versionId'), c.req.param('id'), c.get('userId'))
    .first<{
      id: string
      note_id: string
      title: string
      content: string
      size: number
      created_at: number
    }>()
  if (!row) throw ApiError.notFound('Version not found')
  return c.json({
    id: row.id,
    noteId: row.note_id,
    title: row.title,
    content: row.content,
    size: row.size,
    createdAt: row.created_at,
  })
})

notesRoutes.post('/:id/versions/:versionId/restore', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const { ftsEnabled } = c.get('database')

  const version = await c.env.DB.prepare(
    `SELECT title, content FROM note_versions WHERE id = ?1 AND note_id = ?2 AND user_id = ?3`,
  )
    .bind(c.req.param('versionId'), id, userId)
    .first<{ title: string; content: string }>()
  if (!version) throw ApiError.notFound('Version not found')

  const current = await loadNoteRow(c.env.DB, userId, id)
  const now = Math.max(Date.now(), current.updated_at + 1)
  const { words, chars } = countText(version.content)
  const title = restoredVersionTitle(version.title)
  const hash = await sha256Hex(version.content)
  const nextRev = current.rev + 1
  const mutationGuard = `EXISTS (SELECT 1 FROM notes
    WHERE id = ?1 AND user_id = ?2 AND rev = ?3
      AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
  const mutationValues = [id, userId, nextRev, hash, title, now] as const
  const update = c.env.DB.prepare(
    `UPDATE notes SET content = ?1, title = ?2, excerpt = ?3, word_count = ?4, char_count = ?5,
       content_hash = ?6, rev = ?7, updated_at = ?8
       WHERE id = ?9 AND user_id = ?10 AND rev = ?11`,
  )
    .bind(
      version.content,
      title,
      deriveExcerpt(version.content),
      words,
      chars,
      hash,
      nextRev,
      now,
      id,
      userId,
      current.rev,
    )
  const snapshot = c.env.DB.prepare(
    `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
      WHERE ${shiftSqlPlaceholders(mutationGuard, 7)}`,
  ).bind(newId(), id, userId, current.title, current.content, utf8ByteLength(current.content), now, ...mutationValues)
  const trimVersions = c.env.DB.prepare(
    `DELETE FROM note_versions WHERE note_id = ?1
       AND ${shiftSqlPlaceholders(mutationGuard, 1)}
       AND id IN (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`,
  ).bind(id, ...mutationValues, LIMITS.versionsPerNote)
  const derived = buildNoteDerivedStatements({
    db: c.env.DB,
    userId,
    noteId: id,
    title,
    content: version.content,
    ftsEnabled,
    titleChanged: true,
    previousTitle: current.title,
    expectedRev: nextRev,
    expectedContentHash: hash,
    expectedTitle: title,
    expectedUpdatedAt: now,
    deleted: current.deleted_at !== null,
  }).statements
  const change = c.env.DB.prepare(
    `INSERT INTO changes (user_id, entity, entity_id, op, at)
     SELECT ?1, 'note', ?2, 'upsert', ?3
      WHERE ${shiftSqlPlaceholders(mutationGuard, 3)}`,
  ).bind(userId, id, now, ...mutationValues)
  const [updated] = await c.env.DB.batch([update, snapshot, trimVersions, ...derived, change])
  if (!updated?.meta.changes) {
    throw ApiError.conflict('This note was modified elsewhere', { server: await loadNote(c.env.DB, userId, id) })
  }
  await syncBlogShare(c.env.DB, userId, id, extractTags(version.content), splitTags(current.tag_names))
  await broadcastCursor(c)
  await enqueueNoteIndex(c.env.DB, userId, id, 'embed')
  scheduleFtsDrain(c)
  const note = await loadNote(c.env.DB, userId, id)
  return c.json(note)
})


notesRoutes.get('/:id/backlinks', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const note = await loadNoteRow(c.env.DB, userId, id)

  const { results } = await c.env.DB.prepare(
    `SELECT n.id, n.title, n.content FROM links l
       JOIN notes n ON n.id = l.source_note_id
      WHERE l.user_id = ?1 AND l.target_note_id = ?2
        AND n.deleted_at IS NULL AND n.id != ?2
       ORDER BY n.updated_at DESC LIMIT 50`,
  )
    .bind(userId, id)
    .all<{ id: string; title: string; content: string }>()

  return c.json({
    backlinks: results.map((r) => ({
      id: r.id,
      title: r.title,
      context: linkContext(r.content, note.title),
    })),
  })
})


async function loadNote(db: D1Database, userId: string, id: string): Promise<Note> {
  return toNote(await loadNoteRow(db, userId, id))
}

async function loadNoteRow(db: D1Database, userId: string, id: string): Promise<NoteRow> {
  const row = await db
    .prepare(`SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`)
    .bind(id, userId)
    .first<NoteRow>()
  if (!row) throw ApiError.notFound('Note not found')
  return row
}

function linkContext(content: string, title: string): string {
  const needle = `[[${title}`
  const idx = content.toLowerCase().indexOf(needle.toLowerCase())
  if (idx < 0) return truncateText(content, 120).replace(/\s+/g, ' ').trim()
  const start = Math.max(0, idx - 60)
  const end = Math.min(content.length, idx + needle.length + 90)
  return (
    (start > 0 ? '…' : '') +
    sliceText(content, start, end).replace(/\s+/g, ' ').trim() +
    (end < content.length ? '…' : '')
  )
}

async function rewriteInboundWikiLinks(
  db: D1Database,
  userId: string,
  targetNoteId: string,
  fromTitle: string,
  toTitle: string,
  ftsEnabled: boolean,
): Promise<{ rewritten: number; skipped: number }> {
  const previousKey = normalizeLinkKey(fromTitle)
  const { results: candidates } = await db.prepare(
    `SELECT DISTINCT n.id FROM links l
      JOIN notes n ON n.id = l.source_note_id AND n.user_id = l.user_id
     WHERE l.user_id = ?1 AND l.target_note_id = ?2 AND l.target_key = ?3
       AND n.id <> ?2 AND n.deleted_at IS NULL`,
  ).bind(userId, targetNoteId, previousKey).all<{ id: string }>()
  let rewritten = 0
  let skipped = 0
  for (const candidate of candidates) {
    let complete = false
    for (let attempt = 0; attempt < 5; attempt++) {
      const note = await db.prepare(
        `SELECT id, title, content, content_hash, rev, updated_at, deleted_at
           FROM notes WHERE id = ?1 AND user_id = ?2`,
      ).bind(candidate.id, userId).first<{
        id: string
        title: string
        content: string
        content_hash: string
        rev: number
        updated_at: number
        deleted_at: number | null
      }>()
      if (!note || note.deleted_at !== null) {
        complete = true
        break
      }
      const content = replaceWikiLinkTarget(note.content, fromTitle, toTitle)
      if (content === note.content) {
        complete = true
        break
      }
      const hash = await sha256Hex(content)
      const { words, chars } = countText(content)
      const now = Math.max(Date.now(), note.updated_at + 1)
      const nextRev = note.rev + 1
      const guard = `EXISTS (SELECT 1 FROM notes
        WHERE id = ?1 AND user_id = ?2 AND rev = ?3
          AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
      const guardValues = [note.id, userId, nextRev, hash, note.title, now] as const
      const statements: D1PreparedStatement[] = [
        db.prepare(
          `UPDATE notes SET content = ?1, excerpt = ?2, word_count = ?3, char_count = ?4,
             content_hash = ?5, rev = ?6, updated_at = ?7
            WHERE id = ?8 AND user_id = ?9 AND rev = ?10 AND content_hash = ?11`,
        ).bind(content, deriveExcerpt(content), words, chars, hash, nextRev, now,
          note.id, userId, note.rev, note.content_hash),
        db.prepare(
          `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${shiftSqlPlaceholders(guard, 7)}`,
        ).bind(newId(), note.id, userId, note.title, note.content,
          utf8ByteLength(note.content), now, ...guardValues),
        db.prepare(
          `DELETE FROM note_versions WHERE note_id = ?1
             AND ${shiftSqlPlaceholders(guard, 1)}
             AND id IN (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`,
        ).bind(note.id, ...guardValues, LIMITS.versionsPerNote),
      ]
      statements.push(...buildNoteDerivedStatements({
        db,
        userId,
        noteId: note.id,
        title: note.title,
        content,
        ftsEnabled,
        expectedRev: nextRev,
        expectedContentHash: hash,
        expectedTitle: note.title,
        expectedUpdatedAt: now,
      }).statements)
      statements.push(noteIndexQueueStatement(db, userId, note.id, 'embed', now))
      statements.push(
        db.prepare(
          `INSERT INTO changes (user_id, entity, entity_id, op, at)
           SELECT ?1, 'note', ?2, 'upsert', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}`,
        ).bind(userId, note.id, now, ...guardValues),
      )
      const [updated] = await db.batch(statements)
      if (updated?.meta.changes) {
        rewritten++
        complete = true
        break
      }
    }
    if (!complete) skipped++
  }
  return { rewritten, skipped }
}

function sameTagSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every((name) => set.has(name))
}

function applyPatchRow(
  row: NoteRow,
  sets: string[],
  binds: unknown[],
  tagNames: string[] | null,
): NoteRow {
  const next: NoteRow = { ...row }
  for (let index = 0; index < sets.length; index++) {
    const column = sets[index]!.split(' ')[0]!
    const value = binds[index]
    switch (column) {
      case 'content':
        next.content = value as string
        break
      case 'content_hash':
        next.content_hash = value as string
        break
      case 'title':
        next.title = value as string
        break
      case 'excerpt':
        next.excerpt = value as string
        break
      case 'word_count':
        next.word_count = value as number
        break
      case 'char_count':
        next.char_count = value as number
        break
      case 'folder_id':
        next.folder_id = value as string | null
        break
      case 'is_pinned':
        next.is_pinned = value as number
        break
      case 'is_starred':
        next.is_starred = value as number
        break
      case 'is_archived':
        next.is_archived = value as number
        break
      case 'updated_at':
        next.updated_at = value as number
        break
      case 'rev':
        next.rev = value as number
        break
      default:
        break
    }
  }
  if (tagNames !== null) next.tag_names = tagNames.join('\u0001')
  return next
}

export function restoredVersionTitle(title: string): string {
  return resolveNoteTitle(title)
}

export function resolveNoteTitle(title: string | undefined, current = ''): string {
  return title === undefined ? current : truncateText(title.trim(), LIMITS.titleMaxLength)
}

export function nextNotesCursor(offset: number, returned: number, total: number): string | null {
  const next = offset + returned
  return returned > 0 && next < total ? String(next) : null
}

export function encodeNotesListCursor(
  row: NoteRow,
  view: ViewKind,
  sort: SortKey,
  order: SortOrder,
): string {
  const value = view === 'trash'
    ? row.deleted_at
    : sort === 'created'
      ? row.created_at
      : sort === 'title'
        ? row.title
        : row.updated_at
  const payload: NotesListCursor = {
    view,
    sort,
    order,
    pinned: view === 'trash' ? 0 : row.is_pinned,
    value: value ?? 0,
    id: row.id,
  }
  return `n1.${toBase64Url(utf8(JSON.stringify(payload)))}`
}

export function parseNotesListCursor(
  raw: string | undefined,
  view: ViewKind,
  sort: SortKey,
  order: SortOrder,
): ParsedNotesListCursor {
  if (!raw) return { kind: 'first' }
  if (/^\d+$/.test(raw)) {
    return { kind: 'legacy', offset: clampInt(raw, 0, 1_000_000, 0) }
  }
  if (raw.length > 4096 || !raw.startsWith('n1.')) throw ApiError.badRequest('Invalid notes cursor')
  try {
    const value = JSON.parse(fromUtf8(fromBase64Url(raw.slice(3)))) as Partial<NotesListCursor>
    const expectedTitle = view !== 'trash' && sort === 'title'
    const validValue = expectedTitle
      ? typeof value.value === 'string' && value.value.length <= LIMITS.titleMaxLength
      : typeof value.value === 'number' && Number.isSafeInteger(value.value) && value.value >= 0
    if (
      value.view !== view ||
      value.sort !== sort ||
      value.order !== order ||
      (value.pinned !== 0 && value.pinned !== 1) ||
      !validValue ||
      typeof value.id !== 'string' ||
      value.id.length < 1 ||
      value.id.length > 128
    ) {
      throw new Error('invalid')
    }
    return { kind: 'keyset', cursor: value as NotesListCursor }
  } catch {
    throw ApiError.badRequest('Invalid notes cursor')
  }
}

function push(sets: string[], binds: unknown[], column: string, value: unknown): void {
  binds.push(value)
  sets.push(`${column} = ?${binds.length}`)
}

function shiftSqlPlaceholders(sql: string, offset: number): string {
  return sql.replace(/\?(\d+)/g, (_match, value: string) => `?${Number(value) + offset}`)
}

async function resolveFolderId(
  db: D1Database,
  userId: string,
  folderId: string | null | undefined,
): Promise<string | null> {
  if (!folderId) return null
  const row = await db
    .prepare(`SELECT id FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`)
    .bind(folderId, userId)
    .first<{ id: string }>()
  if (!row) throw ApiError.badRequest('Folder not found')
  return row.id
}
