import { describe, expect, it, beforeAll, beforeEach } from 'vitest'
import { handleBlogAuth, validateBlogSession } from '../src/worker/blog/auth'
import { hashPassword } from '../src/worker/lib/password'

interface MockStatement {
  all<T = unknown>(): Promise<{ results: T[] }>
  first<T = unknown>(): Promise<T | null>
  run(): Promise<{ success: boolean }>
}

interface MockDb {
  prepare(sql: string): { bind(...args: unknown[]): MockStatement }
}

type MetaStore = Map<string, string>

function makeMetaDb(store: MetaStore): MockDb {
  return {
    prepare(sql: string) {
      if (sql.includes('INSERT INTO app_meta')) {
        return {
          bind(...args: unknown[]) {
            return {
              async all<T = unknown>() {
                return { results: [] as T[] }
              },
              async first<T = unknown>() {
                return null as T | null
              },
              async run() {
                store.set(String(args[0]), String(args[1]))
                return { success: true }
              },
            }
          },
        }
      }
      if (sql.includes('app_meta')) {
        return {
          bind(...args: unknown[]) {
            return {
              async all<T = unknown>() {
                return { results: [] as T[] }
              },
              async first<T = unknown>() {
                const value = store.get(String(args[0]))
                return (value === undefined ? null : { value }) as T | null
              },
              async run() {
                return { success: true }
              },
            }
          },
        }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
  }
}

const sharedStore: MetaStore = new Map()
let passwordHash = ''

beforeAll(async () => {
  passwordHash = await hashPassword('secret')
})

beforeEach(() => {
  sharedStore.clear()
  sharedStore.set('blog_password_hash:u1', passwordHash)
})

function mockDbNoMeta(): MockDb {
  return makeMetaDb(new Map())
}

function mockDbWithPassword(): MockDb {
  return makeMetaDb(sharedStore)
}

describe('blog auth', () => {
  it('returns null when no password is set', async () => {
    expect(await handleBlogAuth(mockDbNoMeta(), 'u1', 'secret')).toBeNull()
  })

  it('returns null for wrong password', async () => {
    expect(await handleBlogAuth(mockDbWithPassword(), 'u1', 'wrong')).toBeNull()
  })

  it('returns a token for correct password and validates it', async () => {
    const token = await handleBlogAuth(mockDbWithPassword(), 'u1', 'secret')
    expect(token).toBeTruthy()
    expect(await validateBlogSession(mockDbWithPassword(), 'u1', token!)).toBe(true)
  })

  it('rejects invalid or expired tokens', async () => {
    expect(await validateBlogSession(mockDbNoMeta(), 'u1', 'bogus')).toBe(false)
  })
})
