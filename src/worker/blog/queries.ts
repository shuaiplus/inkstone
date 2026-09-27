import type {
  AdjacentPost,
  BlogMomentsResponse,
  BlogPostDetail,
  BlogPostSummary,
  BlogPostsResponse,
  BlogTag,
  BlogTimelineResponse,
} from '@shared/blog/types'
import { firstImageSrc } from '@shared/markdown-utils'
import { getMeta } from '../db/metadata'
import { splitTags } from '../db/rows'
import { MOMENTS_FOLDER_NAME } from '@shared/blog/tags'

const TAG_SUBQUERY = `(SELECT GROUP_CONCAT(t.name, char(1)) FROM note_tags nt
     JOIN tags t ON t.id = nt.tag_id
    WHERE nt.note_id = n.id AND t.user_id = n.user_id) AS tag_names`

const SHARE_POST_COLUMNS = `s.note_id AS id, n.title, n.excerpt, s.created_at, n.updated_at, s.slug, n.content, ${TAG_SUBQUERY}`

const SHARE_POST_JOIN = ` FROM shares s JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id`

const tierFilter = (tier: 'public' | 'all') =>
  `AND EXISTS (SELECT 1 FROM note_tags nt2 JOIN tags t2 ON t2.id = nt2.tag_id
                WHERE nt2.note_id = n.id AND t2.user_id = n.user_id AND t2.name ${
                  tier === 'public' ? "= 'blog-public'" : "IN ('blog-public', 'blog-private')"
                })`

interface BlogPostRow {
  id: string
  title: string
  excerpt: string
  created_at: number
  updated_at: number
  slug: string
  content: string
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
    cover: firstImageSrc(row.content),
  }
}

