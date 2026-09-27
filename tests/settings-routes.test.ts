import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { settingsRoutes } from '../src/worker/routes/settings'
import type { AppBindings } from '../src/worker/env'

interface PreparedEntry {
  sql: string
  args: unknown[]
}

interface MockDb {
  prepared: PreparedEntry[]
  prepare(sql: string): {
    bind(...args: unknown[]): { first<T = unknown>(): Promise<T | null> }
  }
}

function makeDb(): MockDb {
  const prepared: PreparedEntry[] = []
  return {
    prepared,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          prepared.push({ sql, args })
          return {
            async first<T = unknown>() {
              return {
                notes: 1,
                trashed: 0,
                folders: 2,
                tags: 5,
                attachments: 0,
                attachmentBytes: 0,
                chars: 0,
                words: 0,
                versions: 0,
                links: 3,
              } as T
            },
          }
        },
      }
    },
  }
}

function env(db: MockDb): AppBindings['Bindings'] {
  return { DB: db } as unknown as AppBindings['Bindings']
}

function makeApp(db: MockDb) {
  const app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    c.set('userId', 'u1')
    await next()
  })
  app.route('/', settingsRoutes)
  return app
}

describe('settings routes', () => {
  it('GET /stats counts all tags including reserved blog tags', async () => {
    const db = makeDb()
    const app = makeApp(db)
    const res = await app.request('/stats', {}, env(db))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ tags: 5 })
    const stats = db.prepared.find((entry) => entry.sql.includes('FROM tags'))
    expect(stats).toBeDefined()
    expect(stats!.sql).toContain('COUNT(*) FROM tags WHERE user_id = ?1')
    expect(stats!.args).toEqual(['u1'])
  })
})
