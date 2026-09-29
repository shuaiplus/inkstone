import type {
  AdjacentPost,
  BlogMomentsResponse,
  BlogPostDetail,
  BlogPostSummary,
  BlogPostsResponse,
  BlogTag,
  BlogTagPost,
  BlogTimelineResponse,
} from '@shared/blog/types'
import type { BlogTagConfig } from '@shared/blog/tags'
import { firstImageSrc, parseFrontMatter } from '@shared/markdown-utils'
import { getMeta } from '../db/metadata'
import { splitTags } from '../db/rows'
import { MOMENTS_FOLDER_NAME } from '@shared/blog/tags'

function frontMatterCreated(content: string | null | undefined): number | null {
  if (!content) return null
  try {
    const { data } = parseFrontMatter(content)
    const v = data?.created
    if (v == null) return null
    if (v instanceof Date) return v.getTime()
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000
    if (typeof v === 'string') {
      const ms = Date.parse(v)
      return Number.isNaN(ms) ? null : ms
    }
  } catch {
    // ignore
  }
  return null
}

const TAG_SUBQUERY = `(SELECT GROUP_CONCAT(t.name, char(1)) FROM note_tags nt
     JOIN tags t ON t.id = nt.tag_id
    WHERE nt.note_id = n.id AND t.user_id = n.user_id) AS tag_names`

const SHARE_POST_COLUMNS = `s.note_id AS id, n.title, n.excerpt, s.created_at, n.updated_at, s.slug, n.content, ${TAG_SUBQUERY}`

const SHARE_POST_JOIN = ` FROM shares s JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id`

function tierFilter(tier: 'public' | 'all'): string {
  return `AND EXISTS (SELECT 1 FROM note_tags nt2 JOIN tags t2 ON t2.id = nt2.tag_id
                WHERE nt2.note_id = n.id AND t2.user_id = n.user_id AND t2.name ${
                  tier === 'public' ? '= ?' : 'IN (?, ?)'
                })`
}

function tierBinds(tier: 'public' | 'all', config: BlogTagConfig): string[] {
  if (tier === 'public') return [config.publicTag]
  return [config.publicTag, config.privateTag]
}

const excludeMomentsClause = `AND NOT EXISTS (SELECT 1 FROM folders f2 WHERE f2.id = n.folder_id AND f2.name = '${MOMENTS_FOLDER_NAME}' AND f2.parent_id IS NULL AND f2.deleted_at IS NULL)`

const momentClause = `EXISTS (SELECT 1 FROM folders f2 WHERE f2.id = n.folder_id AND f2.name = '${MOMENTS_FOLDER_NAME}' AND f2.parent_id IS NULL AND f2.deleted_at IS NULL)`

/**
 * SQL + ordered binds that scope blog content to notes the visitor may see:
 * - articles: notes carrying the blog-public/blog-private tag (excluding the Moments folder)
 * - moments: notes in the root Moments folder (public tier also excludes blog-private moments)
 */
function blogScopeSql(tier: 'public' | 'all', config: BlogTagConfig): { sql: string; binds: string[] } {
  const articleBinds = tier === 'public' ? [config.publicTag] : [config.publicTag, config.privateTag]
  const article = `(${tierFilter(tier).replace(/^AND /, '')} AND NOT ${momentClause})`
  if (tier === 'all') {
    return { sql: `(${article} OR ${momentClause})`, binds: articleBinds }
  }
  const privateExclude = `AND NOT EXISTS (SELECT 1 FROM note_tags nt3 JOIN tags t3 ON t3.id = nt3.tag_id
                    WHERE nt3.note_id = n.id AND t3.user_id = n.user_id AND t3.name = ?)`
  return {
    sql: `(${article} OR (${momentClause} ${privateExclude}))`,
    binds: [...articleBinds, config.privateTag],
  }
}

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
    created_at: frontMatterCreated(row.content) ?? row.created_at,
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
  config: BlogTagConfig,
): Promise<BlogPostsResponse> {
  const now = Date.now()
  const offset = (page - 1) * limit
  const where = `s.user_id = ? ${tierFilter(tier)} AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?) ${excludeMomentsClause}`
  const { results } = await db
    .prepare(`SELECT ${SHARE_POST_COLUMNS}${SHARE_POST_JOIN} WHERE ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`)
    .bind(userId, ...tierBinds(tier, config), now, limit, offset)
    .all<BlogPostRow>()
  const count = await db
    .prepare(`SELECT COUNT(*) AS count${SHARE_POST_JOIN} WHERE ${where}`)
    .bind(userId, ...tierBinds(tier, config), now)
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
  config: BlogTagConfig,
): Promise<BlogPostDetail | null> {
  const now = Date.now()
  const row = await db
    .prepare(
      `SELECT ${SHARE_POST_COLUMNS}${SHARE_POST_JOIN}
        WHERE s.user_id = ? ${tierFilter(tier)} AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?) AND s.slug = ?
        LIMIT 1`,
    )
    .bind(userId, ...tierBinds(tier, config), now, slug)
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
  config: BlogTagConfig,
): Promise<{ previous: AdjacentPost | null; next: AdjacentPost | null }> {
  const now = Date.now()
  const base = `SELECT n.title, s.slug${SHARE_POST_JOIN} WHERE s.user_id = ? ${tierFilter(tier)} AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?) ${excludeMomentsClause}`
  const previous = await db
    .prepare(
      `${base} AND (s.created_at < ? OR (s.created_at = ? AND s.note_id < ?))
        ORDER BY s.created_at DESC, s.note_id DESC LIMIT 1`,
    )
    .bind(userId, ...tierBinds(tier, config), now, createdAt, createdAt, noteId)
    .first<{ title: string; slug: string }>()
  const next = await db
    .prepare(
      `${base} AND (s.created_at > ? OR (s.created_at = ? AND s.note_id > ?))
        ORDER BY s.created_at ASC, s.note_id ASC LIMIT 1`,
    )
    .bind(userId, ...tierBinds(tier, config), now, createdAt, createdAt, noteId)
    .first<{ title: string; slug: string }>()
  return { previous: previous ?? null, next: next ?? null }
}