export async function getBlogOwner(db: D1Database, username: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT id FROM users WHERE username = ?1`)
    .bind(username)
    .first<{ id: string }>()
  return row?.id ?? null
}

export async function getBlogOwnerUsername(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(`SELECT username FROM users WHERE role = 'owner' ORDER BY created_at ASC LIMIT 1`)
    .first<{ username: string }>()
  return row?.username ?? null
}

export async function hasBlogPassword(db: D1Database, userId: string): Promise<boolean> {
  return Boolean(await getMeta(db, `blog_password_hash:${userId}`))
}

export async function listBlogPosts(
  db: D1Database,
  userId: string,
  tier: 'public' | 'all',
  page: number,
  limit: number,
): Promise<BlogPostsResponse> {
  const now = Date.now()
  const offset = (page - 1) * limit
  const excludeMoments = `AND NOT EXISTS (SELECT 1 FROM folders f2 WHERE f2.id = n.folder_id AND f2.name = '${MOMENTS_FOLDER_NAME}' AND f2.parent_id IS NULL AND f2.deleted_at IS NULL)`
  const where = `s.user_id = ?1 ${tierFilter(tier)} AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?2) ${excludeMoments}`
  const { results } = await db
    .prepare(`SELECT ${SHARE_POST_COLUMNS}${SHARE_POST_JOIN} WHERE ${where} ORDER BY s.created_at DESC LIMIT ?3 OFFSET ?4`)
    .bind(userId, now, limit, offset)
    .all<BlogPostRow>()
  const count = await db
    .prepare(`SELECT COUNT(*) AS count${SHARE_POST_JOIN} WHERE ${where}`)
    .bind(userId, now)
    .first<{ count: number }>()
  const posts = results.map(toBlogPostSummary)
  const total = count?.count ?? 0
  return { posts, page, hasMore: page * limit < total, totalPages: Math.ceil(total / limit) }
}

export async function getBlogPost(
  db: D1Database,
  userId: string,
  slug: string,
  tier: 'public' | 'all',
): Promise<BlogPostDetail | null> {
  const now = Date.now()
  const row = await db
    .prepare(
      `SELECT ${SHARE_POST_COLUMNS}${SHARE_POST_JOIN}
        WHERE s.user_id = ?2 ${tierFilter(tier)} AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?3) AND s.slug = ?1
        LIMIT 1`,
    )
    .bind(slug, userId, now)
    .first<BlogPostRow>()
  if (!row) return null
  return { ...toBlogPostSummary(row), content: row.content, previous: null, next: null }
}

export async function getAdjacentPosts(
  db: D1Database,
  userId: string,
  tier: 'public' | 'all',
  createdAt: number,
  noteId: string,
): Promise<{ previous: AdjacentPost | null; next: AdjacentPost | null }> {
  const now = Date.now()
  const excludeMoments = `AND NOT EXISTS (SELECT 1 FROM folders f2 WHERE f2.id = n.folder_id AND f2.name = '${MOMENTS_FOLDER_NAME}' AND f2.parent_id IS NULL AND f2.deleted_at IS NULL)`
  const base = `SELECT n.title, s.slug${SHARE_POST_JOIN} WHERE s.user_id = ?1 ${tierFilter(tier)} AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?2) ${excludeMoments}`
  const previous = await db
    .prepare(
      `${base} AND (s.created_at < ?3 OR (s.created_at = ?3 AND s.note_id < ?4))
        ORDER BY s.created_at DESC, s.note_id DESC LIMIT 1`,
    )
    .bind(userId, now, createdAt, noteId)
    .first<{ title: string; slug: string }>()
  const next = await db
    .prepare(
      `${base} AND (s.created_at > ?3 OR (s.created_at = ?3 AND s.note_id > ?4))
        ORDER BY s.created_at ASC, s.note_id ASC LIMIT 1`,
    )
    .bind(userId, now, createdAt, noteId)
    .first<{ title: string; slug: string }>()
  return { previous: previous ?? null, next: next ?? null }
}

export async function listBlogMoments(
  db: D1Database,
  userId: string,
  tier: 'public' | 'all',
  page: number,
  limit: number,
): Promise<BlogMomentsResponse> {
  const now = Date.now()
  const offset = (page - 1) * limit
  const publicOnly = tier === 'public'
    ? `AND EXISTS (SELECT 1 FROM note_tags nt2 JOIN tags t2 ON t2.id = nt2.tag_id
                    WHERE nt2.note_id = n.id AND t2.user_id = n.user_id AND t2.name = 'blog-public')`
    : ''
  const from = `FROM notes n
     JOIN folders f ON f.id = n.folder_id AND f.name = ?3 AND f.parent_id IS NULL AND f.deleted_at IS NULL
     JOIN shares s ON s.note_id = n.id AND s.user_id = n.user_id
       AND (s.expires_at IS NULL OR s.expires_at > ?2)
     ${publicOnly}
    WHERE n.user_id = ?1 AND n.deleted_at IS NULL`
  const { results } = await db
    .prepare(
      `SELECT n.id, n.content, n.created_at, s.slug AS slug, ${TAG_SUBQUERY}
        ${from}
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT ?4 OFFSET ?5`,
    )
    .bind(userId, now, MOMENTS_FOLDER_NAME, limit, offset)
    .all<{ id: string; content: string; created_at: number; slug: string; tag_names: string | null }>()
  const count = await db
    .prepare(`SELECT COUNT(*) AS count ${from}`)
    .bind(userId, now, MOMENTS_FOLDER_NAME)
    .first<{ count: number }>()
  const total = count?.count ?? 0
  return {
    moments: results.map((row) => ({
      id: row.id,
      content: row.content,
      created_at: row.created_at,
      slug: row.slug,
      tags: splitTags(row.tag_names),
    })),
    page,
    hasMore: page * limit < total,
  }
}

export async function listBlogTimeline(
  db: D1Database,
  userId: string,
  tier: 'public' | 'all',
  page: number,
  limit: number,
): Promise<BlogTimelineResponse> {
  const now = Date.now()
  const offset = (page - 1) * limit
  const excludeMoments = `AND NOT EXISTS (SELECT 1 FROM folders f2 WHERE f2.id = n.folder_id AND f2.name = '${MOMENTS_FOLDER_NAME}' AND f2.parent_id IS NULL AND f2.deleted_at IS NULL)`
  const where = `s.user_id = ?1 ${tierFilter(tier)} AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?2) ${excludeMoments}`
  const { results } = await db
    .prepare(
      `SELECT s.note_id AS id, n.title, s.created_at, s.slug AS slug, strftime('%Y', datetime(s.created_at / 1000, 'unixepoch')) AS year
       ${SHARE_POST_JOIN}
        WHERE ${where}
        ORDER BY s.created_at DESC, s.note_id DESC
        LIMIT ?3 OFFSET ?4`,
    )
    .bind(userId, now, limit, offset)
    .all<{ id: string; title: string; created_at: number; slug: string; year: string }>()
  const count = await db
    .prepare(`SELECT COUNT(*) AS count${SHARE_POST_JOIN} WHERE ${where}`)
    .bind(userId, now)
    .first<{ count: number }>()
  const total = count?.count ?? 0
  return {
    items: results.map((row) => ({
      id: row.id,
      title: row.title,
      created_at: row.created_at,
      year: row.year,
      slug: row.slug,
    })),
    page,
    hasMore: page * limit < total,
  }
}

export async function listBlogTags(
  db: D1Database,
  userId: string,
  tier: 'public' | 'all',
): Promise<BlogTag[]> {
  const now = Date.now()
  const where = `s.user_id = ?1 ${tierFilter(tier)} AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?2)`
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
  tier: 'public' | 'all',
): Promise<BlogPostSummary[]> {
  const now = Date.now()
  const { results } = await db
    .prepare(
      `SELECT ${SHARE_POST_COLUMNS}
         FROM shares s
         JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
         JOIN note_tags nt ON nt.note_id = n.id
         JOIN tags t ON t.id = nt.tag_id AND t.user_id = n.user_id
        WHERE s.user_id = ?1 ${tierFilter(tier)} AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?2) AND t.name = ?3 COLLATE NOCASE
        ORDER BY s.created_at DESC`,
    )
    .bind(userId, now, tagName)
    .all<BlogPostRow>()
  return results.map(toBlogPostSummary)
}
