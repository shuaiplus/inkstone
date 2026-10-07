import { BLOG_PRIVATE_TAG, BLOG_PUBLIC_TAG, MOMENTS_TAG, PINNED_TAG } from '@shared/blog/tags'
import { getMeta } from '../db/metadata'

export interface BlogSettings {
  title: string
  description: string
  publicTag: string
  privateTag: string
  momentsTag: string
  pinnedTag: string
}

export interface BlogTagConfigPatch {
  publicTag?: string
  privateTag?: string
  momentsTag?: string
  pinnedTag?: string
}

const DEFAULT_TAG_CONFIG = {
  publicTag: BLOG_PUBLIC_TAG,
  privateTag: BLOG_PRIVATE_TAG,
  momentsTag: MOMENTS_TAG,
  pinnedTag: PINNED_TAG,
} as const

const BLOG_TITLE_KEY = (userId: string): string => `blog_title:${userId}`
const BLOG_DESCRIPTION_KEY = (userId: string): string => `blog_description:${userId}`
const BLOG_PUBLIC_TAG_KEY = (userId: string): string => `blog_public_tag:${userId}`
const BLOG_PRIVATE_TAG_KEY = (userId: string): string => `blog_private_tag:${userId}`

/** Legacy app_meta session key format, kept for seed + transitional reads. */
export const LEGACY_BLOG_SESSION_PREFIX = 'blog_session:'

interface BlogSettingsRow {
  title: string
  description: string
  settings_json: string
}

function parseTagConfig(raw: string | null): Pick<BlogSettings, 'publicTag' | 'privateTag' | 'momentsTag' | 'pinnedTag'> {
  let parsed: BlogTagConfigPatch = {}
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw)
      if (value && typeof value === 'object') parsed = value as BlogTagConfigPatch
    } catch {
      // Corrupt JSON falls back to defaults below.
    }
  }
  const pick = (key: keyof BlogTagConfigPatch, fallback: string): string => {
    const v = parsed[key]
    return typeof v === 'string' && v ? v : fallback
  }
  return {
    publicTag: pick('publicTag', DEFAULT_TAG_CONFIG.publicTag),
    privateTag: pick('privateTag', DEFAULT_TAG_CONFIG.privateTag),
    momentsTag: pick('momentsTag', DEFAULT_TAG_CONFIG.momentsTag),
    pinnedTag: pick('pinnedTag', DEFAULT_TAG_CONFIG.pinnedTag),
  }
}

/**
 * Partial update of blog_settings, creating the row when the user was
 * created after the seed marker. Only touched columns move.
 */
export async function updateBlogSettings(
  db: D1Database,
  userId: string,
  patch: Partial<Pick<BlogSettings, 'title' | 'description' | 'publicTag' | 'privateTag' | 'momentsTag' | 'pinnedTag'>>,
): Promise<void> {
  const now = Date.now()
  const current = await getBlogSettings(db, userId)
  const next: BlogSettings = {
    title: patch.title ?? current.title,
    description: patch.description ?? current.description,
    publicTag: patch.publicTag ?? current.publicTag,
    privateTag: patch.privateTag ?? current.privateTag,
    momentsTag: patch.momentsTag ?? current.momentsTag,
    pinnedTag: patch.pinnedTag ?? current.pinnedTag,
  }
  await db
    .prepare(
      `INSERT INTO blog_settings (user_id, title, description, password_hash, settings_json, created_at, updated_at)
        VALUES (?1, '', '', '', '{}', ?2, ?2)
        ON CONFLICT(user_id) DO NOTHING`,
    )
    .bind(userId, now)
    .run()
  await db
    .prepare(
      `UPDATE blog_settings SET title = ?1, description = ?2, settings_json = ?3, updated_at = ?4
        WHERE user_id = ?5`,
    )
    .bind(
      next.title,
      next.description,
      JSON.stringify({ publicTag: next.publicTag, privateTag: next.privateTag, momentsTag: next.momentsTag, pinnedTag: next.pinnedTag }),
      now,
      userId,
    )
    .run()
}

export async function setBlogPasswordHash(db: D1Database, userId: string, passwordHash: string): Promise<void> {
  const now = Date.now()
  await db
    .prepare(
      `INSERT INTO blog_settings (user_id, title, description, password_hash, settings_json, created_at, updated_at)
        VALUES (?1, '', '', ?2, '{}', ?3, ?3)
        ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
    )
    .bind(userId, passwordHash, now)
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
    .prepare(`SELECT title, description, settings_json FROM blog_settings WHERE user_id = ?1`)
    .bind(userId)
    .first<BlogSettingsRow>()
  if (row) {
    return {
      title: row.title,
      description: row.description,
      ...parseTagConfig(row.settings_json),
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
    momentsTag: MOMENTS_TAG,
    pinnedTag: PINNED_TAG,
  }
}
