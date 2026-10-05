import { describe, expect, it, beforeAll } from 'vitest'
import { Hono } from 'hono'
import { blogRoutes } from '../src/worker/blog/routes'
import { shareManageRoutes } from '../src/worker/routes/share'
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
  accountHash?: string
  meta?: MetaStore
  posts?: unknown[]
  postDetail?: unknown
  blogPrivateNoteIds?: string[]
  userSettings?: Record<string, string>
}

function makeDb(options: DbOptions = {}): MockDb & { preparedSqls: string[] } {
  const users = new Map(Object.entries(options.users ?? {}))
  const meta = options.meta ?? new Map()
  const userSettings = new Map(Object.entries(options.userSettings ?? {}))
  const posts = options.posts ?? []
  const preparedSqls: string[] = []
  return {
    preparedSqls,
    prepare(sql: string) {
      preparedSqls.push(sql)
      return {
        bind(...args: unknown[]) {
          return {
            async all<T = unknown>() {
              if (sql.includes('SELECT locked_until FROM login_attempts'))
                return { results: [] as T[] }
              if (sql.includes('JOIN note_tags nt ON nt.note_id = n.id'))
                return { results: (options.blogPrivateNoteIds ?? []).map((id) => ({ id })) as T[] }
              if (sql.includes('LIMIT ?3 OFFSET ?4'))
                return { results: posts as T[] }
              return { results: [] as T[] }
            },
            async first<T = unknown>() {
              if (sql.includes('SELECT id FROM users WHERE username')) {
                const id = users.get(String(args[0]))
                return (id ? { id } : null) as T | null
              }
              if (sql.includes('SELECT password_hash FROM users')) {
                return (options.accountHash ? { password_hash: options.accountHash } : null) as T | null
              }
              if (sql.includes('SELECT settings FROM users')) {
                const settings = userSettings.get(String(args[0]))
                return (settings === undefined ? null : { settings }) as T | null
              }
              if (sql.includes('SELECT value FROM app_meta')) {
                const value = meta.get(String(args[0]))
                return (value === undefined ? null : { value }) as T | null
              }
              if (sql.includes('COUNT(*) AS count'))
                return { count: posts.length } as T | null
              if (sql.includes('n.content'))
                return (options.postDetail ?? null) as T | null
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

function makeAuthedApp() {
  const app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    c.set('userId', 'u1')
    await next()
  })
  app.onError((err, c) => errorResponse(c, err))
  app.route('/', blogRoutes)
  return app
}

function makeShareDb(): MockDb {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all<T = unknown>() {
              return { results: [] as T[] }
            },
            async first<T = unknown>() {
              if (sql.includes('FROM shares WHERE note_id')) {
                return {
                  slug: 'abc123',
                  note_id: 'n1',
                  user_id: 'u1',
                  password_hash: null,
                  expires_at: null,
                  views: 0,
                  created_at: 1700000000000,
                } as T | null
              }
              return null as T | null
            },
            async run() {
              return { success: true }
            },
          }
        },
      }
    },
    async batch() {
      return []
    },
  }
}

function env(db: MockDb): AppBindings['Bindings'] {
  return { DB: db } as unknown as AppBindings['Bindings']
}

