import { describe, expect, it } from 'vitest'
import { purgeExpiredOperationalData } from '../src/worker/lib/maintenance'

describe('purgeExpiredOperationalData', () => {
  it('purges expired blog sessions alongside operational data', async () => {
    const sqls: string[] = []
    const db = {
      prepare(sql: string) {
        sqls.push(sql)
        return {
          bind(..._args: unknown[]) {
            return {
              async run() {
                return { success: true, meta: { changes: 0 } }
              },
            }
          },
        }
      },
      async batch(statements: unknown[]) {
        return (statements as Array<{ run(): Promise<unknown> }>).map(() => ({ meta: { changes: 2 } }))
      },
    }
    const result = await purgeExpiredOperationalData(db as unknown as D1Database, 1_700_000_000_000, 10)
    expect(sqls.some((sql) => sql.includes('DELETE FROM blog_sessions'))).toBe(true)
    expect(result.blogSessions).toBe(2)
    expect(result.sessions).toBe(2)
  })
})