export async function listBlogMoments(
  db: D1Database,
  userId: string,
  tier: 'public' | 'all',
  page: number,
  limit: number,
  config: BlogTagConfig,
): Promise<BlogMomentsResponse> {
  const now = Date.now()
  const offset = (page - 1) * limit
  const privateExclude = tier === 'public'
    ? `AND NOT EXISTS (SELECT 1 FROM note_tags nt2 JOIN tags t2 ON t2.id = nt2.tag_id
                    WHERE nt2.note_id = n.id AND t2.user_id = n.user_id AND t2.name = ?)`
    : ''
  const from = `FROM notes n
     JOIN folders f ON f.id = n.folder_id AND f.name = ? AND f.parent_id IS NULL AND f.deleted_at IS NULL
     JOIN shares s ON s.note_id = n.id AND s.user_id = n.user_id
       AND (s.expires_at IS NULL OR s.expires_at > ?)
     ${privateExclude}
    WHERE n.user_id = ? AND n.deleted_at IS NULL`
  const bindParams = tier === 'public'
    ? [MOMENTS_FOLDER_NAME, now, config.privateTag, userId, limit, offset]
    : [MOMENTS_FOLDER_NAME, now, userId, limit, offset]
  const { results } = await db
    .prepare(
      `SELECT n.id, n.content, n.created_at, s.slug AS slug, ${TAG_SUBQUERY}
        ${from}
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(...bindParams)
    .all<{ id: string; content: string; created_at: number; slug: string; tag_names: string | null }>()
  const countBindParams = tier === 'public'
    ? [MOMENTS_FOLDER_NAME, now, config.privateTag, userId]
    : [MOMENTS_FOLDER_NAME, now, userId]
  const count = await db
    .prepare(`SELECT COUNT(*) AS count ${from}`)
    .bind(...countBindParams)
    .first<{ count: number }>()
  const total = count?.count ?? 0
  return {
    moments: results.map((row) => ({
      id: row.id,
      content: row.content,
      created_at: frontMatterCreated(row.content) ?? row.created_at,
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
  config: BlogTagConfig,
): Promise<BlogTimelineResponse> {
  const now = Date.now()
  const offset = (page - 1) * limit
  const where = `s.user_id = ? ${tierFilter(tier)} AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?) ${excludeMomentsClause}`
  const { results } = await db
    .prepare(
      `SELECT s.note_id AS id, n.title, s.created_at, s.slug AS slug, n.content AS content
       ${SHARE_POST_JOIN}
        WHERE ${where}
        ORDER BY s.created_at DESC, s.note_id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(userId, ...tierBinds(tier, config), now, limit, offset)
    .all<{ id: string; title: string; created_at: number; slug: string; content: string }>()
  const count = await db
    .prepare(`SELECT COUNT(*) AS count${SHARE_POST_JOIN} WHERE ${where}`)
    .bind(userId, ...tierBinds(tier, config), now)
    .first<{ count: number }>()
  const total = count?.count ?? 0
  return {
    items: results.map((row) => {
      const created = frontMatterCreated(row.content) ?? row.created_at
      return {
        id: row.id,
        title: row.title,
        created_at: created,
        year: new Date(created).getFullYear().toString(),
        slug: row.slug,
      }
    }),
    page,
    hasMore: page * limit < total,
  }
}

export async function listBlogTags(
  db: D1Database,
  userId: string,
  tier: 'public' | 'all',
  config: BlogTagConfig,
): Promise<BlogTag[]> {
  const now = Date.now()
  const scope = blogScopeSql(tier, config)
  const where = `s.user_id = ? AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?) AND ${scope.sql}`
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
    .bind(userId, now, ...scope.binds)
    .all<{ name: string; count: number }>()
  return results
}

interface BlogTagRow extends BlogPostRow {
  is_moment: number
}

export async function listPostsByTag(
  db: D1Database,
  userId: string,
  tagName: string,
  tier: 'public' | 'all',
  config: BlogTagConfig,
): Promise<BlogTagPost[]> {
  const now = Date.now()
  const scope = blogScopeSql(tier, config)
  const where = `s.user_id = ? AND n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?) AND ${scope.sql}`
  const { results } = await db
    .prepare(
      `SELECT ${SHARE_POST_COLUMNS},
              CASE WHEN ${momentClause} THEN 1 ELSE 0 END AS is_moment
         FROM shares s
         JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
         JOIN note_tags nt ON nt.note_id = n.id
         JOIN tags t ON t.id = nt.tag_id AND t.user_id = n.user_id
        WHERE ${where} AND t.name = ? COLLATE NOCASE
        ORDER BY s.created_at DESC`,
    )
    .bind(userId, now, ...scope.binds, tagName)
    .all<BlogTagRow>()
  return results.map((row) => {
    const base = {
      id: row.id,
      created_at: frontMatterCreated(row.content) ?? row.created_at,
      slug: row.slug,
      tags: splitTags(row.tag_names),
    }
    if (row.is_moment === 1) {
      return { kind: 'moment', content: row.content, ...base }
    }
    return {
      kind: 'article',
      title: row.title,
      excerpt: row.excerpt,
      updated_at: row.updated_at,
      cover: firstImageSrc(row.content),
      ...base,
    }
  })
}
