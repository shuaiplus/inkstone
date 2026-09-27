import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { blogRoutes } from '../src/worker/blog/routes'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'

interface MockStatement {
  all<T = unknown>(): Promise<{ results: T[] }>
  first<T = unknown>(): Promise<T | null>
  run(): Promise<{ success: boolean }>
}

interface MockDb {
  prepare(sql: string): { bind(...args: unknown[]): MockStatement }
}

function makeDb(): MockDb {
  return {
    prepare() {
      return {
        bind() {
          return {
            async all<T = unknown>() {
              return { results: [] as T[] }
            },
            async first<T = unknown>() {
              return null as T | null
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

function makeApp(opts?: { userId?: string }) {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  if (opts?.userId) {
    app.use('*', async (c, next) => {
      c.set('userId', opts.userId!)
      await next()
    })
  }
  app.route('/', blogRoutes)
  return app
}

describe('blog routes', () => {
  it('returns 404 for an unknown username', async () => {
    const app = makeApp()
    const res = await app.request('/nobody/posts', {}, { DB: makeDb() } as unknown as AppBindings['Bindings'])
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Blog not found' } })
  })

  it('requires auth for GET /settings when no user session exists', async () => {
    const app = makeApp()
    const res = await app.request('/settings', {}, { DB: makeDb() } as unknown as AppBindings['Bindings'])
    expect(res.status).toBe(401)
  })
})
