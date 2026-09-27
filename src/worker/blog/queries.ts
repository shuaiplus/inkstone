import type {
  BlogPostDetail,
  BlogPostSummary,
  BlogPostsResponse,
  BlogTag,
  MomentItem,
  TimelineItem,
} from '@shared/blog/types'
import { getMeta } from '../db/metadata'
import { splitTags } from '../db/rows'

const TAG_SUBQUERY = `(SELECT GROUP_CONCAT(t.name, char(1)) FROM note_tags nt
     JOIN tags t ON t.id = nt.tag_id
    WHERE nt.note_id = n.id AND t.user_id = n.user_id) AS tag_names`

const SHARE_POST_COLUMNS = `s.note_id AS id, n.title, n.excerpt, s.created_at, n.updated_at, s.slug, ${TAG_SUBQUERY}`

const SHARE_POST_JOIN = ` FROM shares s JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id`

interface BlogPostRow {
  id: string
  title: string
  excerpt: string
  created_at: number
  updated_at: number
  slug: string
  tag_names: string | null
}

function toBlogPostSummary(row: BlogPostRow): BlogPostSummary {
  return {
    id: row.id,
    title: row.title,
    excerpt: row.excerpt,
    created_at: row.created_at,
    updated_at: row.updated_at,
    slug: row.slug,
    tags: splitTags(row.tag_names),
  }
}

export async function getBlogOwner(db: D1Database, username: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT id FROM users WHERE username = ?1`)
    .bind(username)
    .first<{ id: string }>()
  return row?.id ?? null
}

export async function hasBlogPassword(db: D1Database, userId: string): Promise<boolean> {
  return Boolean(await getMeta(db, `blog_password_hash:${userId}`))
}

export async function listBlogPosts(
  db: D1Database,
  userId: string,
  onlyPublic: boolean,
  page: number,
  limit: number,
): Promise<BlogPostsResponse> {
  const now = Date.now()
  const offset = (page - 1) * limit
  const passwordFilter = onlyPublic ? ` AND s.password_hash IS NULL` : ''
  const where = `s.user_id = ?1 AND s.blog_published = 1 AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?2)${passwordFilter}`
  const { results } = await db
    .prepare(`SELECT ${SHARE_POST_COLUMNS}${SHARE_POST_JOIN} WHERE ${where} ORDER BY s.created_at DESC LIMIT ?3 OFFSET ?4`)
    .bind(userId, now, limit, offset)
    .all<BlogPostRow>()
  const count = await db
    .prepare(`SELECT COUNT(*) AS count${SHARE_POST_JOIN} WHERE ${where}`)
    .bind(userId, now)
    .first<{ count: number }>()
  const posts = results.map(toBlogPostSummary)
  return { posts, page, hasMore: page * limit < (count?.count ?? 0) }
}

export async function getBlogPost(
  db: D1Database,
  userId: string,
  slug: string,
  onlyPublic: boolean,
): Promise<BlogPostDetail | null> {
  const now = Date.now()
  const passwordFilter = onlyPublic ? ` AND s.password_hash IS NULL` : ''
  const row = await db
    .prepare(
      `SELECT ${SHARE_POST_COLUMNS}, n.content${SHARE_POST_JOIN}
        WHERE s.user_id = ?2 AND s.blog_published = 1 AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?3)${passwordFilter} AND s.slug = ?1
        LIMIT 1`,
    )
    .bind(slug, userId, now)
    .first<BlogPostRow & { content: string }>()
  if (!row) return null
  return { ...toBlogPostSummary(row), content: row.content }
}

export async function listBlogMoments(
  db: D1Database,
  userId: string,
  onlyPublic: boolean,
): Promise<MomentItem[]> {
  const passwordFilter = onlyPublic ? ` AND s.password_hash IS NULL` : ''
  const { results } = await db
    .prepare(
      `SELECT n.id, n.content, n.created_at, s.slug AS slug, ${TAG_SUBQUERY}
         FROM notes n
         JOIN folders f ON f.id = n.folder_id AND f.name = 'Moments' AND f.parent_id IS NULL AND f.deleted_at IS NULL
         JOIN shares s ON s.note_id = n.id AND s.user_id = n.user_id AND s.blog_published = 1 AND (s.expires_at IS NULL OR s.expires_at > ?2)${passwordFilter}
        WHERE n.user_id = ?1 AND n.deleted_at IS NULL
        ORDER BY n.created_at DESC`,
    )
    .bind(userId, Date.now())
    .all<{ id: string; content: string; created_at: number; slug: string; tag_names: string | null }>()
  return results.map((row) => ({
    id: row.id,
    content: row.content,
    created_at: row.created_at,
    slug: row.slug,
    tags: splitTags(row.tag_names),
  }))
}

export async function listBlogTimeline(
  db: D1Database,
  userId: string,
  onlyPublic: boolean,
): Promise<TimelineItem[]> {
  const now = Date.now()
  const passwordFilter = onlyPublic ? ` AND s.password_hash IS NULL` : ''
  const where = `s.user_id = ?1 AND s.blog_published = 1 AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?2)${passwordFilter}`
  const { results } = await db
    .prepare(
      `SELECT s.note_id AS id, n.title, s.created_at, s.slug AS slug, strftime('%Y', datetime(s.created_at / 1000, 'unixepoch')) AS year
       ${SHARE_POST_JOIN}
        WHERE ${where}
        ORDER BY s.created_at DESC`,
    )
    .bind(userId, now)
    .all<{ id: string; title: string; created_at: number; slug: string; year: string }>()
  return results.map((row) => ({
    id: row.id,
    title: row.title,
    created_at: row.created_at,
    year: row.year,
    slug: row.slug,
  }))
}

export async function listBlogTags(
  db: D1Database,
  userId: string,
  onlyPublic: boolean,
): Promise<BlogTag[]> {
  const now = Date.now()
  const passwordFilter = onlyPublic ? ` AND s.password_hash IS NULL` : ''
  const where = `s.user_id = ?1 AND s.blog_published = 1 AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?2)${passwordFilter}`
  const { results } = await db
    .prepare(
      `SELECT t.name, COUNT(*) AS count
         FROM shares s
         JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
         JOIN note_tags nt ON nt.note_id = n.id
         JOIN tags t ON t.id = nt.tag_id AND t.user_id = n.user_id
        WHERE ${where}
        GROUP BY t.name
       HAVING count > 0
        ORDER BY count DESC, t.name ASC`,
    )
    .bind(userId, now)
    .all<{ name: string; count: number }>()
  return results
}

export async function listPostsByTag(
  db: D1Database,
  userId: string,
  tagName: string,
  onlyPublic: boolean,
): Promise<BlogPostSummary[]> {
  const now = Date.now()
  const passwordFilter = onlyPublic ? ` AND s.password_hash IS NULL` : ''
  const { results } = await db
    .prepare(
      `SELECT ${SHARE_POST_COLUMNS}
         FROM shares s
         JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
         JOIN note_tags nt ON nt.note_id = n.id
         JOIN tags t ON t.id = nt.tag_id AND t.user_id = n.user_id
        WHERE s.user_id = ?1 AND s.blog_published = 1 AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?2)${passwordFilter} AND t.name = ?3 COLLATE NOCASE
        ORDER BY s.created_at DESC`,
    )
    .bind(userId, now, tagName)
    .all<BlogPostRow>()
  return results.map(toBlogPostSummary)
}
