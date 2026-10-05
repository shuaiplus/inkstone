import { blogTierOfTags, type BlogTagConfig, type BlogTier } from '@shared/blog/tags'
import { newSlug } from '../lib/id'
import { getBlogSettings } from './settings'

export function blogTier(inMoments: boolean, tags: readonly string[], config?: BlogTagConfig): BlogTier {
  if (inMoments) {
    const privateTag = config?.privateTag
    if (privateTag && tags.includes(privateTag)) return 'private'
    return 'public'
  }
  return blogTierOfTags(tags, config)
}

export async function isMomentsFolder(db: D1Database, userId: string, folderId: string | null): Promise<boolean> {
  if (!folderId) return false
  const { momentsFolder } = await getBlogSettings(db, userId)
  const row = await db.prepare(
    `SELECT 1 AS found FROM folders f
      WHERE f.id = ?1 AND f.user_id = ?2 AND f.name = ?3
        AND f.parent_id IS NULL AND f.deleted_at IS NULL
      LIMIT 1`,
  )
    .bind(folderId, userId, momentsFolder)
    .first<{ found: number }>()
  return Boolean(row)
}

export async function ensureBlogPost(
  db: D1Database,
  userId: string,
  noteId: string,
  tier: Exclude<BlogTier, 'none'>,
  kind: 'article' | 'moment',
): Promise<void> {
  const existing = await db
    .prepare(`SELECT slug FROM blog_posts WHERE user_id = ?1 AND note_id = ?2`)
    .bind(userId, noteId)
    .first<{ slug: string }>()
  const now = Date.now()
  if (existing) {
    // Slug and published_at stay frozen; only visibility/kind move.
    await db
      .prepare(`UPDATE blog_posts SET visibility = ?1, kind = ?2, updated_at = ?3 WHERE user_id = ?4 AND note_id = ?5`)
      .bind(tier, kind, now, userId, noteId)
      .run()
    return
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db
        .prepare(
          `INSERT INTO blog_posts
            (user_id, note_id, slug, visibility, kind, is_pinned, pinned_at, published_at, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6, ?7, ?8)`,
        )
        .bind(userId, noteId, newSlug(), tier, kind, now, now, now)
        .run()
      return
    } catch {
      // Per-user slug collision: retry with a fresh slug.
    }
  }
  await db
    .prepare(
      `INSERT OR IGNORE INTO blog_posts
        (user_id, note_id, slug, visibility, kind, is_pinned, pinned_at, published_at, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6, ?7, ?8)`,
    )
    .bind(userId, noteId, `${newSlug()}-${noteId.slice(0, 8)}`, tier, kind, now, now, now)
    .run()
}

export async function withdrawBlogPost(
  db: D1Database,
  userId: string,
  noteId: string,
): Promise<void> {
  await db.prepare(`DELETE FROM blog_posts WHERE user_id = ?1 AND note_id = ?2`).bind(userId, noteId).run()
}

export async function syncBlogPost(
  db: D1Database,
  userId: string,
  noteId: string,
  tags: readonly string[],
  opts?: { inMoments?: boolean },
): Promise<void> {
  const settings = await getBlogSettings(db, userId)
  const inMoments = opts?.inMoments ?? false
  const tier = blogTier(inMoments, tags, settings)
  if (tier === 'none') {
    await withdrawBlogPost(db, userId, noteId)
    return
  }
  await ensureBlogPost(db, userId, noteId, tier, inMoments ? 'moment' : 'article')
}
