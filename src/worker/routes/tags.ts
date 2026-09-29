import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import { countText, deriveExcerpt, replaceTagInContent } from '@shared/markdown-utils'
import { organizerColorOrNull } from '@shared/organizer-colors'
import { utf8ByteLength } from '@shared/text-utils'
import type { AppBindings } from '../env'
import { toTag, type TagRow } from '../db/rows'
import { buildNoteDerivedStatements } from '../db/writes'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { broadcastCursor, scheduleFtsDrain } from '../lib/notify'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'

export const tagsRoutes = new Hono<AppBindings>()

tagsRoutes.use('*', requireAuth)

const TAG_SELECT = `t.id, t.name, t.color, t.created_at,
  (SELECT COUNT(*) FROM note_tags nt JOIN notes n ON n.id = nt.note_id
    WHERE nt.tag_id = t.id AND n.user_id = t.user_id
      AND n.deleted_at IS NULL AND n.is_archived = 0) AS note_count`

tagsRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ${TAG_SELECT} FROM tags t
     WHERE t.user_id = ?1 ORDER BY t.name COLLATE NOCASE ASC`,
  )
    .bind(c.get('userId'))
    .all<TagRow>()
  return c.json({ tags: results.map(toTag) })
})

tagsRoutes.post('/', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<{ id?: string; name?: string; color?: string | null }>(
    c,
    JSON_BODY_LIMITS.small,
  )
  if (typeof body.name !== 'string') throw ApiError.badRequest('name must be a string')
  if (body.id !== undefined && !isValidId(body.id)) {
    throw ApiError.badRequest('id must be a valid tag id')
  }
  if (body.color !== undefined && body.color !== null && !organizerColorOrNull(body.color)) {
    throw ApiError.badRequest('Tag color is not supported')
  }
  const name = body.name.trim().replace(/^#+/, '')
  if (!name) throw ApiError.badRequest('Tag name cannot be empty')
  if (name.length > LIMITS.tagNameMaxLength) throw ApiError.badRequest('Tag name is too long')
  if (/[\s#]/.test(name)) throw ApiError.badRequest('Tag names cannot contain spaces or #')

  const id = body.id ?? newId()
  if (body.id) {
    const existing = await loadTag(c.env.DB, userId, id)
    if (existing) return c.json(existing)
    const collision = await c.env.DB.prepare(`SELECT user_id FROM tags WHERE id = ?1`)
      .bind(id)
      .first<{ user_id: string }>()
    if (collision) throw ApiError.conflict('This tag id is already in use')
  }
  const duplicate = await c.env.DB.prepare(
    `SELECT id FROM tags WHERE user_id = ?1 AND name = ?2 COLLATE NOCASE LIMIT 1`,
  ).bind(userId, name).first<{ id: string }>()
  if (duplicate) throw ApiError.conflict('A tag with this name already exists')

  const now = Date.now()
  const insert = c.env.DB.prepare(
    `INSERT INTO tags (id, user_id, name, color, is_manual, created_at)
     VALUES (?1, ?2, ?3, ?4, 1, ?5)`,
  ).bind(id, userId, name, organizerColorOrNull(body.color), now)
  const change = c.env.DB.prepare(
    `INSERT INTO changes (user_id, entity, entity_id, op, at)
     SELECT ?1, 'tag', ?2, 'upsert', ?3
      WHERE EXISTS (SELECT 1 FROM tags WHERE id = ?2 AND user_id = ?1)`,
  ).bind(userId, id, now)
  const [created] = await c.env.DB.batch([insert, change])
  if (!created?.meta.changes) throw ApiError.conflict('A tag with this name already exists')
  await broadcastCursor(c)
  return c.json((await loadTag(c.env.DB, userId, id))!, 201)
})

tagsRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const body = await readJson<{ name?: string; color?: string | null }>(c, JSON_BODY_LIMITS.small)

  const tag = await c.env.DB.prepare(`SELECT id, name, color FROM tags WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<{ id: string; name: string; color: string | null }>()
  if (!tag) throw ApiError.notFound('Tag not found')

  if (body.color !== undefined && body.color !== null && typeof body.color !== 'string') {
    throw ApiError.badRequest('color must be a string or null')
  }
  if (typeof body.color === 'string' && !/^#[0-9a-f]{6}$/i.test(body.color)) {
    throw ApiError.badRequest('color must be a six-digit hexadecimal color')
  }
  if (body.name !== undefined && typeof body.name !== 'string') {
    throw ApiError.badRequest('name must be a string')
  }

  const color = body.color === undefined ? tag.color : body.color

  if (typeof body.name === 'string') {
    const next = body.name.trim().replace(/^#+/, '')
    if (!next) throw ApiError.badRequest('Tag name cannot be empty')
    if (next.length > LIMITS.tagNameMaxLength) throw ApiError.badRequest('Tag name is too long')
    if (/[\s#]/.test(next)) throw ApiError.badRequest('Tag names cannot contain spaces or #')

    if (next !== tag.name) {
      const existing = await c.env.DB.prepare(
        `SELECT id, name FROM tags
          WHERE user_id = ?1 AND id <> ?2 AND name = ?3 COLLATE NOCASE
          ORDER BY created_at ASC, id ASC LIMIT 1`,
      ).bind(userId, id, next).first<{ id: string; name: string }>()
      const destinationName = existing?.name ?? next
      const rewrite = await rewriteTagInNotes(c.env, c.get('database').ftsEnabled, userId, id, tag.name, destinationName)
      const now = Date.now()
      const rewrittenDestination = await c.env.DB.prepare(
        `SELECT id FROM tags WHERE user_id = ?1 AND name = ?2 COLLATE NOCASE
          ORDER BY created_at ASC, id ASC LIMIT 1`,
      ).bind(userId, destinationName).first<{ id: string }>()
      if (rewrittenDestination?.id === id) {
        const explicitColor = body.color !== undefined ? 1 : 0
        try {
          const [updated] = await c.env.DB.batch([
            c.env.DB.prepare(
              `UPDATE tags SET name = ?4,
                 color = CASE WHEN ?5 = 1 THEN ?6 ELSE color END,
                 is_manual = 1
                WHERE id = ?1 AND user_id = ?2 AND name = ?3`,
            ).bind(id, userId, tag.name, destinationName, explicitColor, color),
            c.env.DB.prepare(
              `INSERT INTO changes (user_id, entity, entity_id, op, at)
               SELECT ?2, 'tag', ?1, 'upsert', ?4
                WHERE EXISTS (SELECT 1 FROM tags
                  WHERE id = ?1 AND user_id = ?2 AND name = ?5)`,
            ).bind(id, userId, tag.name, now, destinationName),
          ])
          if (!updated?.meta.changes) {
            throw ApiError.conflict('The tag changed elsewhere. Refresh and try again')
          }
        } catch (error) {
          try {
            await rewrite.rollback()
          } catch {
            throw ApiError.conflict('Tag rename could not be rolled back safely; refresh and try again')
          }
          throw error
        }
        await broadcastCursor(c)
        scheduleFtsDrain(c)
        return c.json({ ok: true, renamed: rewrite.rewritten })
      }
      const targetId = newId()
      const explicitColor = body.color !== undefined ? 1 : 0
      const sourceGuard = `EXISTS (SELECT 1 FROM tags
        WHERE id = ?1 AND user_id = ?2 AND name = ?3)`
      const statements = [
        c.env.DB.prepare(
          `INSERT INTO tags (id, user_id, name, color, is_manual, created_at)
           SELECT ?4, ?2, ?5,
                  CASE WHEN ?6 = 1 THEN ?7 ELSE source.color END,
                  1, ?8
             FROM tags source
            WHERE source.id = ?1 AND source.user_id = ?2 AND source.name = ?3
           ON CONFLICT(user_id, name) DO UPDATE SET
             color = CASE WHEN ?6 = 1 THEN ?7 ELSE COALESCE(tags.color, excluded.color) END,
             is_manual = 1`,
        ).bind(id, userId, tag.name, targetId, destinationName, explicitColor, color, now),
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO note_tags (note_id, tag_id)
           SELECT nt.note_id, target.id
             FROM note_tags nt
             JOIN tags target ON target.user_id = ?2 AND target.name = ?4
            WHERE nt.tag_id = ?1 AND ${sourceGuard}`,
        ).bind(id, userId, tag.name, destinationName),
        c.env.DB.prepare(`DELETE FROM note_tags WHERE tag_id = ?1 AND ${sourceGuard}`)
          .bind(id, userId, tag.name),
        c.env.DB.prepare(
          `INSERT INTO changes (user_id, entity, entity_id, op, at)
           SELECT ?2, 'tag', target.id, 'upsert', ?4
             FROM tags target WHERE target.user_id = ?2 AND target.name = ?5 AND ${sourceGuard}`,
        ).bind(id, userId, tag.name, now, destinationName),
        c.env.DB.prepare(
          `INSERT INTO changes (user_id, entity, entity_id, op, at)
           SELECT ?2, 'tag', ?1, 'delete', ?4 WHERE ${sourceGuard}`,
        ).bind(id, userId, tag.name, now),
        c.env.DB.prepare(`DELETE FROM tags WHERE id = ?1 AND user_id = ?2 AND name = ?3`)
          .bind(id, userId, tag.name),
      ]
      try {
        const results = await c.env.DB.batch(statements)
        if (!results.at(-1)?.meta.changes) {
          throw ApiError.conflict('The tag changed elsewhere. Refresh and try again')
        }
      } catch (error) {
        try {
          await rewrite.rollback()
        } catch {
          throw ApiError.conflict('Tag rename could not be rolled back safely; refresh and try again')
        }
        throw error
      }
      await broadcastCursor(c)
      scheduleFtsDrain(c)
      return c.json({ ok: true, renamed: rewrite.rewritten })
    }
  }

  if (color !== tag.color) {
    const now = Date.now()
    const update = c.env.DB.prepare(
      `UPDATE tags SET color = ?1, is_manual = 1
        WHERE id = ?2 AND user_id = ?3 AND name = ?4 AND color IS ?5`,
    ).bind(color, id, userId, tag.name, tag.color)
    const change = c.env.DB.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'tag', ?2, 'upsert', ?3
        WHERE EXISTS (SELECT 1 FROM tags WHERE id = ?2 AND user_id = ?1 AND color IS ?4)`,
    ).bind(userId, id, now, color)
    const [updated] = await c.env.DB.batch([update, change])
    if (!updated?.meta.changes) throw ApiError.conflict('The tag changed elsewhere. Refresh and try again')
    await broadcastCursor(c)
  }
  const row = await c.env.DB.prepare(
    `SELECT ${TAG_SELECT} FROM tags t
     WHERE t.id = ?2 AND t.user_id = ?1`,
  )
    .bind(userId, id)
    .first<TagRow>()
  return c.json(row ? toTag(row) : { ok: true })
})

tagsRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')

  const tag = await c.env.DB.prepare(`SELECT id, name FROM tags WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<{ id: string; name: string }>()
  if (!tag) throw ApiError.notFound('Tag not found')

  const rewrite = await rewriteTagInNotes(c.env, c.get('database').ftsEnabled, userId, id, tag.name, null)

  const now = Date.now()
  const guard = `EXISTS (SELECT 1 FROM tags WHERE id = ?1 AND user_id = ?2 AND name = ?3)`
  const statements = [
    c.env.DB.prepare(`DELETE FROM note_tags WHERE tag_id = ?1 AND ${guard}`)
      .bind(id, userId, tag.name),
    c.env.DB.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?2, 'tag', ?1, 'delete', ?4 WHERE ${guard}`,
    ).bind(id, userId, tag.name, now),
    c.env.DB.prepare(`DELETE FROM tags WHERE id = ?1 AND user_id = ?2 AND name = ?3`)
      .bind(id, userId, tag.name),
  ]
  try {
    const outcomes = await c.env.DB.batch(statements)
    if (!outcomes.at(-1)?.meta.changes) {
      throw ApiError.conflict('The tag changed elsewhere. Refresh and try again')
    }
  } catch (error) {
    try {
      await rewrite.rollback()
    } catch {
      throw ApiError.conflict('Tag deletion could not be rolled back safely; refresh and try again')
    }
    throw error
  }
  await broadcastCursor(c)
  scheduleFtsDrain(c)
  return c.json({ ok: true, affected: rewrite.rewritten })
})

