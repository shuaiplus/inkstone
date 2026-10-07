import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { tagsRoutes } from '../src/worker/routes/tags'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'

const TAG_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'

interface MockStatement {
  all<T = unknown>(): Promise<{ results: T[] }>
  first<T = unknown>(): Promise<T | null>
  run(): Promise<{ success: boolean }>
}

function makeDb() {
  return {
    preparedSqls: [] as string[],
    prepare(sql: string) {
      this.preparedSqls.push(sql)
      return {
        bind() {
          return {
            async all<T = unknown>() {
              return { results: [] as T[] }
            },
            async first<T = unknown>() {
              if (sql.includes('FROM tags WHERE id = ?1'))
                return { id: TAG_ID, name: 'blog-private', color: null } as T | null
              return null as T | null
            },
            async run() {
              return { success: true }
            },
          } satisfies MockStatement
        },
      }
    },
    async batch() {
      return []
    },
  }
}

function makeApp(db: unknown) {
  const app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    c.set('userId', 'u1')
    c.set('database', { ftsEnabled: false })
    await next()
  })
  app.onError((err, c) => errorResponse(c, err))
  app.route('/', tagsRoutes)
  return app
}

const env = (db: unknown): AppBindings['Bindings'] => ({ DB: db } as unknown as AppBindings['Bindings'])

describe('tags routes', () => {
  it('PATCH /:id returns 409 when the tag batch has no changes in mock', async () => {
    const db = makeDb()
    const app = makeApp(db)
    const res = await app.request(
      `/${TAG_ID}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'renamed' }),
      },
      env(db),
    )
    expect(res.status).toBe(409)
  })

  it('PATCH /:id with a new name returns 409 when the tag batch has no changes in mock', async () => {
    const db = makeDb()
    const app = makeApp(db)
    const res = await app.request(
      `/${TAG_ID}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'blog-public' }),
      },
      env(db),
    )
    expect(res.status).toBe(409)
  })

  it('DELETE /:id returns 409 when the tag batch has no changes in mock', async () => {
    const db = makeDb()
    const app = makeApp(db)
    const res = await app.request(`/${TAG_ID}`, { method: 'DELETE' }, env(db))
    expect(res.status).toBe(409)
  })
})
