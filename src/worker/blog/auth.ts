import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import { type BlogTagConfig } from '@shared/blog/tags'
import { ACCENTS } from '@shared/constants'
import type { AccentName } from '@shared/types'
import { getMeta } from '../db/metadata'
import type { AppBindings } from '../env'
import { newId } from '../lib/id'
import { hashPassword, verifyPassword } from '../lib/password'
import { getBlogSettings, setBlogPasswordHash, updateBlogSettings, LEGACY_BLOG_SESSION_PREFIX } from './settings'

export const BLOG_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const BLOG_SESSION_COOKIE = (userId: string): string => `blog_session_${userId}`

export async function setBlogPassword(db: D1Database, userId: string, password: string): Promise<void> {
  await setBlogPasswordHash(db, userId, await hashPassword(password))
  await invalidateBlogSessions(db, userId)
}

export async function clearBlogPassword(db: D1Database, userId: string): Promise<void> {
  const row = await db.prepare(`SELECT password_hash FROM users WHERE id = ?1`).bind(userId).first<{ password_hash: string }>()
  if (row?.password_hash) await setBlogPasswordHash(db, userId, row.password_hash)
  await invalidateBlogSessions(db, userId)
}

export async function getBlogPasswordHash(db: D1Database, userId: string): Promise<string> {
  const row = await db
    .prepare(`SELECT password_hash FROM blog_settings WHERE user_id = ?1`)
    .bind(userId)
    .first<{ password_hash: string }>()
  if (row?.password_hash) return row.password_hash
  const custom = await getMeta(db, `blog_password_hash:${userId}`)
  if (custom) return custom
  const account = await db.prepare(`SELECT password_hash FROM users WHERE id = ?1`).bind(userId).first<{ password_hash: string }>()
  if (!account?.password_hash) throw new Error('Account password missing')
  return account.password_hash
}

async function invalidateBlogSessions(db: D1Database, userId: string): Promise<void> {
  await db.prepare(`DELETE FROM blog_sessions WHERE user_id = ?1`).bind(userId).run()
}

export async function clearBlogSession(db: D1Database, userId: string, token: string): Promise<void> {
  await db.prepare(`DELETE FROM blog_sessions WHERE token = ?1 AND user_id = ?2`).bind(token, userId).run()
  // Transitional: drop the pre-v14 key too, so logout works even when the
  // seed has not migrated this session yet.
  await db.prepare(`DELETE FROM app_meta WHERE key = ?1`).bind(`${LEGACY_BLOG_SESSION_PREFIX}${userId}:${token}`).run()
}

export function deleteBlogSessionCookie(c: Context<AppBindings>, userId: string): void {
  deleteCookie(c, BLOG_SESSION_COOKIE(userId), { path: '/' })
}

export async function setBlogTitle(db: D1Database, userId: string, title: string): Promise<void> {
  await updateBlogSettings(db, userId, { title })
}

export async function getBlogTitle(db: D1Database, userId: string): Promise<string | null> {
  const title = (await getBlogSettings(db, userId)).title
  return title === '' ? null : title
}

export async function setBlogDescription(db: D1Database, userId: string, description: string): Promise<void> {
  await updateBlogSettings(db, userId, { description })
}

export async function getBlogDescription(db: D1Database, userId: string): Promise<string | null> {
  const description = (await getBlogSettings(db, userId)).description
  return description === '' ? null : description
}

export async function getBlogPublicTag(db: D1Database, userId: string): Promise<string> {
  return (await getBlogSettings(db, userId)).publicTag
}

export async function setBlogPublicTag(db: D1Database, userId: string, tag: string): Promise<void> {
  await updateBlogSettings(db, userId, { publicTag: tag })
}

export async function getBlogPrivateTag(db: D1Database, userId: string): Promise<string> {
  return (await getBlogSettings(db, userId)).privateTag
}

export async function setBlogPrivateTag(db: D1Database, userId: string, tag: string): Promise<void> {
  await updateBlogSettings(db, userId, { privateTag: tag })
}

export async function getBlogTagConfig(db: D1Database, userId: string): Promise<BlogTagConfig> {
  const [publicTag, privateTag] = await Promise.all([
    getBlogPublicTag(db, userId),
    getBlogPrivateTag(db, userId),
  ])
  return { publicTag, privateTag }
}

const BLOG_ACCENT_NAMES = new Set<string>(ACCENTS.map((accent) => accent.name))

/**
 * The blog owner's Appearance accent, regardless of visitor login state.
 * Falls back to 'cinnabar' when unset or unrecognized.
 */
export async function getBlogAccent(db: D1Database, userId: string): Promise<AccentName> {
  try {
    const row = await db
      .prepare(`SELECT settings FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ settings: string | null }>()
    if (!row?.settings) return 'cinnabar'
    const parsed: unknown = JSON.parse(row.settings)
    const accent = (parsed as { appearance?: { accent?: unknown } } | null)?.appearance?.accent
    if (typeof accent === 'string' && BLOG_ACCENT_NAMES.has(accent)) {
      return accent as AccentName
    }
  } catch {
    // fall through to default
  }
  return 'cinnabar'
}

export async function handleBlogAuth(
  db: D1Database,
  userId: string,
  password: string,
): Promise<string | null> {
  try {
    const stored = await getBlogPasswordHash(db, userId)
    if (!(await verifyPassword(password, stored))) return null
  } catch {
    return null
  }
  const token = newId()
  const now = Date.now()
  await db
    .prepare(`INSERT INTO blog_sessions (token, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(token, userId, now + BLOG_SESSION_TTL_MS, now)
    .run()
  return token
}

export async function validateBlogSession(
  db: D1Database,
  userId: string,
  token: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT expires_at FROM blog_sessions WHERE token = ?1 AND user_id = ?2`)
    .bind(token, userId)
    .first<{ expires_at: number }>()
  if (row) {
    if (row.expires_at > Date.now()) return true
    // A: lazily delete expired sessions on access.
    await db.prepare(`DELETE FROM blog_sessions WHERE token = ?1 AND user_id = ?2`).bind(token, userId).run()
    return false
  }
  // Transitional read for sessions created before the v14 seed ran.
  const legacy = await getMeta(db, `${LEGACY_BLOG_SESSION_PREFIX}${userId}:${token}`)
  if (!legacy) return false
  if (Number(legacy) <= Date.now()) {
    await db.prepare(`DELETE FROM app_meta WHERE key = ?1`).bind(`${LEGACY_BLOG_SESSION_PREFIX}${userId}:${token}`).run()
    return false
  }
  return true
}

export function setBlogSessionCookie(c: Context<AppBindings>, userId: string, token: string): void {
  setCookie(c, BLOG_SESSION_COOKIE(userId), token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    secure: new URL(c.req.url).protocol === 'https:',
    maxAge: Math.floor(BLOG_SESSION_TTL_MS / 1000),
  })
}

export const blogAuthMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  const ownerId = c.get('blogOwnerId')
  const token = ownerId ? getCookie(c, BLOG_SESSION_COOKIE(ownerId)) : undefined
  const authed = Boolean(ownerId && token && (await validateBlogSession(c.env.DB, ownerId, token)))
  c.set('blogAuthed', authed)
  await next()
})