async function loadTag(
  db: D1Database,
  userId: string,
  id: string,
): Promise<ReturnType<typeof toTag> | null> {
  const row = await db.prepare(
    `SELECT ${TAG_SELECT} FROM tags t
     WHERE t.id = ?2 AND t.user_id = ?1`,
  ).bind(userId, id).first<TagRow>()
  return row ? toTag(row) : null
}

interface TagRewriteResult {
  rewritten: number
  rollback: () => Promise<void>
}

export async function rewriteTagInNotes(
  env: AppBindings['Bindings'],
  ftsEnabled: boolean,
  userId: string,
  tagId: string,
  from: string,
  to: string | null,
): Promise<TagRewriteResult> {
  const { results } = await env.DB.prepare(
    `SELECT n.id FROM notes n
       JOIN note_tags nt ON nt.note_id = n.id
      WHERE nt.tag_id = ?1 AND n.user_id = ?2`,
  )
    .bind(tagId, userId)
    .all<{ id: string }>()

  let rewritten = 0
  const rewrittenNotes: RewrittenTagNote[] = []
  try {
    for (const candidate of results) {
    let complete = false
    for (let attempt = 0; attempt < 5; attempt++) {
      const note = await env.DB.prepare(
        `SELECT id, title, content, rev, updated_at, deleted_at
           FROM notes WHERE id = ?1 AND user_id = ?2`,
      )
        .bind(candidate.id, userId)
        .first<{
          id: string
          title: string
          content: string
          rev: number
          updated_at: number
          deleted_at: number | null
        }>()
      if (!note) {
        complete = true
        break
      }
      const content = replaceTagInContent(note.content, from, to)
      if (content === note.content) {
        complete = true
        break
      }

      const title = note.title
      const { words, chars } = countText(content)
      const hash = await sha256Hex(content)
      const now = Math.max(Date.now(), note.updated_at + 1)
      const nextRev = note.rev + 1
      const mutationGuard = `EXISTS (SELECT 1 FROM notes
        WHERE id = ?1 AND user_id = ?2 AND rev = ?3
          AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
      const mutationValues = [note.id, userId, nextRev, hash, title, now] as const
      const update = env.DB.prepare(
        `UPDATE notes SET title = ?1, content = ?2, excerpt = ?3, word_count = ?4, char_count = ?5,
           content_hash = ?6, rev = ?7, updated_at = ?8
          WHERE id = ?9 AND user_id = ?10 AND rev = ?11`,
      ).bind(
        title,
        content,
        deriveExcerpt(content),
        words,
        chars,
        hash,
        nextRev,
        now,
        note.id,
        userId,
        note.rev,
      )
      const snapshot = env.DB.prepare(
        `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
          WHERE ${shiftSqlPlaceholders(mutationGuard, 7)}`,
      ).bind(
        newId(),
        note.id,
        userId,
        note.title,
        note.content,
        utf8ByteLength(note.content),
        now,
        ...mutationValues,
      )
      const trim = env.DB.prepare(
        `DELETE FROM note_versions WHERE note_id = ?1
           AND ${shiftSqlPlaceholders(mutationGuard, 1)}
           AND id IN (
             SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`,
      ).bind(note.id, ...mutationValues, LIMITS.versionsPerNote)
      const statements: D1PreparedStatement[] = [update, snapshot, trim]
      if (note.deleted_at === null) {
        statements.push(...buildNoteDerivedStatements({
          db: env.DB,
          userId,
          noteId: note.id,
          title,
          content,
          ftsEnabled,
          titleChanged: title !== note.title,
          previousTitle: note.title,
          expectedRev: nextRev,
          expectedContentHash: hash,
          expectedTitle: title,
          expectedUpdatedAt: now,
        }).statements)
      }
      statements.push(
        env.DB.prepare(
          `INSERT INTO changes (user_id, entity, entity_id, op, at)
           SELECT ?1, 'note', ?2, 'upsert', ?3
            WHERE ${shiftSqlPlaceholders(mutationGuard, 3)}`,
        ).bind(userId, note.id, now, ...mutationValues),
      )
      const [updated] = await env.DB.batch(statements)
      if (updated?.meta.changes) {
        rewritten++
        rewrittenNotes.push({ note, nextRev, updatedAt: now })
        complete = true
        break
      }
    }
    if (!complete) {
      throw ApiError.conflict(`Some notes are still being edited. Safely completed ${rewritten} notes; try again later`)
    }
  }
    return {
      rewritten,
      rollback: () => rollbackTagRewrites(env, ftsEnabled, userId, rewrittenNotes),
    }
  } catch (error) {
    try {
      await rollbackTagRewrites(env, ftsEnabled, userId, rewrittenNotes)
    } catch {
      throw ApiError.conflict('Tag rename could not be rolled back safely; refresh and try again')
    }
    throw error
  }
}

interface RewrittenTagNote {
  note: {
    id: string
    title: string
    content: string
    rev: number
    updated_at: number
    deleted_at: number | null
  }
  nextRev: number
  updatedAt: number
}

async function rollbackTagRewrites(
  env: AppBindings['Bindings'],
  ftsEnabled: boolean,
  userId: string,
  rewrittenNotes: readonly RewrittenTagNote[],
): Promise<void> {
  for (const rewritten of [...rewrittenNotes].reverse()) {
    const { note, nextRev, updatedAt } = rewritten
    const hash = await sha256Hex(note.content)
    const { words, chars } = countText(note.content)
    const update = env.DB.prepare(
      `UPDATE notes SET content = ?1, excerpt = ?2, word_count = ?3, char_count = ?4,
         content_hash = ?5, rev = ?6, updated_at = ?7
        WHERE id = ?8 AND user_id = ?9 AND rev = ?10 AND updated_at = ?11`,
    ).bind(
      note.content,
      deriveExcerpt(note.content),
      words,
      chars,
      hash,
      note.rev,
      note.updated_at,
      note.id,
      userId,
      nextRev,
      updatedAt,
    )
    const statements: D1PreparedStatement[] = [update]
    if (note.deleted_at === null) {
      statements.push(...buildNoteDerivedStatements({
        db: env.DB,
        userId,
        noteId: note.id,
        title: note.title,
        content: note.content,
        ftsEnabled,
        expectedRev: note.rev,
        expectedContentHash: hash,
        expectedTitle: note.title,
        expectedUpdatedAt: note.updated_at,
      }).statements)
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?1, 'note', ?2, 'upsert', ?3
          WHERE EXISTS (SELECT 1 FROM notes
            WHERE id = ?2 AND user_id = ?1 AND rev = ?4 AND updated_at = ?5)`,
      ).bind(userId, note.id, Date.now(), note.rev, note.updated_at),
    )
    const [restored] = await env.DB.batch(statements)
    if (!restored?.meta.changes) throw new Error('tag rewrite rollback conflict')
  }
}

function shiftSqlPlaceholders(sql: string, offset: number): string {
  return sql.replace(/\?(\d+)/g, (_match, value: string) => `?${Number(value) + offset}`)
}
