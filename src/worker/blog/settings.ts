import { BLOG_PRIVATE_TAG, BLOG_PUBLIC_TAG, MOMENT_PRIVATE_TAG, MOMENT_PUBLIC_TAG } from '@shared/blog/tags'
import { getMeta } from '../db/metadata'

export interface BlogSettings {
  title: string
  description: string
  publicTag: string
  privateTag: string
  momentsPublicTag: string
  momentsPrivateTag: string
}

const BLOG_TITLE_KEY = (userId: string): string => `blog_title:${userId}`
const BLOG_DESCRIPTION_KEY = (userId: string): string => `blog_description:${userId}`
const BLOG_PUBLIC_TAG_KEY = (userId: string): string => `blog_public_tag:${userId}`
const BLOG_PRIVATE_TAG_KEY = (userId: string): string => `blog_private_tag:${userId}`

/** Legacy app_meta session key format, kept for seed + transitional reads. */
export const LEGACY_BLOG_SESSION_PREFIX = 'blog_session:'

interface BlogSettingsRow {
  title: string
  description: string
  public_tag: string
  private_tag: string
  moments_public_tag: string | null
  moments_private_tag: string | null
}

/**
 * Partial update of blog_settings, creating the row when the user was
 * created after the seed marker. Only touched columns move.
 */
export async function updateBlogSettings(
  db: D1Database,
  userId: string,
  patch: Partial<Pick<BlogSettings, 'title' | 'description' | 'publicTag' | 'privateTag' | 'momentsPublicTag' | 'momentsPrivateTag'>>,
): Promise<void> {
  const now = Date.now()
  const current = await getBlogSettings(db, userId)
  await db
    .prepare(
      `INSERT INTO blog_settings
        (user_id, title, description, password_hash, public_tag, private_tag, moments_public_tag, moments_private_tag, created_at, updated_at)
        VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(user_id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          public_tag = excluded.public_tag,
          private_tag = excluded.private_tag,
          moments_public_tag = excluded.moments_public_tag,
          moments_private_tag = excluded.moments_private_tag,
          updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      patch.title ?? current.title,
      patch.description ?? current.description,
      patch.publicTag ?? current.publicTag,
      patch.privateTag ?? current.privateTag,
      patch.momentsPublicTag ?? current.momentsPublicTag,
      patch.momentsPrivateTag ?? current.momentsPrivateTag,
      now,
      now,
    )
    .run()
}

export async function setBlogPasswordHash(db: D1Database, userId: string, passwordHash: string): Promise<void> {
  const now = Date.now()
  const current = await getBlogSettings(db, userId)
  await db
    .prepare(
      `INSERT INTO blog_settings
        (user_id, title, description, password_hash, public_tag, private_tag, moments_public_tag, moments_private_tag, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
    )
    .bind(userId, current.title, current.description, passwordHash, current.publicTag, current.privateTag, current.momentsPublicTag, current.momentsPrivateTag, now, now)
    .run()
}

/**
 * Follows an account password rotation in blog_settings, but only when the
 * blog was tracking the account password (a custom password is untouched).
 */
export async function trackAccountPasswordChange(
  db: D1Database,
  userId: string,
  oldHash: string,
  newHash: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE blog_settings SET password_hash = ?1, updated_at = ?2
        WHERE user_id = ?3 AND password_hash = ?4`,
    )
    .bind(newHash, Date.now(), userId, oldHash)
    .run()
}

/**
 * Reads blog_settings, falling back to the app_meta era keys while writers
 * still target app_meta. The table is the source of truth whenever its row
 * exists.
 */
export async function getBlogSettings(db: D1Database, userId: string): Promise<BlogSettings> {
  const row = await db
    .prepare(
      `SELECT title, description, public_tag, private_tag, moments_public_tag, moments_private_tag
         FROM blog_settings WHERE user_id = ?1`,
    )
    .bind(userId)
    .first<BlogSettingsRow>()
  if (row) {
    return {
      title: row.title,
      description: row.description,
      publicTag: row.public_tag,
      privateTag: row.private_tag,
      momentsPublicTag: row.moments_public_tag ?? MOMENT_PUBLIC_TAG,
      momentsPrivateTag: row.moments_private_tag ?? MOMENT_PRIVATE_TAG,
    }
  }
  const [title, description, publicTag, privateTag] = await Promise.all([
    getMeta(db, BLOG_TITLE_KEY(userId)),
    getMeta(db, BLOG_DESCRIPTION_KEY(userId)),
    getMeta(db, BLOG_PUBLIC_TAG_KEY(userId)),
    getMeta(db, BLOG_PRIVATE_TAG_KEY(userId)),
  ])
  return {
    title: title ?? '',
    description: description ?? '',
    publicTag: publicTag || BLOG_PUBLIC_TAG,
    privateTag: privateTag || BLOG_PRIVATE_TAG,
    momentsPublicTag: MOMENT_PUBLIC_TAG,
    momentsPrivateTag: MOMENT_PRIVATE_TAG,
  }
}