function privatePostDetail() {
  return {
    id: 'n1',
    title: 'Private',
    excerpt: '',
    created_at: 1700000000000,
    updated_at: 1700000000000,
    slug: 'private-post',
    visibility: 'private',
    tag_names: 'blog-private',
    content: 'hello',
  }
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

  it('POST /:username/auth succeeds with the account password when no custom password is set', async () => {
    const app = makeApp()
    const res = await app.request(
      '/alice/auth',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'secret' }),
      },
      env(makeDb({ users: { alice: 'u1' }, accountHash: passwordHash })),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('set-cookie') ?? '').toContain('blog_session_u1=')
  })

  it('returns 200 for a blog with a custom password but no session cookie (anonymous browses public)', async () => {
    const meta: MetaStore = new Map([['blog_password_hash:u1', passwordHash]])
    const app = makeApp()
    const res = await app.request('/alice/posts', {}, env(makeDb({ users: { alice: 'u1' }, meta })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ posts: [], page: 1, hasMore: false, totalPages: 0 })
  })

  it('anonymous /posts serves the public tier', async () => {
    const db = makeDb({ users: { alice: 'u1' } })
    const app = makeApp()
    const res = await app.request('/alice/posts', {}, env(db))
    expect(res.status).toBe(200)
    const postsSql = db.preparedSqls.find((s) => s.includes('LIMIT ? OFFSET ?'))
    expect(postsSql).toContain("bp.visibility = 'public'")
  })

  it('/meta includes the owner appearance accent', async () => {
    const db = makeDb({
      users: { alice: 'u1' },
      userSettings: { u1: JSON.stringify({ appearance: { accent: 'wisteria' } }) },
    })
    const app = makeApp()
    const res = await app.request('/alice/meta', {}, env(db))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.accent).toBe('wisteria')
    expect(body.username).toBe('alice')
  })

  it('/meta falls back to cinnabar when the owner has no accent set', async () => {
    const db = makeDb({ users: { alice: 'u1' } })
    const app = makeApp()
    const res = await app.request('/alice/meta', {}, env(db))
    expect(res.status).toBe(200)
    expect((await res.json()).accent).toBe('cinnabar')
  })

  it('a valid session on /posts serves the all tier', async () => {
    const meta: MetaStore = new Map([['blog_session:u1:tok123', String(Date.now() + 60_000)]])
    const db = makeDb({ users: { alice: 'u1' }, meta })
    const app = makeApp()
    const res = await app.request(
      '/alice/posts',
      { headers: { Cookie: 'blog_session_u1=tok123' } },
      env(db),
    )
    expect(res.status).toBe(200)
    const postsSql = db.preparedSqls.find((s) => s.includes('LIMIT ? OFFSET ?'))
    expect(postsSql).toContain("bp.visibility IN ('public', 'private')")
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
    expect(await res.json()).toEqual({ posts: [], page: 1, hasMore: false, totalPages: 0 })
  })

  it('returns 200 for a public blog without any cookie', async () => {
    const app = makeApp()
    const res = await app.request('/alice/posts', {}, env(makeDb({ users: { alice: 'u1' } })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ posts: [], page: 1, hasMore: false, totalPages: 0 })
  })

  it('GET /:username/session reports anonymous without a session cookie', async () => {
    const app = makeApp()
    const res = await app.request('/alice/session', {}, env(makeDb({ users: { alice: 'u1' } })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ authed: false })
  })

  it('GET /:username/session reports authed with a valid session cookie', async () => {
    const meta: MetaStore = new Map([['blog_session:u1:tok123', String(Date.now() + 60_000)]])
    const app = makeApp()
    const res = await app.request(
      '/alice/session',
      { headers: { Cookie: 'blog_session_u1=tok123' } },
      env(makeDb({ users: { alice: 'u1' }, meta })),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ authed: true })
  })

  it('POST /:username/logout clears the blog session and cookie', async () => {
    const meta: MetaStore = new Map([['blog_session:u1:tok123', String(Date.now() + 60_000)]])
    const app = makeApp()
    const res = await app.request(
      '/alice/logout',
      { method: 'POST', headers: { Cookie: 'blog_session_u1=tok123' } },
      env(makeDb({ users: { alice: 'u1' }, meta })),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('set-cookie') ?? '').toContain('blog_session_u1=')
    const session = await app.request(
      '/alice/session',
      { headers: { Cookie: 'blog_session_u1=tok123' } },
      env(makeDb({ users: { alice: 'u1' }, meta })),
    )
    expect(await session.json()).toEqual({ authed: false })
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

  it('GET /settings reports hasCustomPassword true when a custom password is set', async () => {
    const meta: MetaStore = new Map([['blog_password_hash:u1', passwordHash]])
    const app = makeAuthedApp()
    const res = await app.request('/settings', {}, env(makeDb({ users: { alice: 'u1' }, meta })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hasCustomPassword: true, title: null, description: null, publicTag: 'blog-public', privateTag: 'blog-private' })
  })

  it('GET /settings reports hasCustomPassword false when no custom password is set', async () => {
    const app = makeAuthedApp()
    const res = await app.request('/settings', {}, env(makeDb({ users: { alice: 'u1' } })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hasCustomPassword: false, title: null, description: null, publicTag: 'blog-public', privateTag: 'blog-private' })
  })

  it('PUT /settings with password null clears the custom password without touching posts', async () => {
    const meta: MetaStore = new Map([['blog_password_hash:u1', passwordHash]])
    const db = makeDb({
      users: { alice: 'u1' },
      accountHash: passwordHash,
      meta,
      blogPrivateNoteIds: ['n1'],
    })
    const app = makeAuthedApp()
    const res = await app.request(
      '/settings',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: null }),
      },
      env(db),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(meta.get('blog_password_hash:u1')).toBe('')
    expect(db.preparedSqls.some((s) => s.includes('UPDATE shares SET password_hash'))).toBe(false)
    expect(db.preparedSqls.some((s) => s.includes('blog_posts'))).toBe(false)
  })

  it('PUT /settings with password "" clears the custom password and auth reverts to the account password', async () => {
    const meta: MetaStore = new Map([['blog_password_hash:u1', passwordHash]])
    const db = makeDb({ users: { alice: 'u1' }, accountHash: passwordHash, meta })
    const app = makeAuthedApp()
    const res = await app.request(
      '/settings',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: '' }),
      },
      env(db),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(meta.get('blog_password_hash:u1')).toBe('')

    const settings = await app.request('/settings', {}, env(db))
    expect(await settings.json()).toEqual({ hasCustomPassword: false, title: null, description: null, publicTag: 'blog-public', privateTag: 'blog-private' })

    const auth = await app.request(
      '/alice/auth',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'secret' }),
      },
      env(db),
    )
    expect(auth.status).toBe(200)
    expect(await auth.json()).toEqual({ ok: true })
  })

  it('PUT /settings with a non-empty password sets the custom password, old account password fails, new custom password succeeds', async () => {
    const db = makeDb({
      users: { alice: 'u1' },
      accountHash: passwordHash,
      blogPrivateNoteIds: ['n1'],
    })
    const app = makeAuthedApp()
    const res = await app.request(
      '/settings',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'newsecret' }),
      },
      env(db),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(db.preparedSqls.some((s) => s.includes('UPDATE shares SET password_hash'))).toBe(false)
    expect(db.preparedSqls.some((s) => s.includes('blog_posts'))).toBe(false)

    const settings = await app.request('/settings', {}, env(db))
    expect(await settings.json()).toEqual({ hasCustomPassword: true, title: null, description: null, publicTag: 'blog-public', privateTag: 'blog-private' })

    const oldAuth = await app.request(
      '/alice/auth',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'secret' }),
      },
      env(db),
    )
    expect(oldAuth.status).toBe(401)

    const newAuth = await app.request(
      '/alice/auth',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'newsecret' }),
      },
      env(db),
    )
    expect(newAuth.status).toBe(200)
    expect(await newAuth.json()).toEqual({ ok: true })
  })

  it('posts/:slug returns 401 for a blog-private post without a session', async () => {
    const db = makeDb({ users: { alice: 'u1' }, postDetail: privatePostDetail() })
    const app = makeApp()
    const res = await app.request('/alice/posts/private-post', {}, env(db))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: { code: 'blog_auth_required', message: 'Blog authentication required' },
    })
  })

  it('posts/:slug returns 200 for a blog-private post with a session', async () => {
    const meta: MetaStore = new Map([['blog_session:u1:tok123', String(Date.now() + 60_000)]])
    const db = makeDb({ users: { alice: 'u1' }, meta, postDetail: privatePostDetail() })
    const app = makeApp()
    const res = await app.request(
      '/alice/posts/private-post',
      { headers: { Cookie: 'blog_session_u1=tok123' } },
      env(db),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      id: 'n1', slug: 'private-post', tags: ['blog-private'], previous: null, next: null,
    })
  })

  it('GET /:username/moments returns the paged moments response without a session', async () => {
    const app = makeApp()
    const res = await app.request('/alice/moments', {}, env(makeDb({ users: { alice: 'u1' } })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ moments: [], page: 1, hasMore: false })
  })

  it('GET /:username/timeline returns the paged timeline response', async () => {
    const app = makeApp()
    const res = await app.request('/alice/timeline', {}, env(makeDb({ users: { alice: 'u1' } })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [], page: 1, hasMore: false })
  })

  it('share get response omits blogPublished', async () => {
    const app = new Hono<AppBindings>()
    app.use('/api/share/*', async (c, next) => {
      c.set('userId', 'u1')
      await next()
    })
    app.onError((err, c) => errorResponse(c, err))
    app.route('/api/share', shareManageRoutes)
    const res = await app.request('/api/share/n1', {}, env(makeShareDb()))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { share: Record<string, unknown> }
    expect(body.share).not.toHaveProperty('blogPublished')
  })
})
