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
  tag_names: null,
  content: '',
  ...overrides,
})

function mockDb(): MockDb {
  return makeDb([
    ['FROM users', async () => ({ first: null })],
    ['app_meta', async () => ({ first: null })],
    ['s.slug = ?1', async (args) => (args[0] === 'my-slug' ? { first: { ...post(), content: 'body' } } : { first: null })],
    ['LIMIT ?3 OFFSET ?4', async () => ({ all: [post()] })],
    ['COUNT(*)', async () => ({ first: { count: 1 } })],
  ])
}

function mockDbWithExpiredShare(): MockDb {
  return makeDb([
    ['LIMIT ?3 OFFSET ?4', async () => ({ all: [post({ id: 'alive-note' })] })],
    ['COUNT(*)', async () => ({ first: { count: 1 } })],
  ])
}

function mockDbWithDeletedNote(): MockDb {
  return makeDb([
    ['LIMIT ?3 OFFSET ?4', async () => ({ all: [post({ id: 'kept-note' })] })],
    ['COUNT(*)', async () => ({ first: { count: 1 } })],
  ])
}

function mockDbMixed(): MockDb {
  return makeDb([
    ['LIMIT ?3 OFFSET ?4', async () => ({ all: [post({ id: 'public-note' })] })],
    ['COUNT(*)', async () => ({ first: { count: 1 } })],
  ])
}

function mockDbWithPassword(): MockDb {
  return makeDb([
    ['app_meta', async (args) =>
      args[0] === 'blog_password_hash:u1' ? { first: { value: 'hash' } } : { first: null }],
  ])
}

function mockDbWithMoments(): MockDb {
  return makeDb([
    ['JOIN folders f ON f.id = n.folder_id', async () => ({
      all: [
        { id: 'moment-1', content: 'short note', created_at: 1_700_000_000_000, slug: 'moment-1-slug', tag_names: null },
        { id: 'moment-2', content: 'another one', created_at: 1_700_000_000_001, slug: 'moment-2-slug', tag_names: null },
      ],
    })],
  ])
}

