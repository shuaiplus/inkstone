import { describe, expect, it, beforeAll } from 'vitest'
import { Hono } from 'hono'
import { blogRoutes } from '../src/worker/blog/routes'
import { errorResponse } from '../src/worker/lib/errors'
import { hashPassword } from '../src/worker/lib/password'
import type { AppBindings } from '../src/worker/env'

interface MockStatement {
  all<T = unknown>(): Promise<{ results: T[] }>
  first<T = unknown>(): Promise<T | null>
  run(): Promise<{ success: boolean }>
}

interface MockDb {
  prepare(sql: string): { bind(...args: unknown[]): MockStatement }
  batch(statements: MockStatement[]): Promise<unknown[]>
}

type MetaStore = Map<string, string>

interface DbOptions {
  users?: Record<string, string>
  meta?: MetaStore
  posts?: unknown[]
}

function makeDb(options: DbOptions = {}): MockDb {
  const users = new Map(Object.entries(options.users ?? {}))
  const meta = options.meta ?? new Map()
  const posts = options.posts ?? []
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all<T = unknown>() {
              if (sql.includes('SELECT locked_until FROM login_attempts'))
                return { results: [] as T[] }
              if (sql.includes('LIMIT ?3 OFFSET ?4'))
                return { results: posts as T[] }
              return { results: [] as T[] }
            },
            async first<T = unknown>() {
              if (sql.includes('SELECT id FROM users WHERE username')) {
                const id = users.get(String(args[0]))
                return (id ? { id } : null) as T | null
              }
              if (sql.includes('SELECT value FROM app_meta')) {
                const value = meta.get(String(args[0]))
                return (value === undefined ? null : { value }) as T | null
              }
              if (sql.includes('COUNT(*) AS count'))
                return { count: posts.length } as T | null
              return null as T | null
            },
            async run() {
              if (sql.includes('INSERT INTO app_meta')) {
                meta.set(String(args[0]), String(args[1]))
                return { success: true }
              }
              if (sql.includes('DELETE FROM app_meta')) {
                const prefix = String(args[0]).replace(/%$/, '')
                for (const key of [...meta.keys()]) {
                  if (key.startsWith(prefix)) meta.delete(key)
                }
                return { success: true }
              }
              return { success: true }
            },
          }
        },
      }
    },
    async batch(statements: MockStatement[]) {
      for (const statement of statements) await statement.run()
      return []
    },
  }
}

function makeApp() {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.route('/', blogRoutes)
  return app
}

function env(db: MockDb): AppBindings['Bindings'] {
  return { DB: db } as unknown as AppBindings['Bindings']
}

describe('blog routes', () => {
  let passwordHash = ''

  beforeAll(async () => {
    passwordHash = await hashPassword('secret')
  })

  it('returns 404 for an unknown username', async () => {
    const app = makeApp()
    const res = await app.request('/nobody/posts', {}, env(makeDb({ users: { alice: 'u1' } })))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Blog not found' } })
  })

  it('requires auth for GET /settings when no user session exists', async () => {
    const app = makeApp()
    const res = await app.request('/settings', {}, env(makeDb()))
    expect(res.status).toBe(401)
  })

  it('POST /:username/auth succeeds without a session and sets a session cookie', async () => {
    const meta: MetaStore = new Map([['blog_password_hash:u1', passwordHash]])
    const app = makeApp()
    const res = await app.request(
      '/alice/auth',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'secret' }),
      },
      env(makeDb({ users: { alice: 'u1' }, meta })),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('set-cookie') ?? '').toContain('blog_session_u1=')
  })

  it('returns 401 for a protected blog without a session cookie', async () => {
    const meta: MetaStore = new Map([['blog_password_hash:u1', passwordHash]])
    const app = makeApp()
    const res = await app.request('/alice/posts', {}, env(makeDb({ users: { alice: 'u1' }, meta })))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: { code: 'blog_auth_required', message: 'Blog authentication required' },
    })
  })

  it('returns 200 for a protected blog with a valid session cookie', async () => {
    const meta: MetaStore = new Map([
      ['blog_password_hash:u1', passwordHash],
      ['blog_session:u1:tok123', String(Date.now() + 60_000)],
    ])
    const app = makeApp()
    const res = await app.request(
      '/alice/posts',
      { headers: { Cookie: 'blog_session_u1=tok123' } },
      env(makeDb({ users: { alice: 'u1' }, meta })),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ posts: [], page: 1, hasMore: false })
  })

  it('returns 200 for a public blog without any cookie', async () => {
    const app = makeApp()
    const res = await app.request('/alice/posts', {}, env(makeDb({ users: { alice: 'u1' } })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ posts: [], page: 1, hasMore: false })
  })

  it('returns 401 for an incorrect blog password', async () => {
    const meta: MetaStore = new Map([['blog_password_hash:u1', passwordHash]])
    const app = makeApp()
    const res = await app.request(
      '/alice/auth',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      },
      env(makeDb({ users: { alice: 'u1' }, meta })),
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: { code: 'invalid_credentials', message: 'Invalid blog password' },
    })
  })
})
