import { describe, expect, it } from 'vitest'
import { checkBlogFileAccess } from '../src/worker/blog/queries'

const ATTACHMENT_ID = 'a'.repeat(26)

interface MockRow {
  [key: string]: unknown
}

function makeDb(first: MockRow | null): { db: unknown; sqls: string[] } {
  const sqls: string[] = []
  const db = {
    prepare(sql: string) {
      sqls.push(sql)
      return {
        bind(..._args: unknown[]) {
          return {
            async all<T = MockRow>() {
              return { results: [] as T[] }
            },
            async first<T = MockRow>() {
              return (first ?? null) as T | null
            },
            async run() {
              return { success: true }
            },
          }
        },
      }
    },
  }
  return { db, sqls }
}

const postRow = (overrides: Partial<MockRow> = {}): MockRow => ({
  user_id: 'u1',
  visibility: 'public',
  content: `![img](/api/files/${ATTACHMENT_ID})`,
  ...overrides,
})

describe('checkBlogFileAccess', () => {
  it('allows public post attachments without a session', async () => {
    const { db, sqls } = makeDb(postRow())
    const result = await checkBlogFileAccess(db as unknown as D1Database, 'post-slug', ATTACHMENT_ID, false)
    expect(result).toEqual({ allowed: true, userId: 'u1' })
    expect(sqls.some((sql) => sql.includes('FROM blog_posts bp'))).toBe(true)
    expect(sqls.some((sql) => sql.includes('FROM shares'))).toBe(false)
  })

  it('gates private post attachments on the blog session', async () => {
    const { db } = makeDb(postRow({ visibility: 'private' }))
    expect(await checkBlogFileAccess(db as unknown as D1Database, 'post-slug', ATTACHMENT_ID, true))
      .toEqual({ allowed: true, userId: 'u1' })
    const { db: db2 } = makeDb(postRow({ visibility: 'private' }))
    expect(await checkBlogFileAccess(db2 as unknown as D1Database, 'post-slug', ATTACHMENT_ID, false))
      .toEqual({ allowed: false, userId: 'u1' })
  })

  it('denies unknown slugs and unreferenced attachments', async () => {
    const { db } = makeDb(null)
    expect(await checkBlogFileAccess(db as unknown as D1Database, 'missing', ATTACHMENT_ID, true))
      .toEqual({ allowed: false, userId: null })
    const { db: db2 } = makeDb(postRow({ content: 'no images here' }))
    expect(await checkBlogFileAccess(db2 as unknown as D1Database, 'post-slug', ATTACHMENT_ID, true))
      .toEqual({ allowed: false, userId: null })
  })
})
