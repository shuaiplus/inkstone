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
import { extractAttachmentIds, firstImageSrc, parseFrontMatter } from '@shared/markdown-utils'
import { splitTags } from '../db/rows'

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

const BLOG_POST_COLUMNS = `bp.note_id AS id, n.title, n.excerpt, bp.published_at AS created_at, n.updated_at, bp.slug, bp.visibility, n.content, ${TAG_SUBQUERY}`

const BLOG_POST_JOIN = `FROM blog_posts bp JOIN notes n ON n.id = bp.note_id AND n.user_id = bp.user_id`

const PIN_ORDER = `bp.is_pinned DESC, COALESCE(bp.pinned_at, bp.published_at) DESC, bp.published_at DESC, bp.note_id DESC`

function visibilityClause(tier: 'public' | 'all'): string {
  return tier === 'public' ? `bp.visibility = 'public'` : `bp.visibility IN ('public', 'private')`
}

interface BlogPostRow {
  id: string
  title: string
  excerpt: string
  created_at: number
  updated_at: number
  slug: string
  visibility: 'public' | 'private'
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
    visibility: row.visibility,
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
  const [settings, account] = await Promise.all([
    db
      .prepare(`SELECT password_hash FROM blog_settings WHERE user_id = ?1`)
      .bind(userId)
      .first<{ password_hash: string }>(),
    db
      .prepare(`SELECT password_hash FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ password_hash: string }>(),
  ])
  if (!settings?.password_hash) return false
  // Clearing the custom password materializes the account hash, so a
  // custom password exists exactly when the two differ.
  return settings.password_hash !== account?.password_hash
}

/**
 * Resolves a `?share=<slug>` token against blog posts (client appends the
 * post slug to same-origin /api/files URLs). Public posts are free;
 * private posts require a valid blog session.
 */
export async function checkBlogFileAccess(
  db: D1Database,
  slug: string,
  attachmentId: string,
  sessionValid: boolean,
): Promise<{ allowed: boolean; userId: string | null }> {
  const row = await db
    .prepare(
      `SELECT bp.user_id, bp.visibility, n.content ${BLOG_POST_JOIN}
        WHERE bp.slug = ?1 AND n.deleted_at IS NULL`,
    )
    .bind(slug)
    .first<{ user_id: string; visibility: string; content: string }>()
  if (!row) return { allowed: false, userId: null }
  if (!extractAttachmentIds(row.content).includes(attachmentId)) {
    return { allowed: false, userId: null }
  }
  if (row.visibility === 'public') return { allowed: true, userId: row.user_id }
  return { allowed: sessionValid, userId: row.user_id }
}

export async function listBlogPosts(
  db: D1Database,
  userId: string,
  tier: 'public' | 'all',
  page: number,
  limit: number,
): Promise<BlogPostsResponse> {
  const offset = (page - 1) * limit
  const where = `bp.user_id = ? AND ${visibilityClause(tier)} AND bp.kind = 'article' AND n.deleted_at IS NULL`
  const { results } = await db
    .prepare(`SELECT ${BLOG_POST_COLUMNS} ${BLOG_POST_JOIN} WHERE ${where} ORDER BY ${PIN_ORDER} LIMIT ? OFFSET ?`)
    .bind(userId, limit, offset)
    .all<BlogPostRow>()
  const count = await db
    .prepare(`SELECT COUNT(*) AS count ${BLOG_POST_JOIN} WHERE ${where}`)
    .bind(userId)
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
  const row = await db
    .prepare(
      `SELECT ${BLOG_POST_COLUMNS} ${BLOG_POST_JOIN}
        WHERE bp.user_id = ? AND ${visibilityClause(tier)} AND n.deleted_at IS NULL AND bp.slug = ?
        LIMIT 1`,
    )
    .bind(userId, slug)
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
  const base = `SELECT n.title, bp.slug ${BLOG_POST_JOIN} WHERE bp.user_id = ? AND ${visibilityClause(tier)} AND n.deleted_at IS NULL AND bp.kind = 'article'`
  const previous = await db
    .prepare(
      `${base} AND (bp.published_at < ? OR (bp.published_at = ? AND bp.note_id < ?))
        ORDER BY bp.published_at DESC, bp.note_id DESC LIMIT 1`,
    )
    .bind(userId, createdAt, createdAt, noteId)
    .first<{ title: string; slug: string }>()
  const next = await db
    .prepare(
      `${base} AND (bp.published_at > ? OR (bp.published_at = ? AND bp.note_id > ?))
        ORDER BY bp.published_at ASC, bp.note_id ASC LIMIT 1`,
    )
    .bind(userId, createdAt, createdAt, noteId)
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
  const offset = (page - 1) * limit
  const from = `${BLOG_POST_JOIN} WHERE bp.user_id = ? AND bp.kind = 'moment' AND ${visibilityClause(tier)} AND n.deleted_at IS NULL`
  const { results } = await db
    .prepare(
      `SELECT n.id, n.content, n.created_at, bp.slug AS slug, ${TAG_SUBQUERY}
        ${from}
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(userId, limit, offset)
    .all<{ id: string; content: string; created_at: number; slug: string; tag_names: string | null }>()
  const count = await db
    .prepare(`SELECT COUNT(*) AS count ${from}`)
    .bind(userId)
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
): Promise<BlogTimelineResponse> {
  const offset = (page - 1) * limit
  const where = `bp.user_id = ? AND ${visibilityClause(tier)} AND bp.kind = 'article' AND n.deleted_at IS NULL`
  const { results } = await db
    .prepare(
      `SELECT bp.note_id AS id, n.title, bp.published_at AS created_at, bp.slug AS slug, n.content AS content
       ${BLOG_POST_JOIN}
        WHERE ${where}
        ORDER BY bp.published_at DESC, bp.note_id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(userId, limit, offset)
    .all<{ id: string; title: string; created_at: number; slug: string; content: string }>()
  const count = await db
    .prepare(`SELECT COUNT(*) AS count ${BLOG_POST_JOIN} WHERE ${where}`)
    .bind(userId)
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
): Promise<BlogTag[]> {
  const where = `bp.user_id = ? AND ${visibilityClause(tier)} AND n.deleted_at IS NULL`
  const { results } = await db
    .prepare(
      `SELECT t.name, COUNT(*) AS count
         ${BLOG_POST_JOIN}
         JOIN note_tags nt ON nt.note_id = n.id
         JOIN tags t ON t.id = nt.tag_id AND t.user_id = n.user_id
        WHERE ${where}
        GROUP BY t.name
       HAVING count > 0
        ORDER BY count DESC, t.name ASC`,
    )
    .bind(userId)
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
): Promise<BlogTagPost[]> {
  const where = `bp.user_id = ? AND ${visibilityClause(tier)} AND n.deleted_at IS NULL`
  const { results } = await db
    .prepare(
      `SELECT ${BLOG_POST_COLUMNS},
              CASE WHEN bp.kind = 'moment' THEN 1 ELSE 0 END AS is_moment
         ${BLOG_POST_JOIN}
         JOIN note_tags nt ON nt.note_id = n.id
         JOIN tags t ON t.id = nt.tag_id AND t.user_id = n.user_id
        WHERE ${where} AND t.name = ? COLLATE NOCASE
        ORDER BY bp.published_at DESC`,
    )
    .bind(userId, tagName)
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
      visibility: row.visibility,
      cover: firstImageSrc(row.content),
      ...base,
    }
  })
}
