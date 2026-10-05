import { blogTierOfTags, type BlogTagConfig, type BlogTier } from '@shared/blog/tags'
import { newSlug } from '../lib/id'
import { splitTags } from '../db/rows'
import { getBlogSettings, type BlogSettings } from './settings'

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
    } catch (error) {
      // Per-user slug collision: retry with a fresh slug. Anything else is
      // a real bug and must surface instead of looping.
      if (!isUniqueViolation(error)) throw error
    }
  }
  // Lost the slug race (or a concurrent insert won the PK race): update the
  // row so the visibility/kind change is never silently dropped.
  const updated = await db
    .prepare(
      `UPDATE blog_posts SET slug = ?1, visibility = ?2, kind = ?3, updated_at = ?4
        WHERE user_id = ?5 AND note_id = ?6`,
    )
    .bind(`${newSlug()}-${noteId.slice(0, 8)}`, tier, kind, Date.now(), userId, noteId)
    .run()
  if (!updated.meta.changes) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO blog_posts
          (user_id, note_id, slug, visibility, kind, is_pinned, pinned_at, published_at, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6, ?7, ?8)`,
      )
      .bind(userId, noteId, `${newSlug()}-${noteId.slice(0, 8)}`, tier, kind, now, now, now)
      .run()
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed|UNIQUE constraint failed/i.test(error.message)
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
  opts?: { inMoments?: boolean; settings?: BlogSettings },
): Promise<void> {
  const settings = opts?.settings ?? (await getBlogSettings(db, userId))
  const inMoments = opts?.inMoments ?? false
  const tier = blogTier(inMoments, tags, settings)
  if (tier === 'none') {
    await withdrawBlogPost(db, userId, noteId)
    return
  }
  await ensureBlogPost(db, userId, noteId, tier, inMoments ? 'moment' : 'article')
}

/**
 * Full recompute for one user after tag or moments-folder renames.
 * Per-note sync keeps slug/published_at frozen; only tier/kind move.
 */
export async function resyncBlogPosts(db: D1Database, userId: string): Promise<void> {
  const settings = await getBlogSettings(db, userId)
  const { results } = await db
    .prepare(
      `SELECT n.id, n.folder_id, f.name AS folder_name, f.parent_id AS folder_parent, f.deleted_at AS folder_deleted,
        (SELECT GROUP_CONCAT(t.name, char(1)) FROM note_tags nt
           JOIN tags t ON t.id = nt.tag_id
          WHERE nt.note_id = n.id AND t.user_id = n.user_id) AS tag_names
         FROM notes n LEFT JOIN folders f ON f.id = n.folder_id
        WHERE n.user_id = ?1 AND n.deleted_at IS NULL`,
    )
    .bind(userId)
    .all<{
      id: string
      folder_id: string | null
      folder_name: string | null
      folder_parent: string | null
      folder_deleted: number | null
      tag_names: string | null
    }>()
  for (const note of results) {
    const inMoments =
      note.folder_id !== null &&
      note.folder_name === settings.momentsFolder &&
      note.folder_parent === null &&
      note.folder_deleted === null
    await syncBlogPost(db, userId, note.id, splitTags(note.tag_names), { inMoments, settings })
  }
}
