import { blogTierOfTags, MOMENTS_FOLDER_NAME, type BlogTagConfig, type BlogTier } from '@shared/blog/tags'
import { getMeta, setMeta } from '../db/metadata'
import { newSlug } from '../lib/id'
import { getBlogPasswordHash, getBlogTagConfig } from './auth'

export { getBlogPasswordHash }

const TAG_SUBQUERY_RECONCILE = `(SELECT GROUP_CONCAT(t.name, char(1)) FROM note_tags nt
     JOIN tags t ON t.id = nt.tag_id
    WHERE nt.note_id = n.id AND t.user_id = n.user_id)`

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
  const row = await db.prepare(
    `SELECT 1 AS found FROM folders f
      WHERE f.id = ?1 AND f.user_id = ?2 AND f.name = ?3
        AND f.parent_id IS NULL AND f.deleted_at IS NULL
      LIMIT 1`,
  )
    .bind(folderId, userId, MOMENTS_FOLDER_NAME)
    .first<{ found: number }>()
  return Boolean(row)
}

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
  opts?: { inMoments?: boolean },
): Promise<void> {
  const config = await getBlogTagConfig(db, userId)
  const tier = blogTier(opts?.inMoments ?? false, tags, config)
  if (tier === 'none') {
    await withdrawBlogShare(db, userId, noteId)
    return
  }
  await ensureBlogShare(db, userId, noteId, tier, await getBlogPasswordHash(db, userId))
}

const MOMENTS_RECONCILED_KEY = 'blog-moments-reconciled'

export async function reconcileMomentsShares(db: D1Database): Promise<void> {
  if (await getMeta(db, MOMENTS_RECONCILED_KEY)) return
  const { results } = await db
    .prepare(
      `SELECT DISTINCT n.user_id AS user_id FROM notes n
        JOIN folders f ON f.id = n.folder_id
       WHERE f.name = ?1 AND f.parent_id IS NULL AND f.deleted_at IS NULL
         AND n.deleted_at IS NULL`,
    )
    .bind(MOMENTS_FOLDER_NAME)
    .all<{ user_id: string }>()
  for (const { user_id: userId } of results) {
    const config = await getBlogTagConfig(db, userId)
    const moments = await db
      .prepare(
        `SELECT n.id AS id, ${TAG_SUBQUERY_RECONCILE} FROM notes n
          JOIN folders f ON f.id = n.folder_id
         WHERE n.user_id = ?1 AND f.name = ?2 AND f.parent_id IS NULL AND f.deleted_at IS NULL
            AND n.deleted_at IS NULL`,
      )
      .bind(userId, MOMENTS_FOLDER_NAME)
      .all<{ id: string; tag_names: string | null }>()
    const passwordHash = await getBlogPasswordHash(db, userId)
    for (const note of moments.results) {
      const tags = note.tag_names ? note.tag_names.split('\u0001') : []
      const tier: BlogTier = tags.includes(config.privateTag) ? 'private' : 'public'
      await ensureBlogShare(db, userId, note.id, tier, passwordHash)
    }
  }
  await setMeta(db, MOMENTS_RECONCILED_KEY, String(Date.now()))
}
