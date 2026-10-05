import { describe, expect, it } from 'vitest'
import { reseedMomentsClassification, seedBlogTables } from '../src/worker/blog/seed'

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
  preparedArgs: unknown[][]
  prepare(sql: string): { bind(...args: unknown[]): MockStatement }
}

type Handler = (args: unknown[]) => Promise<{ all?: MockRow[]; first?: MockRow | null }>

function makeDb(
  handlers: Array<[key: string, handler: Handler]>,
  runs: string[] = [],
): MockDb {
  const resolve = (sql: string): Handler =>
    handlers.find(([key]) => sql.includes(key))?.[1] ?? (async () => ({ all: [], first: null }))
  return {
    preparedSqls: [],
    preparedArgs: [],
    prepare(sql: string) {
      this.preparedSqls.push(sql)
      const db = this
      const handler = resolve(sql)
      const statement = (args: unknown[]) => ({
        async all<T = MockRow>() {
          const out = await handler(args)
          return { results: (out.all ?? []) as T[] }
        },
        async first<T = MockRow>() {
          const out = await handler(args)
          return (out.first ?? null) as T | null
        },
        async run() {
          runs.push(sql)
          return { success: true }
        },
      })
      return {
        ...statement([]),
        bind(...args: unknown[]) {
          db.preparedArgs.push(args)
          return statement(args)
        },
      }
    },
  }
}

const hasSql = (db: MockDb, fragment: string): boolean =>
  db.preparedSqls.some((sql) => sql.includes(fragment))

function seedDb(overrides: { meta?: Record<string, string>; users?: MockRow[]; shares?: MockRow[]; tagNames?: string[]; sessions?: MockRow[]; resyncNotes?: MockRow[] }): { db: MockDb; runs: string[] } {
  const runs: string[] = []
  const db = makeDb([
    ['SELECT key, value FROM app_meta', async () => ({ all: overrides.sessions ?? [] })],
    ['FROM app_meta', async (args) => {
      const key = args[0] as string
      if (key === 'blog_seed:v14' || key === 'blog_seed:moments-tags-v1') return { first: null }
      const value = overrides.meta?.[key]
      return { first: value !== undefined ? { value } : null }
    }],
    ['FROM users', async () => ({ all: overrides.users ?? [{ id: 'u1', password_hash: 'acct-hash' }] })],
    ['FROM shares', async () => ({ all: overrides.shares ?? [] })],
    ['FROM notes n', async () => ({ all: overrides.resyncNotes ?? [] })],
    ['FROM note_tags', async () => ({ all: (overrides.tagNames ?? []).map((name) => ({ name })) })],
  ], runs)
  return { db, runs }
}

describe('seedBlogTables', () => {
  it('writes blog_settings from app_meta with account-password fallback', async () => {
    const { db } = seedDb({ meta: { 'blog_title:u1': 'My Blog' } })
    await seedBlogTables(db as unknown as D1Database)
    expect(hasSql(db, 'INSERT OR IGNORE INTO blog_settings')).toBe(true)
    const markerWrites = db.preparedArgs.filter((args) => args[0] === 'blog_seed:v14' && args[1] === 'done')
    expect(markerWrites.length).toBe(1)
  })

  it('backfills one blog_post per share with frozen published_at', async () => {
    const { db } = seedDb({
      shares: [{ slug: 'hello', note_id: 'n1', created_at: 1000 }],
      tagNames: ['blog-public'],
    })
    await seedBlogTables(db as unknown as D1Database)
    expect(hasSql(db, 'INSERT OR IGNORE INTO blog_posts')).toBe(true)
  })

  it('skips expired shares and trashed notes', async () => {
    const { db } = seedDb({
      shares: [{ slug: 'hello', note_id: 'n1', created_at: 1000 }],
      tagNames: ['blog-public'],
    })
    await seedBlogTables(db as unknown as D1Database)
    expect(hasSql(db, 's.expires_at IS NULL')).toBe(true)
    expect(hasSql(db, 'n.deleted_at IS NULL')).toBe(true)
  })

  it('classifies moments purely by tag', async () => {
    const { db } = seedDb({
      shares: [{ slug: 'm1', note_id: 'n1', created_at: 1000 }],
      tagNames: ['moment-private'],
    })
    await seedBlogTables(db as unknown as D1Database)
    const inserts = db.preparedArgs.filter((args) => args[2] === 'm1')
    expect(inserts.length).toBe(1)
    expect(inserts[0]).toContain('private')
    expect(inserts[0]).toContain('moment')
  })

  it('moves blog sessions into blog_sessions and clears old keys', async () => {
    const { db } = seedDb({
      sessions: [{ key: 'blog_session:u1:tok', value: '9999999999999' }],
    })
    await seedBlogTables(db as unknown as D1Database)
    expect(hasSql(db, 'INSERT OR IGNORE INTO blog_sessions')).toBe(true)
    expect(hasSql(db, 'DELETE FROM app_meta')).toBe(true)
  })

  it('skips work when the seed marker is set', async () => {
    const runs: string[] = []
    const db = makeDb([
      ['FROM app_meta', async () => ({ first: { value: 'done' } })],
    ], runs)
    await seedBlogTables(db as unknown as D1Database)
    expect(hasSql(db, 'INSERT OR IGNORE INTO blog_settings')).toBe(false)
  })
})

describe('reseedMomentsClassification', () => {
  it('recomputes kinds from tags and marks completion', async () => {
    const { db } = seedDb({
      resyncNotes: [{ id: 'n1', tag_names: 'moment-public' }],
      tagNames: ['moment-public'],
    })
    await reseedMomentsClassification(db as unknown as D1Database)
    expect(hasSql(db, 'INSERT INTO blog_posts')).toBe(true)
    const markers = db.preparedArgs.filter((args) => args[0] === 'blog_seed:moments-tags-v1' && args[1] === 'done')
    expect(markers.length).toBe(1)
  })

  it('skips work when the reseed marker is set', async () => {
    const runs: string[] = []
    const db = makeDb([
      ['FROM app_meta', async (args) => ({
        first: args[0] === 'blog_seed:moments-tags-v1' ? { value: 'done' } : null,
      })],
    ], runs)
    await reseedMomentsClassification(db as unknown as D1Database)
    expect(hasSql(db, 'INSERT INTO blog_posts')).toBe(false)
  })
})
