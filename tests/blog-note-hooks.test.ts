import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { notesRoutes } from '../src/worker/routes/notes'
import { errorResponse } from '../src/worker/lib/errors'
import { extractTags } from '../src/shared/markdown-utils'
import type { NoteRow } from '../src/worker/db/rows'
import type { AppBindings } from '../src/worker/env'

const N1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'
const N2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbb'

const TAGGED_CONTENT = `---
tags:
  - blog-public
---
# Hello world
`
const UNTAGGED_CONTENT = '# Plain note\n'

interface MockStatement {
  all<T = unknown>(): Promise<{ results: T[] }>
  first<T = unknown>(): Promise<T | null>
  run(): Promise<{ success: boolean }>
  __sql?: string
  __args?: unknown[]
}

interface DbOptions {
  notes?: NoteRow[]
  accountHash?: string | null
  customHash?: string | null
  versionContent?: string | null
}

function makeDb(options: DbOptions = {}) {
  const notes = new Map<string, NoteRow>()
  for (const seed of options.notes ?? []) notes.set(seed.id, seed)
  const preparedSqls: string[] = []
  const preparedArgs: unknown[][] = []

  const db = {
    preparedSqls,
    preparedArgs,
    hasSql(fragment: string): boolean {
      return preparedSqls.some((sql) => sql.includes(fragment))
    },
    countSql(fragment: string): number {
      return preparedSqls.filter((sql) => sql.includes(fragment)).length
    },
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          preparedSqls.push(sql)
          preparedArgs.push(args)
          const statement: MockStatement = {
            async all<T = unknown>() {
              return { results: [] as T[] }
            },
            async first<T = unknown>() {
              if (sql.includes('FROM notes n WHERE n.id = ?1 AND n.user_id = ?2')) {
                const row = notes.get(String(args[0]))
                return (row ?? null) as T | null
              }
              if (sql.includes('SELECT id FROM folders WHERE id = ?1')) {
                return (String(args[0]) === 'moments-folder' ? { id: 'moments-folder' } : null) as T | null
              }
              if (sql.includes('SELECT 1 AS found FROM folders f')) {
                return (String(args[0]) === 'moments-folder' ? { found: 1 } : null) as T | null
              }
              if (sql.includes('SELECT value FROM app_meta')) {
                const key = String(args[0])
                const value = key.startsWith('blog_password_hash:') ? options.customHash : undefined
                return (value === undefined ? null : { value }) as T | null
              }
              if (sql.includes('SELECT password_hash FROM users')) {
                return (options.accountHash ? { password_hash: options.accountHash } : null) as T | null
              }
              if (sql.includes('SELECT title, content FROM note_versions')) {
                return (options.versionContent
                  ? { title: 'v1', content: options.versionContent }
                  : null) as T | null
              }
              return null as T | null
            },
            async run() {
              return { success: true }
            },
          }
          statement.__sql = sql
          statement.__args = args
          return statement
        },
      }
    },
    async batch(statements: MockStatement[]) {
      for (const statement of statements) {
        if (statement.__sql?.includes('INSERT') && statement.__sql.includes('INTO notes')) {
          const a = statement.__args ?? []
          const content = String(a[4] ?? '')
          notes.set(String(a[0]), {
            id: String(a[0]),
            user_id: String(a[1]),
            folder_id: (a[2] as string | null) ?? null,
            title: String(a[3] ?? ''),
            content,
            excerpt: String(a[5] ?? ''),
            rev: 1,
            word_count: Number(a[6] ?? 0),
            char_count: Number(a[7] ?? 0),
            is_pinned: 0,
            is_starred: Number(a[8] ?? 0),
            is_archived: 0,
            position: Number(a[9] ?? 0),
            content_hash: String(a[10] ?? ''),
            created_at: Number(a[11] ?? 0),
            updated_at: Number(a[12] ?? 0),
            deleted_at: null,
            tag_names: extractTags(content).join('\u0001'),
          })
        }
        await statement.run()
      }
      const results = statements.map(() => ({ meta: { changes: 1 }, results: [] }))
      if (results.length) {
        results[results.length - 1] = { meta: { changes: 1 }, results: [{ seq: 1 }] }
      }
      return results
    },
  }
  return db
}

