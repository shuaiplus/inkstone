import { blogEntryOfTags, isPinnedTag, type BlogKind, type BlogTier } from '@shared/blog/tags'
import { newSlug } from '../lib/id'
import { splitTags } from '../db/rows'
import { getBlogSettings, type BlogSettings } from './settings'

export async function ensureBlogPost(
  db: D1Database,
  userId: string,
  noteId: string,
  tier: Exclude<BlogTier, 'none'>,
  kind: BlogKind,
  pinned: boolean,
): Promise<void> {
  const existing = await db
    .prepare(`SELECT slug, is_pinned FROM blog_posts WHERE user_id = ?1 AND note_id = ?2`)
    .bind(userId, noteId)
    .first<{ slug: string; is_pinned: number }>()
  const now = Date.now()
  const pinnedValue = pinned ? 1 : 0
  if (existing) {
    // Slug and published_at stay frozen; only visibility/kind/pin move.
    await db
      .prepare(`UPDATE blog_posts SET visibility = ?1, kind = ?2, is_pinned = ?3, updated_at = ?4 WHERE user_id = ?5 AND note_id = ?6`)
      .bind(tier, kind, pinnedValue, now, userId, noteId)
      .run()
    return
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db
        .prepare(
          `INSERT INTO blog_posts
            (user_id, note_id, slug, visibility, kind, is_pinned, published_at, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(userId, noteId, newSlug(), tier, kind, pinnedValue, now, now, now)
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
      `UPDATE blog_posts SET slug = ?1, visibility = ?2, kind = ?3, is_pinned = ?4, updated_at = ?5
        WHERE user_id = ?6 AND note_id = ?7`,
    )
    .bind(`${newSlug()}-${noteId.slice(0, 8)}`, tier, kind, pinnedValue, Date.now(), userId, noteId)
    .run()
  if (!updated.meta.changes) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO blog_posts
          (user_id, note_id, slug, visibility, kind, is_pinned, published_at, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(userId, noteId, `${newSlug()}-${noteId.slice(0, 8)}`, tier, kind, pinnedValue, now, now, now)
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
  opts?: { settings?: BlogSettings },
): Promise<void> {
  const settings = opts?.settings ?? (await getBlogSettings(db, userId))
  const entry = blogEntryOfTags(tags, settings)
  if (!entry) {
    await withdrawBlogPost(db, userId, noteId)
    return
  }
  await ensureBlogPost(db, userId, noteId, entry.tier, entry.kind, isPinnedTag(tags, settings))
}

/**
 * Full recompute for one user after tag renames. Per-note sync keeps
 * slug/published_at frozen; only tier/kind move.
 */
export async function resyncBlogPosts(db: D1Database, userId: string): Promise<void> {
  const settings = await getBlogSettings(db, userId)
  const { results } = await db
    .prepare(
      `SELECT n.id,
        (SELECT GROUP_CONCAT(t.name, char(1)) FROM note_tags nt
           JOIN tags t ON t.id = nt.tag_id
          WHERE nt.note_id = n.id AND t.user_id = n.user_id) AS tag_names
         FROM notes n
        WHERE n.user_id = ?1 AND n.deleted_at IS NULL`,
    )
    .bind(userId)
    .all<{ id: string; tag_names: string | null }>()
  for (const note of results) {
    await syncBlogPost(db, userId, note.id, splitTags(note.tag_names), { settings })
  }
}
