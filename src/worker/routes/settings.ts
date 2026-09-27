import { Hono } from 'hono'
import { mergeSettings, mergeSettingsPatch } from '@shared/constants'
import type { UserSettings } from '@shared/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { commitChange } from '../lib/notify'
import { setAllowRegistration } from '../lib/instance-settings'
import { requireCurrentPassword } from '../lib/reauth'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'

export const settingsRoutes = new Hono<AppBindings>()

settingsRoutes.use('*', requireAuth)


settingsRoutes.put('/registration', async (c) => {
  const user = c.get('user')
  if (user.role !== 'owner') throw ApiError.forbidden('Only the owner can change this setting')
  const body = await readJson<{ enabled?: boolean; password?: string }>(c, 4096)
  if (typeof body.enabled !== 'boolean') throw ApiError.badRequest('Missing enabled parameter')
  await requireCurrentPassword(c.env.DB, user.id, body.password)
  await setAllowRegistration(c.env.DB, body.enabled)
  await commitChange(c, 'site', user.id, 'upsert')
  return c.json({ ok: true, registrationOpen: body.enabled })
})

settingsRoutes.get('/', (c) => {
  const user = c.get('user')
  return c.json(mergeSettings(parse(user.settingsRaw)))
})

settingsRoutes.put('/', async (c) => {
  const userId = c.get('userId')
  const incoming = await readJson<Partial<UserSettings>>(c, JSON_BODY_LIMITS.settings)
  let previousRaw = c.get('user').settingsRaw
  for (let attempt = 0; attempt < 5; attempt++) {

    const merged = mergeSettingsPatch(parse(previousRaw), incoming)
    const nextRaw = JSON.stringify(merged)
    const updated = await c.env.DB.prepare(
      `UPDATE users SET settings = ?1 WHERE id = ?2 AND settings = ?3`,
    )
      .bind(nextRaw, userId, previousRaw)
      .run()
    if (updated.meta.changes) {
      await commitChange(c, 'settings', userId, 'upsert')
      return c.json(merged)
    }
    const latest = await c.env.DB.prepare(`SELECT settings FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ settings: string }>()
    if (!latest) throw ApiError.unauthenticated()
    previousRaw = latest.settings
  }
  throw new ApiError(409, 'conflict', 'Settings keep changing elsewhere. Try again shortly')
})


settingsRoutes.get('/stats', async (c) => {
  const userId = c.get('userId')
  const row = await c.env.DB.prepare(
    `SELECT note_stats.*, attachment_stats.*,
       (SELECT COUNT(*) FROM folders WHERE user_id = ?1 AND deleted_at IS NULL) AS folders,
       (SELECT COUNT(*) FROM tags WHERE user_id = ?1) AS tags,
       (SELECT COUNT(*) FROM note_versions WHERE user_id = ?1) AS versions,
       (SELECT COUNT(*) FROM links WHERE user_id = ?1) AS links
     FROM (
       SELECT COUNT(CASE WHEN deleted_at IS NULL THEN 1 END) AS notes,
              COUNT(deleted_at) AS trashed,
              COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN char_count ELSE 0 END), 0) AS chars,
              COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN word_count ELSE 0 END), 0) AS words
         FROM notes WHERE user_id = ?1
     ) note_stats CROSS JOIN (
       SELECT COUNT(*) AS attachments, COALESCE(SUM(size), 0) AS attachmentBytes
         FROM attachments WHERE user_id = ?1
     ) attachment_stats`,
  )
    .bind(userId)
    .first<Record<string, number>>()

  return c.json({
    notes: row?.notes ?? 0,
    trashed: row?.trashed ?? 0,
    folders: row?.folders ?? 0,
    tags: row?.tags ?? 0,
    attachments: row?.attachments ?? 0,
    attachmentBytes: row?.attachmentBytes ?? 0,
    chars: row?.chars ?? 0,
    words: row?.words ?? 0,
    versions: row?.versions ?? 0,
    links: row?.links ?? 0,
  })
})

function parse(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
