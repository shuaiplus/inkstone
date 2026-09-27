import { describe, expect, it } from 'vitest'
import {
  ensureBlogShare,
  withdrawBlogShare,
  syncBlogShare,
  getBlogPasswordHash,
} from '../src/worker/blog/publish'

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

function makeDb(handlers: Array<[key: string, handler: Handler]>): MockDb {
  const resolve = (sql: string): Handler =>
    handlers.find(([key]) => sql.includes(key))?.[1] ?? (async () => ({ all: [], first: null }))
  return {
    preparedSqls: [],
    preparedArgs: [],
    prepare(sql: string) {
      this.preparedSqls.push(sql)
      const db = this
      const handler = resolve(sql)
      return {
        bind(...args: unknown[]) {
          db.preparedArgs.push(args)
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

const argsFor = (db: MockDb, fragment: string): unknown[][] =>
  db.preparedSqls
    .map((sql, i) => ({ sql, args: db.preparedArgs[i] }))
    .filter((entry) => entry.sql.includes(fragment))
    .map((entry) => entry.args)

interface PasswordOptions {
  customHash?: string | null
  accountHash?: string | null
}

function publishMockDb(options: PasswordOptions = {}): MockDb {
  return makeDb([
    ['app_meta', async () => ({ first: options.customHash ? { value: options.customHash } : null })],
    ['FROM users', async () => ({ first: options.accountHash ? { password_hash: options.accountHash } : null })],
  ])
}

describe('blog publish', () => {
  it('getBlogPasswordHash returns the custom blog password when set', async () => {
    const db = publishMockDb({ customHash: 'custom-hash', accountHash: 'acct-hash' })
    expect(await getBlogPasswordHash(db, 'u1')).toBe('custom-hash')
    expect(hasSql(db, 'FROM users')).toBe(false)
  })

  it('getBlogPasswordHash falls back to the account password', async () => {
    const db = publishMockDb({ accountHash: 'acct-hash' })
    expect(await getBlogPasswordHash(db, 'u1')).toBe('acct-hash')
    expect(hasSql(db, 'SELECT password_hash FROM users WHERE id = ?1')).toBe(true)
  })

  it('getBlogPasswordHash throws when no password is available', async () => {
    const db = publishMockDb({})
    await expect(getBlogPasswordHash(db, 'u1')).rejects.toThrow('Account password missing')
  })

  it('ensureBlogShare inserts a public share with a null password_hash', async () => {
    const db = makeDb([])
    await ensureBlogShare(db, 'u1', 'n1', 'public', 'hash')
    expect(hasSql(db, 'INSERT OR IGNORE INTO shares')).toBe(true)
    const insertArgs = argsFor(db, 'INSERT OR IGNORE INTO shares')[0]!
    expect(insertArgs[1]).toBe('n1')
    expect(insertArgs[2]).toBe('u1')
    expect(insertArgs[3]).toBeNull()
    const updateArgs = argsFor(db, 'UPDATE shares SET password_hash')[0]!
    expect(updateArgs[0]).toBeNull()
    expect(updateArgs[1]).toBe('n1')
    expect(updateArgs[2]).toBe('u1')
  })

  it('ensureBlogShare inserts a private share with the effective hash', async () => {
    const db = makeDb([])
    await ensureBlogShare(db, 'u1', 'n1', 'private', 'h1')
    expect(argsFor(db, 'INSERT OR IGNORE INTO shares')[0]![3]).toBe('h1')
    expect(argsFor(db, 'UPDATE shares SET password_hash')[0]![0]).toBe('h1')
  })

  it('ensureBlogShare updates password_hash on an existing share without a second row', async () => {
    const db = makeDb([])
    await ensureBlogShare(db, 'u1', 'n1', 'public', 'ignored')
    expect(argsFor(db, 'UPDATE shares SET password_hash')[0]![0]).toBeNull()
    await ensureBlogShare(db, 'u1', 'n1', 'private', 'h1')
    const updates = argsFor(db, 'UPDATE shares SET password_hash')
    expect(updates[1]![0]).toBe('h1')
    expect(hasSql(db, 'INSERT OR IGNORE INTO shares')).toBe(true)
  })

  it('withdrawBlogShare deletes the share row', async () => {
    const db = makeDb([])
    await withdrawBlogShare(db, 'u1', 'n1')
    expect(hasSql(db, 'DELETE FROM shares WHERE note_id = ?1 AND user_id = ?2')).toBe(true)
  })

  it('syncBlogShare withdraws when there are no blog tags', async () => {
    const db = makeDb([])
    await syncBlogShare(db, 'u1', 'n1', [])
    expect(hasSql(db, 'DELETE FROM shares WHERE note_id = ?1 AND user_id = ?2')).toBe(true)
    expect(hasSql(db, 'INSERT OR IGNORE INTO shares')).toBe(false)
  })

  it('syncBlogShare ensures a public share for the blog-public tag', async () => {
    const db = publishMockDb({ accountHash: 'acct-hash' })
    await syncBlogShare(db, 'u1', 'n1', ['blog-public'])
    expect(hasSql(db, 'INSERT OR IGNORE INTO shares')).toBe(true)
    expect(argsFor(db, 'UPDATE shares SET password_hash')[0]![0]).toBeNull()
  })

  it('syncBlogShare ensures a private share for the blog-private tag', async () => {
    const db = publishMockDb({ accountHash: 'acct-hash' })
    await syncBlogShare(db, 'u1', 'n1', ['blog-private'])
    expect(argsFor(db, 'UPDATE shares SET password_hash')[0]![0]).toBe('acct-hash')
  })
})
