import { BLOG_PRIVATE_TAG, BLOG_PUBLIC_TAG, MOMENTS_TAG, blogEntryOfTags } from '@shared/blog/tags'
import { getMeta, setMeta } from '../db/metadata'
import { LEGACY_BLOG_SESSION_PREFIX } from './settings'
import { resyncBlogPosts } from './publish'

export const BLOG_SEED_MARKER = 'blog_seed:v14'
export const BLOG_MOMENTS_RESEED_MARKER = 'blog_seed:moments-tags-v3'

const BLOG_PASSWORD_KEY = (userId: string): string => `blog_password_hash:${userId}`
const BLOG_TITLE_KEY = (userId: string): string => `blog_title:${userId}`
const BLOG_DESCRIPTION_KEY = (userId: string): string => `blog_description:${userId}`
const BLOG_PUBLIC_TAG_KEY = (userId: string): string => `blog_public_tag:${userId}`
const BLOG_PRIVATE_TAG_KEY = (userId: string): string => `blog_private_tag:${userId}`

interface SeedUser {
  id: string
  password_hash: string
}

/**
 * One-time backfill from the shares/app_meta era into the independent
 * blog_settings/blog_posts/blog_sessions tables. Idempotent via marker.
 */
export async function seedBlogTables(db: D1Database): Promise<void> {
  if ((await getMeta(db, BLOG_SEED_MARKER)) === 'done') return
  const { results: users } = await db
    .prepare(`SELECT id, password_hash FROM users`)
    .all<SeedUser>()
  for (const user of users) {
    await seedUserSettings(db, user)
    await seedUserSessions(db, user.id)
    await seedUserPosts(db, user.id)
  }
  await setMeta(db, BLOG_SEED_MARKER, 'done')
}

async function seedUserSettings(db: D1Database, user: SeedUser): Promise<void> {
  const [customHash, title, description, publicTag, privateTag] = await Promise.all([
    getMeta(db, BLOG_PASSWORD_KEY(user.id)),
    getMeta(db, BLOG_TITLE_KEY(user.id)),
    getMeta(db, BLOG_DESCRIPTION_KEY(user.id)),
    getMeta(db, BLOG_PUBLIC_TAG_KEY(user.id)),
    getMeta(db, BLOG_PRIVATE_TAG_KEY(user.id)),
  ])
  const now = Date.now()
  await db
    .prepare(
      `INSERT OR IGNORE INTO blog_settings
        (user_id, title, description, password_hash, settings_json, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      user.id,
      title ?? '',
      description ?? '',
      customHash || user.password_hash,
      JSON.stringify({
        publicTag: publicTag || BLOG_PUBLIC_TAG,
        privateTag: privateTag || BLOG_PRIVATE_TAG,
        momentsTag: MOMENTS_TAG,
      }),
      now,
      now,
    )
    .run()
}

async function seedUserSessions(db: D1Database, userId: string): Promise<void> {
  const { results } = await db
    .prepare(`SELECT key, value FROM app_meta WHERE key LIKE ?1`)
    .bind(`${LEGACY_BLOG_SESSION_PREFIX}${userId}:%`)
    .all<{ key: string; value: string }>()
  const now = Date.now()
  for (const row of results) {
    const token = row.key.slice(`${LEGACY_BLOG_SESSION_PREFIX}${userId}:`.length)
    if (!token) continue
    await db
      .prepare(
        `INSERT OR IGNORE INTO blog_sessions (token, user_id, expires_at, created_at)
          VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(token, userId, Number(row.value), now)
      .run()
    await db.prepare(`DELETE FROM app_meta WHERE key = ?1`).bind(row.key).run()
  }
}

interface SeedShare {
  slug: string
  note_id: string
  created_at: number
}

async function seedUserPosts(db: D1Database, userId: string): Promise<void> {
  const [publicTag, privateTag] = await Promise.all([
    getMeta(db, BLOG_PUBLIC_TAG_KEY(userId)),
    getMeta(db, BLOG_PRIVATE_TAG_KEY(userId)),
  ])
  const config = {
    publicTag: publicTag || BLOG_PUBLIC_TAG,
    privateTag: privateTag || BLOG_PRIVATE_TAG,
    momentsTag: MOMENTS_TAG,
  }
  const { results: shares } = await db
    .prepare(
      `SELECT s.slug, s.note_id, s.created_at FROM shares s
         JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
        WHERE s.user_id = ?1 AND n.deleted_at IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > ?2)`,
    )
    .bind(userId, Date.now())
    .all<SeedShare>()
  const now = Date.now()
  for (const share of shares) {
    const { results: tagRows } = await db
      .prepare(
        `SELECT t.name FROM note_tags nt
           JOIN tags t ON t.id = nt.tag_id
          WHERE nt.note_id = ?1 AND t.user_id = ?2`,
      )
      .bind(share.note_id, userId)
      .all<{ name: string }>()
    const entry = blogEntryOfTags(tagRows.map((row) => row.name), config)
    if (!entry) continue
    await db
      .prepare(
        `INSERT OR IGNORE INTO blog_posts
          (user_id, note_id, slug, visibility, kind, is_pinned, pinned_at, published_at, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6, ?7, ?8)`,
      )
      .bind(userId, share.note_id, share.slug, entry.tier, entry.kind, share.created_at, share.created_at, now)
      .run()
  }
}

/**
 * Recomputes kind/visibility for existing blog_posts after the Moments model
 * switched to orthogonal tags. Idempotent via marker; reuses the same
 * per-note sync as live writes so results match going forward.
 */
export async function reseedMomentsClassification(db: D1Database): Promise<void> {
  if ((await getMeta(db, BLOG_MOMENTS_RESEED_MARKER)) === 'done') return
  const { results: users } = await db
    .prepare(`SELECT id FROM users`)
    .all<{ id: string }>()
  for (const user of users) {
    await resyncBlogPosts(db, user.id)
  }
  await setMeta(db, BLOG_MOMENTS_RESEED_MARKER, 'done')
}
