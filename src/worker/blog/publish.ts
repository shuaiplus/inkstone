import { blogTierOfTags } from '@shared/blog/tags'
import type { BlogTier } from '@shared/blog/tags'
import { newSlug } from '../lib/id'
import { getBlogPasswordHash } from './auth'

export { getBlogPasswordHash }

export async function ensureBlogShare(
  db: D1Database,
  userId: string,
  noteId: string,
  tier: BlogTier,
  effectiveHash: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO shares (slug, note_id, user_id, password_hash, expires_at, views, created_at) VALUES (?,?,?,?,NULL,0,?)`,
    )
    .bind(newSlug(), noteId, userId, tier === 'private' ? effectiveHash : null, Date.now())
    .run()
  await db
    .prepare(`UPDATE shares SET password_hash = ?, expires_at = NULL WHERE note_id = ? AND user_id = ?`)
    .bind(tier === 'private' ? effectiveHash : null, noteId, userId)
    .run()
}

export async function withdrawBlogShare(
  db: D1Database,
  userId: string,
  noteId: string,
): Promise<void> {
  await db.prepare(`DELETE FROM shares WHERE note_id = ?1 AND user_id = ?2`).bind(noteId, userId).run()
}

export async function syncBlogShare(
  db: D1Database,
  userId: string,
  noteId: string,
  tags: readonly string[],
  prevTags?: readonly string[],
): Promise<void> {
  const tier = blogTierOfTags(tags)
  if (tier === 'none') {
    if (prevTags !== undefined && blogTierOfTags(prevTags) !== 'none') {
      await withdrawBlogShare(db, userId, noteId)
    }
    return
  }
  await ensureBlogShare(db, userId, noteId, tier, await getBlogPasswordHash(db, userId))
}
