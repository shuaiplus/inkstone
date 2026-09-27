import { describe, expect, it } from 'vitest'
import { getBlogOwner, listBlogPosts, getBlogPost } from '../src/worker/blog/queries'

interface MockRow {
  [key: string]: unknown
}

interface MockStatement {
  all<T = MockRow>(): Promise<{ results: T[] }>
  first<T = MockRow>(): Promise<T | null>
  run(): Promise<{ success: boolean }>
}

interface MockDb {
  prepare(sql: string): { bind(...args: unknown[]): MockStatement }
}

type Handler = (args: unknown[]) => Promise<{ all?: MockRow[]; first?: MockRow | null }>

function makeDb(handlers: Array<[key: string, handler: Handler]>): MockDb {
  const resolve = (sql: string): Handler =>
    handlers.find(([key]) => sql.includes(key))?.[1] ?? (async () => ({ all: [], first: null }))
  return {
    prepare(sql: string) {
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

const post = (overrides: Partial<MockRow> = {}): MockRow => ({
  id: 'note-1',
  title: 'A post',
  excerpt: 'excerpt',
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  slug: 'my-slug',
  tag_names: null,
  ...overrides,
})

function mockDb(): MockDb {
  return makeDb([
    ['FROM users', async () => ({ first: null })],
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

describe('blog queries', () => {
  it('getBlogOwner returns null for unknown username', async () => {
    expect(await getBlogOwner(mockDb(), 'nobody')).toBeNull()
  })

  it('listBlogPosts excludes expired shares', async () => {
    const posts = await listBlogPosts(mockDbWithExpiredShare(), 'u1', false, 1, 10)
    expect(posts.posts.map((p) => p.id)).not.toContain('expired-note')
  })

  it('listBlogPosts excludes soft-deleted notes', async () => {
    const posts = await listBlogPosts(mockDbWithDeletedNote(), 'u1', false, 1, 10)
    expect(posts.posts.map((p) => p.id)).not.toContain('deleted-note')
  })

  it('onlyPublic excludes password-protected shares', async () => {
    const posts = await listBlogPosts(mockDbMixed(), 'u1', true, 1, 10)
    expect(posts.posts.map((p) => p.id)).not.toContain('private-note')
    expect(posts.posts.map((p) => p.id)).toContain('public-note')
  })

  it('getBlogPost by slug and unknown slug returns null', async () => {
    const detail = await getBlogPost(mockDb(), 'u1', 'my-slug', false)
    expect(detail?.slug).toBe('my-slug')
    expect(await getBlogPost(mockDb(), 'u1', 'missing', false)).toBeNull()
  })
})
