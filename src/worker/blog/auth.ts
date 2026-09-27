import { getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import { getMeta, setMeta } from '../db/metadata'
import type { AppBindings } from '../env'
import { newId } from '../lib/id'
import { hashPassword, verifyPassword } from '../lib/password'
import { hasBlogPassword } from './queries'

export const BLOG_SESSION_PREFIX = 'blog_session:'
export const BLOG_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const BLOG_PASSWORD_KEY = (userId: string): string => `blog_password_hash:${userId}`
export const BLOG_TITLE_KEY = (userId: string): string => `blog_title:${userId}`
export const BLOG_SESSION_COOKIE = (userId: string): string => `blog_session_${userId}`

export async function setBlogPassword(db: D1Database, userId: string, password: string): Promise<void> {
  await setMeta(db, BLOG_PASSWORD_KEY(userId), await hashPassword(password))
  await invalidateBlogSessions(db, userId)
}

export async function clearBlogPassword(db: D1Database, userId: string): Promise<void> {
  await setMeta(db, BLOG_PASSWORD_KEY(userId), '')
  await invalidateBlogSessions(db, userId)
}

export async function getBlogPasswordHash(db: D1Database, userId: string): Promise<string> {
  const custom = await getMeta(db, BLOG_PASSWORD_KEY(userId))
  if (custom) return custom
  const row = await db.prepare(`SELECT password_hash FROM users WHERE id = ?1`).bind(userId).first<{ password_hash: string }>()
  if (!row?.password_hash) throw new Error('Account password missing')
  return row.password_hash
}

async function invalidateBlogSessions(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare('DELETE FROM app_meta WHERE key LIKE ?1')
    .bind(`${BLOG_SESSION_PREFIX}${userId}:%`)
    .run()
}

export async function setBlogTitle(db: D1Database, userId: string, title: string): Promise<void> {
  await setMeta(db, BLOG_TITLE_KEY(userId), title)
}

export async function getBlogTitle(db: D1Database, userId: string): Promise<string | null> {
  return getMeta(db, BLOG_TITLE_KEY(userId))
}

export async function handleBlogAuth(
  db: D1Database,
  userId: string,
  password: string,
): Promise<string | null> {
  const stored = await getMeta(db, BLOG_PASSWORD_KEY(userId))
  if (!stored) return null
  if (!(await verifyPassword(password, stored))) return null
  const token = newId()
  await setMeta(db, `${BLOG_SESSION_PREFIX}${userId}:${token}`, String(Date.now() + BLOG_SESSION_TTL_MS))
  return token
}

export async function validateBlogSession(
  db: D1Database,
  userId: string,
  token: string,
): Promise<boolean> {
  const raw = await getMeta(db, `${BLOG_SESSION_PREFIX}${userId}:${token}`)
  if (!raw) return false
  return Number(raw) > Date.now()
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
  if (
    ownerId &&
    (await hasBlogPassword(c.env.DB, ownerId)) &&
    !(token && (await validateBlogSession(c.env.DB, ownerId, token)))
  ) {
    return c.json({ error: { code: 'blog_auth_required', message: 'Blog authentication required' } }, 401)
  }
  await next()
})
