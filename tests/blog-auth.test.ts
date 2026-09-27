import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest'
import { blogAuthMiddleware, handleBlogAuth, validateBlogSession } from '../src/worker/blog/auth'
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

function mockContext(overrides: { ownerId?: string; cookie?: string; db: MockDb }) {
  const headers = new Headers()
  if (overrides.cookie) headers.set('Cookie', overrides.cookie)
  const json = vi.fn((body: unknown, status?: number) => ({ body, status }))
  const c = {
    req: {
      url: 'https://blog.example.com/',
      raw: { headers },
    },
    env: { DB: overrides.db },
    get: (key: string) => (key === 'blogOwnerId' ? overrides.ownerId : undefined),
    json,
  }
  const next = vi.fn(async () => {})
  return { c, next, json }
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

  it('rejects an expired token', async () => {
    const db = makeMetaDb(new Map([['blog_session:u1:old', String(Date.now() - 1000)]]))
    expect(await validateBlogSession(db, 'u1', 'old')).toBe(false)
  })

  it('blogAuthMiddleware returns 401 for a bogus session cookie', async () => {
    const { c, next, json } = mockContext({
      ownerId: 'u1',
      cookie: 'blog_session_u1=bogus',
      db: mockDbWithPassword(),
    })
    const res = await blogAuthMiddleware(c, next)
    expect(json).toHaveBeenCalledWith(
      { error: { code: 'blog_auth_required', message: 'Blog authentication required' } },
      401,
    )
    expect(next).not.toHaveBeenCalled()
    expect(res).toBeTruthy()
  })

  it('blogAuthMiddleware allows a valid session cookie through', async () => {
    const token = await handleBlogAuth(mockDbWithPassword(), 'u1', 'secret')
    const { c, next } = mockContext({
      ownerId: 'u1',
      cookie: `blog_session_u1=${token}`,
      db: mockDbWithPassword(),
    })
    await blogAuthMiddleware(c, next)
    expect(next).toHaveBeenCalled()
  })
})