function seedNote(overrides: Partial<NoteRow> & { id: string; content: string }): NoteRow {
  return {
    id: 'n1',
    user_id: 'u1',
    folder_id: null,
    title: 'Seed',
    content: '',
    excerpt: '',
    rev: 1,
    word_count: 0,
    char_count: 0,
    is_pinned: 0,
    is_starred: 0,
    is_archived: 0,
    position: 0,
    content_hash: 'seed-hash',
    created_at: 1700000000000,
    updated_at: 1700000000000,
    deleted_at: null,
    tag_names: extractTags(overrides.content).join('\u0001'),
    ...overrides,
  }
}

function env(db: unknown): AppBindings['Bindings'] {
  return { DB: db } as unknown as AppBindings['Bindings']
}

const fakeExecutionCtx = { waitUntil() {} }

function makeApp(db: unknown) {
  const app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    c.set('userId', 'u1')
    c.set('database', { ftsEnabled: false })
    await next()
  })
  app.onError((err, c) => errorResponse(c, err))
  app.route('/api/notes', notesRoutes)
  return app
}

function request(
  app: Hono<AppBindings>,
  db: unknown,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  return app.request(url, init, env(db), fakeExecutionCtx)
}

function patch(db: unknown, id: string, content: string) {
  const app = makeApp(db)
  return request(
    app,
    db,
    `/api/notes/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev: 1, content }),
    },
  )
}

describe('blog note hooks', () => {
  it('CREATE with blog-public tag ensures a blog post', async () => {
    const db = makeDb({ accountHash: 'acct-hash' })
    const app = makeApp(db)
    const res = await request(app, db, '/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: N1, content: TAGGED_CONTENT }),
    })
    expect(res.status).toBe(201)
    expect(db.hasSql('INSERT INTO blog_posts')).toBe(true)
  })

  it('CREATE in the Moments folder ensures a public blog post without any tag', async () => {
    const db = makeDb({ accountHash: 'acct-hash' })
    const app = makeApp(db)
    const res = await request(app, db, '/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: N1, folderId: 'moments-folder', content: UNTAGGED_CONTENT }),
    })
    expect(res.status).toBe(201)
    expect(db.hasSql('INSERT INTO blog_posts')).toBe(true)
    expect(db.hasSql('UPDATE blog_posts')).toBe(false)
  })

  it('PATCH moving a plain note into the Moments folder creates a private blog post', async () => {
    const db = makeDb({ notes: [seedNote({ id: N1, content: UNTAGGED_CONTENT })], accountHash: 'acct-hash' })
    const app = makeApp(db)
    const res = await request(app, db, `/api/notes/${N1}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev: 1, folderId: 'moments-folder' }),
    })
    expect(res.status).toBe(200)
    expect(db.hasSql('INSERT INTO blog_posts')).toBe(true)
  })

  it('PATCH moving a Moments note out of the folder withdraws the blog post', async () => {
    const db = makeDb({ notes: [seedNote({ id: N1, content: UNTAGGED_CONTENT, folder_id: 'moments-folder' })], accountHash: 'acct-hash' })
    const app = makeApp(db)
    const res = await request(app, db, `/api/notes/${N1}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev: 1, folderId: null }),
    })
    expect(res.status).toBe(200)
    expect(db.hasSql('DELETE FROM blog_posts')).toBe(true)
    expect(db.hasSql('INSERT INTO blog_posts')).toBe(false)
  })

  it('PATCH to blog-public content ensures a blog post', async () => {
    const db = makeDb({ notes: [seedNote({ id: N1, content: UNTAGGED_CONTENT })], accountHash: 'acct-hash' })
    const res = await patch(db, N1, TAGGED_CONTENT)
    expect(res.status).toBe(200)
    expect(db.hasSql('INSERT INTO blog_posts')).toBe(true)
    expect(db.hasSql('DELETE FROM blog_posts')).toBe(false)
  })

  it('PATCH removing a blog tag withdraws the blog post', async () => {
    const db = makeDb({ notes: [seedNote({ id: N1, content: TAGGED_CONTENT })], accountHash: 'acct-hash' })
    const res = await patch(db, N1, 'a completely different plain note')
    expect(res.status).toBe(200)
    expect(db.hasSql('DELETE FROM blog_posts')).toBe(true)
    expect(db.hasSql('INSERT INTO blog_posts')).toBe(false)
  })

  it('PATCH removing a blog-private tag withdraws the blog post', async () => {
    const db = makeDb({ notes: [seedNote({ id: N1, content: '---\ntags:\n  - blog-private\n---\n# Secret\n' })], accountHash: 'acct-hash' })
    const res = await patch(db, N1, 'a plain note with no blog tags')
    expect(res.status).toBe(200)
    expect(db.hasSql('DELETE FROM blog_posts')).toBe(true)
    expect(db.hasSql('INSERT INTO blog_posts')).toBe(false)
  })

  it('PATCH editing a never-blog-tagged note withdraws any existing share', async () => {
    const db = makeDb({ notes: [seedNote({ id: N1, content: UNTAGGED_CONTENT })], accountHash: 'acct-hash' })
    const res = await patch(db, N1, '# Plain note edited\n')
    expect(res.status).toBe(200)
    expect(db.hasSql('DELETE FROM blog_posts')).toBe(true)
    expect(db.hasSql('INSERT INTO blog_posts')).toBe(false)
  })

  it('DELETE (trash) withdraws the blog post for a blog-tagged note', async () => {
    const db = makeDb({ notes: [seedNote({ id: N1, content: TAGGED_CONTENT })] })
    const app = makeApp(db)
    const res = await request(app, db, `/api/notes/${N1}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(db.hasSql('DELETE FROM blog_posts')).toBe(true)
  })

  it('DELETE (trash) always withdraws the blog post', async () => {
    const db = makeDb({ notes: [seedNote({ id: N1, content: UNTAGGED_CONTENT })] })
    const app = makeApp(db)
    const res = await request(app, db, `/api/notes/${N1}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(db.hasSql('DELETE FROM blog_posts')).toBe(true)
  })

  it('RESTORE re-ensures the blog post from the restored content', async () => {
    const db = makeDb({
      notes: [seedNote({ id: N1, content: TAGGED_CONTENT, deleted_at: 1700000000000 })],
      accountHash: 'acct-hash',
    })
    const app = makeApp(db)
    const res = await request(app, db, `/api/notes/${N1}/restore`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(db.hasSql('INSERT INTO blog_posts')).toBe(true)
  })

  it('DUPLICATE ensures a blog post for the copy', async () => {
    const db = makeDb({ notes: [seedNote({ id: N1, content: TAGGED_CONTENT })], accountHash: 'acct-hash' })
    const app = makeApp(db)
    const res = await request(app, db, `/api/notes/${N1}/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: N2 }),
    })
    expect(res.status).toBe(201)
    expect(db.hasSql('INSERT INTO blog_posts')).toBe(true)
  })

  it('VERSION-RESTORE re-ensures the blog post from the version content', async () => {
    const db = makeDb({
      notes: [seedNote({ id: N1, content: 'current content without tags' })],
      accountHash: 'acct-hash',
      versionContent: TAGGED_CONTENT,
    })
    const app = makeApp(db)
    const res = await request(app, db, `/api/notes/${N1}/versions/v1/restore`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(db.hasSql('INSERT INTO blog_posts')).toBe(true)
  })

  it('PURGE deletes the share and the blog post together', async () => {
    const db = makeDb({
      notes: [seedNote({ id: N1, content: TAGGED_CONTENT, deleted_at: 1700000000000 })],
    })
    const app = makeApp(db)
    const res = await request(app, db, `/api/notes/${N1}/purge`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(db.countSql('DELETE FROM shares')).toBe(1)
    expect(db.hasSql('DELETE FROM blog_posts WHERE note_id = ?1')).toBe(true)
  })
})
