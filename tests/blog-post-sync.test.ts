import { describe, expect, it } from 'vitest'
import { syncBlogPost, withdrawBlogPost } from '../src/worker/blog/publish'

interface MockRow {
  [key: string]: unknown
}

function makeDb(handlers: Array<[key: string, (args: unknown[]) => Promise<{ all?: MockRow[]; first?: MockRow | null }>]>): {
  db: unknown
  sqls: string[]
  args: unknown[][]
} {
  const sqls: string[] = []
  const args: unknown[][] = []
  const resolve = (sql: string) =>
    handlers.find(([key]) => sql.includes(key))?.[1] ?? (async () => ({ all: [], first: null }))
  const db = {
    prepare(sql: string) {
      sqls.push(sql)
      const handler = resolve(sql)
      const statement = (a: unknown[]) => ({
        async all<T = MockRow>() {
          return { results: ((await handler(a)).all ?? []) as T[] }
        },
        async first<T = MockRow>() {
          return ((await handler(a)).first ?? null) as T | null
        },
        async run() {
          return { success: true }
        },
      })
      return { ...statement([]), bind(...a: unknown[]) { args.push(a); return statement(a) } }
    },
  }
  return { db, sqls, args }
}

const SETTINGS_ROW = {
  title: '',
  description: '',
  settings_json: '{"publicTag":"blog-public","privateTag":"blog-private","momentsTag":"moment"}',
}

function syncDb(overrides: { existingSlug?: string | null } = {}): ReturnType<typeof makeDb> {
  return makeDb([
    ['FROM blog_settings', async () => ({ first: SETTINGS_ROW })],
    ['FROM blog_posts', async () => ({ first: overrides.existingSlug ? { slug: overrides.existingSlug } : null })],
  ])
}

const hasSql = (sqls: string[], fragment: string): boolean => sqls.some((sql) => sql.includes(fragment))

describe('syncBlogPost', () => {
  it('writes a public post row instead of a share', async () => {
    const { db, sqls } = syncDb()
    await syncBlogPost(db as unknown as D1Database, 'u1', 'n1', ['blog-public'])
    expect(hasSql(sqls, 'INSERT INTO blog_posts')).toBe(true)
    expect(hasSql(sqls, 'INTO shares')).toBe(false)
  })

  it('freezes slug and published_at on re-sync, updating visibility only', async () => {
    const { db, sqls, args } = syncDb({ existingSlug: 'keep-me' })
    await syncBlogPost(db as unknown as D1Database, 'u1', 'n1', ['blog-private'])
    expect(hasSql(sqls, 'INSERT INTO blog_posts')).toBe(false)
    const update = sqls.findIndex((sql) => sql.includes('UPDATE blog_posts'))
    expect(update).toBeGreaterThan(-1)
    expect(args[args.length - 1]).toContain('private')
  })

  it('withdraws the post row when no blog tier matches', async () => {
    const { db, sqls } = syncDb()
    await syncBlogPost(db as unknown as D1Database, 'u1', 'n1', ['random'])
    expect(hasSql(sqls, 'DELETE FROM blog_posts')).toBe(true)
  })

  it('marks kind as moment for a public moment (moments + public tags)', async () => {
    const { db, args } = syncDb()
    await syncBlogPost(db as unknown as D1Database, 'u1', 'n1', ['moment', 'blog-public'])
    const insertArgs = args.find((a) => a.includes('public') || a.includes('moment'))
    expect(insertArgs).toBeDefined()
    expect(insertArgs).toContain('moment')
  })

  it('marks a private moment for moments + private tags', async () => {
    const { db, args } = syncDb()
    await syncBlogPost(db as unknown as D1Database, 'u1', 'n1', ['moment', 'blog-private'])
    const insertArgs = args.find((a) => a.includes('moment'))
    expect(insertArgs).toBeDefined()
    expect(insertArgs).toContain('private')
    expect(insertArgs).toContain('moment')
  })

  it('publishes nothing for a bare moments tag', async () => {
    const { db, sqls } = syncDb()
    await syncBlogPost(db as unknown as D1Database, 'u1', 'n1', ['moment'])
    expect(hasSql(sqls, 'INSERT INTO blog_posts')).toBe(false)
    expect(hasSql(sqls, 'DELETE FROM blog_posts')).toBe(true)
  })

  it('withdrawBlogPost deletes only the post row', async () => {
    const { db, sqls } = syncDb()
    await withdrawBlogPost(db as unknown as D1Database, 'u1', 'n1')
    expect(hasSql(sqls, 'DELETE FROM blog_posts')).toBe(true)
    expect(hasSql(sqls, 'DELETE FROM shares')).toBe(false)
  })

  it('retries a slug collision but surfaces non-unique errors', async () => {
    let inserts = 0
    const sqls: string[] = []
    const flaky = {
      prepare(sql: string) {
        sqls.push(sql)
        return {
          bind(..._args: unknown[]) {
            return {
              async all<T>() {
                return { results: [] as T[] }
              },
              async first() {
                if (sql.includes('FROM blog_settings')) return SETTINGS_ROW as never
                return null as never
              },
              async run() {
                if (sql.includes('INSERT INTO blog_posts')) {
                  inserts++
                  if (inserts === 1) throw new Error('UNIQUE constraint failed: blog_posts.slug')
                }
                return { success: true, meta: { changes: 1 } }
              },
            }
          },
        }
      },
    }
    await syncBlogPost(flaky as unknown as D1Database, 'u1', 'n1', ['blog-public'])
    expect(inserts).toBe(2)
    const failing = {
      prepare() {
        return {
          bind(..._args: unknown[]) {
            return {
              async all<T>() {
                return { results: [] as T[] }
              },
              async first() {
                return null as never
              },
              async run(): Promise<never> {
                throw new Error('boom')
              },
            }
          },
        }
      },
    }
    await expect(syncBlogPost(failing as unknown as D1Database, 'u1', 'n1', ['blog-public'])).rejects.toThrow('boom')
  })
})
