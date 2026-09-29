import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import { BLOG_PRIVATE_TAG, BLOG_PUBLIC_TAG, type BlogTagConfig } from '@shared/blog/tags'
import { getMeta, setMeta } from '../db/metadata'
import type { AppBindings } from '../env'
import { newId } from '../lib/id'
import { hashPassword, verifyPassword } from '../lib/password'

export const BLOG_SESSION_PREFIX = 'blog_session:'
export const BLOG_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const BLOG_PASSWORD_KEY = (userId: string): string => `blog_password_hash:${userId}`
export const BLOG_TITLE_KEY = (userId: string): string => `blog_title:${userId}`
export const BLOG_DESCRIPTION_KEY = (userId: string): string => `blog_description:${userId}`
export const BLOG_PUBLIC_TAG_KEY = (userId: string): string => `blog_public_tag:${userId}`
export const BLOG_PRIVATE_TAG_KEY = (userId: string): string => `blog_private_tag:${userId}`
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

export async function clearBlogSession(db: D1Database, userId: string, token: string): Promise<void> {
  await db
    .prepare('DELETE FROM app_meta WHERE key = ?1')
    .bind(`${BLOG_SESSION_PREFIX}${userId}:${token}`)
    .run()
}

export function deleteBlogSessionCookie(c: Context<AppBindings>, userId: string): void {
  deleteCookie(c, BLOG_SESSION_COOKIE(userId), { path: '/' })
}

export async function setBlogTitle(db: D1Database, userId: string, title: string): Promise<void> {
  await setMeta(db, BLOG_TITLE_KEY(userId), title)
}

export async function getBlogTitle(db: D1Database, userId: string): Promise<string | null> {
  return getMeta(db, BLOG_TITLE_KEY(userId))
}

export async function setBlogDescription(db: D1Database, userId: string, description: string): Promise<void> {
  await setMeta(db, BLOG_DESCRIPTION_KEY(userId), description)
}

export async function getBlogDescription(db: D1Database, userId: string): Promise<string | null> {
  return getMeta(db, BLOG_DESCRIPTION_KEY(userId))
}

export async function getBlogPublicTag(db: D1Database, userId: string): Promise<string> {
  return (await getMeta(db, BLOG_PUBLIC_TAG_KEY(userId))) || BLOG_PUBLIC_TAG
}

export async function setBlogPublicTag(db: D1Database, userId: string, tag: string): Promise<void> {
  await setMeta(db, BLOG_PUBLIC_TAG_KEY(userId), tag)
}

export async function getBlogPrivateTag(db: D1Database, userId: string): Promise<string> {
  return (await getMeta(db, BLOG_PRIVATE_TAG_KEY(userId))) || BLOG_PRIVATE_TAG
}

export async function setBlogPrivateTag(db: D1Database, userId: string, tag: string): Promise<void> {
  await setMeta(db, BLOG_PRIVATE_TAG_KEY(userId), tag)
}

export async function getBlogTagConfig(db: D1Database, userId: string): Promise<BlogTagConfig> {
  const [publicTag, privateTag] = await Promise.all([
    getBlogPublicTag(db, userId),
    getBlogPrivateTag(db, userId),
  ])
  return { publicTag, privateTag }
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
  const authed = Boolean(ownerId && token && (await validateBlogSession(c.env.DB, ownerId, token)))
  c.set('blogAuthed', authed)
  await next()
})
