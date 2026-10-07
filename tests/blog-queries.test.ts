import { describe, expect, it } from 'vitest'
import {
  getBlogOwner,
  hasBlogPassword,
  listBlogMoments,
  listBlogPosts,
  listBlogTags,
  listBlogTimeline,
  listPostsByTag,
  getBlogPost,
  getAdjacentPosts,
} from '../src/worker/blog/queries'

interface MockRow {
  [key: string]: unknown
}

interface MockStatement {
  all<T = MockRow>(): Promise<{ results: T[] }>
  first<T = MockRow>(): Promise<T | null>
  run(): Promise<{ success: boolean }>
}

interface MockDb {
  preparedSqls: string[]
  prepare(sql: string): { bind(...args: unknown[]): MockStatement }
}

type Handler = (args: unknown[]) => Promise<{ all?: MockRow[]; first?: MockRow | null }>

/**
 * Counts SQL placeholders the same way D1 expects binds:
 * - strips string literals and line comments so a '?' inside text is not counted
 * - numbered placeholders (?n) require binds up to the highest index
 * - anonymous '?' each require one bind
 */
function countPlaceholders(sql: string): number {
  const stripped = sql
    .replace(/--[^\n]*/g, '')
    .replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`/g, '""')
  let max = 0
  let anonymous = 0
  let hasNumbered = false
  const re = /\?(\d*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped))) {
    if (m[1]) {
      hasNumbered = true
      max = Math.max(max, Number(m[1]))
    } else {
      anonymous++
    }
  }
  return hasNumbered ? max : anonymous
}

function makeDb(handlers: Array<[key: string, handler: Handler]>): MockDb {
  const resolve = (sql: string): Handler =>
    handlers.find(([key]) => sql.includes(key))?.[1] ?? (async () => ({ all: [], first: null }))
  return {
    preparedSqls: [],
    prepare(sql: string) {
      this.preparedSqls.push(sql)
      const handler = resolve(sql)
      return {
        bind(...args: unknown[]) {
          const expected = countPlaceholders(sql)
          if (expected > 0 && args.length !== expected) {
            throw new Error(
              `[mockDb] bind expects ${expected} value(s) but got ${args.length}: ${sql.replace(/\s+/g, ' ').slice(0, 140)}...`,
            )
          }
          return {
            async all<T = MockRow>() {
              const out = await handler(args)
              return { results: (out.all ?? []) as T[] }
            },
            async first<T = MockRow>() {
              const out = await handler(args)
              return (out.first ?? null) as T | null
            },
            async run() {
              return { success: true }
            },
          }
        },
      }
    },
  }
}

const hasSql = (db: MockDb, fragment: string): boolean =>
  db.preparedSqls.some((sql) => sql.includes(fragment))

const post = (overrides: Partial<MockRow> = {}): MockRow => ({
  id: 'note-1',
  title: 'A post',
  excerpt: 'excerpt',
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  slug: 'my-slug',
  visibility: 'public',
  tag_names: null,
  content: '',
  ...overrides,
})

function mockDb(): MockDb {
  return makeDb([
    ['FROM users', async () => ({ first: null })],
    ['app_meta', async () => ({ first: null })],
    ['bp.slug = ?', async (args) => (args[args.length - 1] === 'my-slug' ? { first: { ...post(), content: 'body' } } : { first: null })],
    ['LIMIT ? OFFSET ?', async () => ({ all: [post()] })],
    ['COUNT(*)', async () => ({ first: { count: 1 } })],
  ])
}

function mockDbWithMoments(): MockDb {
  return makeDb([
    ['bp.kind', async () => ({
      all: [
        { id: 'moment-1', content: 'short note', created_at: 1_700_000_000_000, slug: 'moment-1-slug', tag_names: null },
        { id: 'moment-2', content: 'another one', created_at: 1_700_000_000_001, slug: 'moment-2-slug', tag_names: null },
      ],
    })],
  ])
}

function mockDbWithTimeline(): MockDb {
  return makeDb([
    ['n.content AS content', async () => ({
      all: [
        { id: 't-note', title: 'Timeline post', created_at: Date.UTC(2026, 0, 1), slug: 't-slug', content: '' },
        { id: 'old-note', title: 'Older post', created_at: Date.UTC(2014, 0, 1), slug: 'old-slug', content: '' },
      ],
    })],
  ])
}

function mockDbWithTags(): MockDb {
  return makeDb([
    ['GROUP BY t.name', async () => ({
      all: [
        { name: 'a', count: 2 },
        { name: 'b', count: 1 },
      ],
    })],
  ])
}

function mockDbWithPostsByTag(): MockDb {
  return makeDb([
    ['COLLATE NOCASE', async () => ({ all: [post({ id: 'tagged-note' })] })],
  ])
}

function mockDbWithTaggedMoments(): MockDb {
  return makeDb([
    ['GROUP BY t.name', async () => ({
      all: [
        { name: 'plant', count: 1 },
        { name: 'a', count: 2 },
      ],
    })],
    ['COLLATE NOCASE', async () => ({
      all: [
        { id: 'moment-1', content: 'a plant note', created_at: 1_700_000_000_000, slug: 'moment-1-slug', tag_names: 'plant', is_moment: 1 },
      ],
    })],
  ])
}

function mockDbWithAdjacent(): MockDb {
  return makeDb([
    ['bp.note_id < ?', async () => ({ first: { title: 'Older post', slug: 'older' } })],
    ['bp.note_id > ?', async () => ({ first: { title: 'Newer post', slug: 'newer' } })],
  ])
}

describe('blog queries', () => {
  it('getBlogOwner returns null for unknown username', async () => {
    expect(await getBlogOwner(mockDb(), 'nobody')).toBeNull()
  })

  it('hasBlogPassword reflects the blog password in app_meta', async () => {
    expect(await hasBlogPassword(mockDb(), 'u1')).toBe(false)
  })

  it('listBlogPosts reads from blog_posts, not shares', async () => {
    const db = mockDb()
    const posts = await listBlogPosts(db, 'u1', 'all', 1, 10)
    expect(posts.posts.map((p) => p.id)).toEqual(['note-1'])
    expect(hasSql(db, 'FROM blog_posts bp')).toBe(true)
    expect(hasSql(db, 'FROM shares')).toBe(false)
    expect(hasSql(db, 'n.deleted_at IS NULL')).toBe(true)
  })

  it('listBlogPosts only returns articles, ordered pinned-first', async () => {
    const db = mockDb()
    await listBlogPosts(db, 'u1', 'all', 1, 10)
    expect(hasSql(db, "bp.kind = 'article'")).toBe(true)
    expect(hasSql(db, 'bp.is_pinned DESC')).toBe(true)
  })

  it('tier public filters to public visibility only', async () => {
    const db = mockDb()
    await listBlogPosts(db, 'u1', 'public', 1, 10)
    expect(hasSql(db, "bp.visibility = 'public'")).toBe(true)
    expect(hasSql(db, "bp.visibility IN ('public', 'private')")).toBe(false)
  })

  it('tier all includes both visibilities', async () => {
    const db = mockDb()
    await listBlogPosts(db, 'u1', 'all', 1, 10)
    expect(hasSql(db, "bp.visibility IN ('public', 'private')")).toBe(true)
  })

  it('getBlogPost by slug and unknown slug returns null', async () => {
    const detail = await getBlogPost(mockDb(), 'u1', 'my-slug', 'all')
    expect(detail?.slug).toBe('my-slug')
    expect(detail?.visibility).toBe('public')
    expect(await getBlogPost(mockDb(), 'u1', 'missing', 'all')).toBeNull()
  })

  it('getAdjacentPosts orders by frozen published_at', async () => {
    const db = mockDbWithAdjacent()
    const adjacent = await getAdjacentPosts(db, 'u1', 'all', 1_700_000_000_000, 'n1')
    expect(adjacent.previous).toEqual({ title: 'Older post', slug: 'older' })
    expect(adjacent.next).toEqual({ title: 'Newer post', slug: 'newer' })
    expect(hasSql(db, 'bp.published_at < ?')).toBe(true)
    expect(hasSql(db, 'bp.published_at > ?')).toBe(true)
    expect(hasSql(db, 'ORDER BY bp.published_at DESC, bp.note_id DESC')).toBe(true)
    expect(hasSql(db, 'ORDER BY bp.published_at ASC, bp.note_id ASC')).toBe(true)
  })

  it('getAdjacentPosts returns nulls when there are no neighbors', async () => {
    const adjacent = await getAdjacentPosts(mockDb(), 'u1', 'all', 1_700_000_000_000, 'n1')
    expect(adjacent).toEqual({ previous: null, next: null })
  })

  it('listBlogMoments reads moments from blog_posts without folder joins', async () => {
    const db = mockDbWithMoments()
    const moments = await listBlogMoments(db, 'u1', 'all', 1, 20)
    expect(moments.moments.map((m) => m.id)).toEqual(['moment-1', 'moment-2'])
    expect(moments.moments[0]?.content).toBe('short note')
    expect(moments.moments[0]?.slug).toBe('moment-1-slug')
    expect(moments.page).toBe(1)
    expect(moments.hasMore).toBe(false)
    expect(hasSql(db, "bp.kind = 'moment'")).toBe(true)
    expect(hasSql(db, 'JOIN folders')).toBe(false)
  })

  it('listBlogMoments filters private moments in the public tier', async () => {
    const db = mockDbWithMoments()
    await listBlogMoments(db, 'u1', 'public', 1, 20)
    expect(hasSql(db, "bp.visibility = 'public'")).toBe(true)
  })

  it('listBlogTimeline returns items with a year field', async () => {
    const db = mockDbWithTimeline()
    const items = await listBlogTimeline(db, 'u1', 'all', 1, 20)
    expect(items.items.map((i) => i.year)).toEqual(['2026', '2014'])
    expect(items.items[0]?.id).toBe('t-note')
    expect(items.items[0]?.slug).toBe('t-slug')
    expect(items.hasMore).toBe(false)
  })

  it('listBlogTags returns tag counts from blog posts', async () => {
    const db = mockDbWithTags()
    const tags = await listBlogTags(db, 'u1', 'all')
    expect(tags).toEqual([
      { name: 'a', count: 2 },
      { name: 'b', count: 1 },
    ])
    expect(hasSql(db, 'FROM blog_posts bp')).toBe(true)
  })

  it('listPostsByTag returns posts filtered by tag name', async () => {
    const db = mockDbWithPostsByTag()
    const posts = await listPostsByTag(db, 'u1', 'tag', 'all')
    expect(posts.map((p) => p.id)).toEqual(['tagged-note'])
    expect(hasSql(db, 'COLLATE NOCASE')).toBe(true)
  })

  it('listPostsByTag returns moments with kind "moment"', async () => {
    const db = mockDbWithTaggedMoments()
    const posts = await listPostsByTag(db, 'u1', 'plant', 'all')
    expect(posts).toEqual([
      {
        kind: 'moment',
        id: 'moment-1',
        content: 'a plant note',
        created_at: 1_700_000_000_000,
        slug: 'moment-1-slug',
        tags: ['plant'],
      },
    ])
    expect(hasSql(db, 'is_moment')).toBe(true)
  })
})
