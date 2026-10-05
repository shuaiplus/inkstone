import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest'
import { blogAuthMiddleware, handleBlogAuth, validateBlogSession, clearBlogSession, getBlogAccent, setBlogPassword } from '../src/worker/blog/auth'
import { trackAccountPasswordChange } from '../src/worker/blog/settings'
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

interface MetaDbOptions {
  accountHash?: string
}

interface MetaDbOptions {
  accountHash?: string
}

interface SessionRow {
  userId: string
  expiresAt: number
}

function makeMetaDb(store: MetaStore, options: MetaDbOptions = {}): MockDb & { sqls: string[]; sessions: Map<string, SessionRow> } {
  const sqls: string[] = []
  const settings = new Map<string, string>()
  const customHash = store.get('blog_password_hash:u1')
  if (customHash) settings.set('u1', customHash)
  const sessions = new Map<string, SessionRow>()
  for (const [key, value] of store) {
    const match = /^blog_session:([^:]+):(.+)$/.exec(key)
    if (match) sessions.set(match[2]!, { userId: match[1]!, expiresAt: Number(value) })
  }
  const statementFor = (sql: string, args: unknown[]): MockStatement => ({
    async all<T = unknown>() {
      return { results: [] as T[] }
    },
    async first<T = unknown>() {
      if (sql.includes('SELECT password_hash FROM blog_settings')) {
        const hash = settings.get(String(args[0]))
        return (hash === undefined ? null : { password_hash: hash }) as T | null
      }
      if (sql.includes('SELECT password_hash FROM users')) {
        return (options.accountHash ? { password_hash: options.accountHash } : null) as T | null
      }
      if (sql.includes('SELECT expires_at FROM blog_sessions')) {
        const row = sessions.get(String(args[0]))
        return (row === undefined ? null : { expires_at: row.expiresAt }) as T | null
      }
      if (sql.includes('SELECT value FROM app_meta') || sql.includes('app_meta')) {
        const value = store.get(String(args[0]))
        return (value === undefined ? null : { value }) as T | null
      }
      return null as T | null
    },
    async run() {
      if (sql.includes('INSERT INTO blog_settings')) {
        settings.set(String(args[0]), String(args[1]))
        return { success: true }
      }
      if (sql.includes('INSERT INTO blog_sessions')) {
        sessions.set(String(args[0]), { userId: String(args[1]), expiresAt: Number(args[2]) })
        return { success: true }
      }
      if (sql.includes('DELETE FROM blog_sessions')) {
        if (sql.includes('WHERE token')) sessions.delete(String(args[0]))
        else for (const [token, row] of [...sessions]) {
          if (row.userId === String(args[0])) sessions.delete(token)
        }
        return { success: true }
      }
      if (sql.includes('INSERT INTO app_meta')) {
        store.set(String(args[0]), String(args[1]))
        return { success: true }
      }
      if (sql.includes('DELETE FROM app_meta')) {
        store.delete(String(args[0]))
        return { success: true }
      }
      return { success: true }
    },
  })
  return {
    sqls,
    sessions,
    prepare(sql: string) {
      sqls.push(sql)
      if (
        sql.includes('blog_settings') ||
        sql.includes('blog_sessions') ||
        sql.includes('SELECT password_hash FROM users') ||
        sql.includes('app_meta')
      ) {
        return { bind(...args: unknown[]) { return statementFor(sql, args) } }
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

function mockDbWithAccountPassword(): MockDb {
  return makeMetaDb(new Map(), { accountHash: passwordHash })
}

function mockDbWithPassword(): MockDb {
  return makeMetaDb(sharedStore)
}

function mockContext(overrides: { ownerId?: string; cookie?: string; db: MockDb }) {
  const headers = new Headers()
  if (overrides.cookie) headers.set('Cookie', overrides.cookie)
  const json = vi.fn((body: unknown, status?: number) => ({ body, status }))
  const set = vi.fn()
  const c = {
    req: {
      url: 'https://blog.example.com/',
      raw: { headers },
    },
    env: { DB: overrides.db },
    get: (key: string) => (key === 'blogOwnerId' ? overrides.ownerId : undefined),
    set,
    json,
  }
  const next = vi.fn(async () => {})
  return { c, next, json, set }
}

describe('blog auth', () => {
  it('returns null when no custom password and no account password exist', async () => {
    expect(await handleBlogAuth(mockDbNoMeta(), 'u1', 'secret')).toBeNull()
  })

  it('succeeds with the account password when no custom password is set', async () => {
    const db = mockDbWithAccountPassword()
    const token = await handleBlogAuth(db, 'u1', 'secret')
    expect(token).toBeTruthy()
    expect(await validateBlogSession(db, 'u1', token!)).toBe(true)
  })

  it('succeeds with the custom password', async () => {
    const db = mockDbWithPassword()
    const token = await handleBlogAuth(db, 'u1', 'secret')
    expect(token).toBeTruthy()
    expect(await validateBlogSession(db, 'u1', token!)).toBe(true)
  })

  it('returns null for the wrong custom password', async () => {
    expect(await handleBlogAuth(mockDbWithPassword(), 'u1', 'wrong')).toBeNull()
  })

  it('returns null for the wrong account password', async () => {
    expect(await handleBlogAuth(mockDbWithAccountPassword(), 'u1', 'wrong')).toBeNull()
  })

  it('rejects invalid or expired tokens', async () => {
    expect(await validateBlogSession(mockDbNoMeta(), 'u1', 'bogus')).toBe(false)
  })

  it('rejects an expired legacy token and cleans it up', async () => {
    const db = makeMetaDb(new Map([['blog_session:u1:old', String(Date.now() - 1000)]]))
    expect(await validateBlogSession(db, 'u1', 'old')).toBe(false)
  })

  it('lazily deletes an expired table session on access', async () => {
    const db = mockDbWithPassword()
    const token = await handleBlogAuth(db, 'u1', 'secret')
    expect(token).toBeTruthy()
    db.sessions.set(token!, { userId: 'u1', expiresAt: Date.now() - 1000 })
    expect(await validateBlogSession(db, 'u1', token!)).toBe(false)
    expect(db.sqls.some((sql) => sql.includes('DELETE FROM blog_sessions WHERE token'))).toBe(true)
  })

  it('setBlogPassword writes blog_settings and invalidates sessions', async () => {
    const db = mockDbWithPassword()
    const token = await handleBlogAuth(db, 'u1', 'secret')
    expect(await validateBlogSession(db, 'u1', token!)).toBe(true)
    await setBlogPassword(db, 'u1', 'brand-new-secret')
    expect(await validateBlogSession(db, 'u1', token!)).toBe(false)
    expect(db.sqls.some((sql) => sql.includes('INSERT INTO blog_settings'))).toBe(true)
    expect(db.sqls.some((sql) => sql.includes('DELETE FROM blog_sessions WHERE user_id'))).toBe(true)
  })

  it('trackAccountPasswordChange follows account rotation only when tracking it', async () => {
    const db = makeMetaDb(new Map())
    await trackAccountPasswordChange(db, 'u1', 'old-hash', 'new-hash')
    expect(db.sqls.some((sql) => sql.includes('UPDATE blog_settings SET password_hash'))).toBe(true)
  })

  it('clearBlogSession deletes only the given session token', async () => {
    const db = mockDbWithPassword()
    const tokenA = await handleBlogAuth(db, 'u1', 'secret')
    const tokenB = await handleBlogAuth(db, 'u1', 'secret')
    await clearBlogSession(db, 'u1', tokenA!)
    expect(await validateBlogSession(db, 'u1', tokenA!)).toBe(false)
    expect(await validateBlogSession(db, 'u1', tokenB!)).toBe(true)
  })

  it('blogAuthMiddleware sets blogAuthed=false for a bogus session cookie and continues', async () => {
    const { c, next, set } = mockContext({
      ownerId: 'u1',
      cookie: 'blog_session_u1=bogus',
      db: mockDbWithPassword(),
    })
    await blogAuthMiddleware(c, next)
    expect(set).toHaveBeenCalledWith('blogAuthed', false)
    expect(next).toHaveBeenCalled()
  })

  it('blogAuthMiddleware sets blogAuthed=true for a valid session cookie and continues', async () => {
    const db = mockDbWithPassword()
    const token = await handleBlogAuth(db, 'u1', 'secret')
    const { c, next, set } = mockContext({
      ownerId: 'u1',
      cookie: `blog_session_u1=${token}`,
      db,
    })
    await blogAuthMiddleware(c, next)
    expect(set).toHaveBeenCalledWith('blogAuthed', true)
    expect(next).toHaveBeenCalled()
  })
})

function mockUserSettingsDb(settings: string | null): MockDb {
  return {
    prepare(sql: string) {
      if (!sql.includes('SELECT settings FROM users')) {
        throw new Error(`unexpected SQL: ${sql}`)
      }
      return {
        bind(..._args: unknown[]) {
          return {
            async all<T = unknown>() {
              return { results: [] as T[] }
            },
            async first<T = unknown>() {
              return (settings === null ? null : { settings }) as T | null
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

describe('getBlogAccent', () => {
  it('returns the owner appearance accent', async () => {
    const db = mockUserSettingsDb(JSON.stringify({ appearance: { accent: 'indigo' } }))
    expect(await getBlogAccent(db, 'u1')).toBe('indigo')
  })

  it('falls back to cinnabar when settings are missing', async () => {
    expect(await getBlogAccent(mockUserSettingsDb(null), 'u1')).toBe('cinnabar')
  })

  it('falls back to cinnabar for invalid JSON', async () => {
    expect(await getBlogAccent(mockUserSettingsDb('not-json'), 'u1')).toBe('cinnabar')
  })

  it('falls back to cinnabar for an unknown accent name', async () => {
    const db = mockUserSettingsDb(JSON.stringify({ appearance: { accent: 'neon' } }))
    expect(await getBlogAccent(db, 'u1')).toBe('cinnabar')
  })

  it('falls back to cinnabar when appearance is absent', async () => {
    const db = mockUserSettingsDb(JSON.stringify({}))
    expect(await getBlogAccent(db, 'u1')).toBe('cinnabar')
  })
})