function mockDbWithTimeline(): MockDb {
  return makeDb([
    ["strftime('%Y'", async () => ({
      all: [
        { id: 't-note', title: 'Timeline post', created_at: 1_700_000_000_000, year: '2026', slug: 't-slug' },
        { id: 'old-note', title: 'Older post', created_at: 1_400_000_000_000, year: '2014', slug: 'old-slug' },
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

function mockDbWithAdjacent(): MockDb {
  return makeDb([
    ['s.note_id < ?4', async () => ({ first: { title: 'Older post', slug: 'older' } })],
    ['s.note_id > ?4', async () => ({ first: { title: 'Newer post', slug: 'newer' } })],
  ])
}

describe('blog queries', () => {
  it('getBlogOwner returns null for unknown username', async () => {
    expect(await getBlogOwner(mockDb(), 'nobody')).toBeNull()
  })

  it('hasBlogPassword reflects the blog password in app_meta', async () => {
    expect(await hasBlogPassword(mockDbWithPassword(), 'u1')).toBe(true)
    expect(await hasBlogPassword(mockDb(), 'u1')).toBe(false)
  })

  it('listBlogPosts excludes expired shares', async () => {
    const db = mockDbWithExpiredShare()
    const posts = await listBlogPosts(db, 'u1', 'all', 1, 10)
    expect(posts.posts.map((p) => p.id)).not.toContain('expired-note')
    expect(hasSql(db, 'n.deleted_at IS NULL')).toBe(true)
    expect(hasSql(db, '(s.expires_at IS NULL OR s.expires_at > ?2)')).toBe(true)
  })

  it('listBlogPosts excludes Moments-folder notes', async () => {
    const db = mockDbWithExpiredShare()
    await listBlogPosts(db, 'u1', 'all', 1, 10)
    expect(hasSql(db, "f2.name = 'Moments'")).toBe(true)
    expect(hasSql(db, 'f2.parent_id IS NULL')).toBe(true)
  })

  it('listBlogPosts excludes soft-deleted notes', async () => {
    const db = mockDbWithDeletedNote()
    const posts = await listBlogPosts(db, 'u1', 'all', 1, 10)
    expect(posts.posts.map((p) => p.id)).not.toContain('deleted-note')
    expect(hasSql(db, 'n.deleted_at IS NULL')).toBe(true)
  })

  it('tier public filters to blog-public tagged posts', async () => {
    const db = mockDbMixed()
    const posts = await listBlogPosts(db, 'u1', 'public', 1, 10)
    expect(posts.posts.map((p) => p.id)).toContain('public-note')
    expect(hasSql(db, "t2.name = 'blog-public'")).toBe(true)
    expect(hasSql(db, "t2.name IN ('blog-public', 'blog-private')")).toBe(false)
  })

  it('tier all includes both blog-public and blog-private tags', async () => {
    const db = mockDbMixed()
    const posts = await listBlogPosts(db, 'u1', 'all', 1, 10)
    expect(posts.posts.map((p) => p.id)).toContain('public-note')
    expect(hasSql(db, "t2.name IN ('blog-public', 'blog-private')")).toBe(true)
  })

  it('getBlogPost by slug and unknown slug returns null', async () => {
    const detail = await getBlogPost(mockDb(), 'u1', 'my-slug', 'all')
    expect(detail?.slug).toBe('my-slug')
    expect(await getBlogPost(mockDb(), 'u1', 'missing', 'all')).toBeNull()
  })

  it('getAdjacentPosts returns previous (older) and next (newer) posts', async () => {
    const db = mockDbWithAdjacent()
    const adjacent = await getAdjacentPosts(db, 'u1', 'all', 1_700_000_000_000, 'n1')
    expect(adjacent.previous).toEqual({ title: 'Older post', slug: 'older' })
    expect(adjacent.next).toEqual({ title: 'Newer post', slug: 'newer' })
    expect(hasSql(db, 's.created_at < ?3')).toBe(true)
    expect(hasSql(db, 's.created_at > ?3')).toBe(true)
    expect(hasSql(db, 'ORDER BY s.created_at DESC, s.note_id DESC')).toBe(true)
    expect(hasSql(db, 'ORDER BY s.created_at ASC, s.note_id ASC')).toBe(true)
  })

  it('getAdjacentPosts returns nulls when there are no neighbors', async () => {
    const adjacent = await getAdjacentPosts(mockDb(), 'u1', 'all', 1_700_000_000_000, 'n1')
    expect(adjacent).toEqual({ previous: null, next: null })
  })

  it('listBlogMoments returns moments from the root Moments folder', async () => {
    const db = mockDbWithMoments()
    const moments = await listBlogMoments(db, 'u1', 'all', 1, 20)
    expect(moments.moments.map((m) => m.id)).toEqual(['moment-1', 'moment-2'])
    expect(moments.moments[0]?.content).toBe('short note')
    expect(moments.moments[0]?.slug).toBe('moment-1-slug')
    expect(moments.page).toBe(1)
    expect(moments.hasMore).toBe(false)
    expect(hasSql(db, 'f.name = ?3')).toBe(true)
    expect(hasSql(db, 'f.parent_id IS NULL')).toBe(true)
    expect(hasSql(db, "t2.name = 'blog-public'")).toBe(false)
  })

  it('listBlogMoments gates implicit-private moments behind the blog session', async () => {
    const db = mockDbWithMoments()
    await listBlogMoments(db, 'u1', 'public', 1, 20)
    expect(hasSql(db, "t2.name = 'blog-public'")).toBe(true)
  })

  it('listBlogTimeline returns items with a year field', async () => {
    const db = mockDbWithTimeline()
    const items = await listBlogTimeline(db, 'u1', 'all', 1, 20)
    expect(items.items.map((i) => i.year)).toEqual(['2026', '2014'])
    expect(items.items[0]?.id).toBe('t-note')
    expect(items.items[0]?.slug).toBe('t-slug')
    expect(items.hasMore).toBe(false)
    expect(hasSql(db, "strftime('%Y'")).toBe(true)
  })

  it('listBlogTags returns tag counts', async () => {
    const db = mockDbWithTags()
    const tags = await listBlogTags(db, 'u1', 'all')
    expect(tags).toEqual([
      { name: 'a', count: 2 },
      { name: 'b', count: 1 },
    ])
  })

  it('listPostsByTag returns posts filtered by tag name', async () => {
    const db = mockDbWithPostsByTag()
    const posts = await listPostsByTag(db, 'u1', 'tag', 'all')
    expect(posts.map((p) => p.id)).toEqual(['tagged-note'])
    expect(hasSql(db, 'COLLATE NOCASE')).toBe(true)
  })
})
