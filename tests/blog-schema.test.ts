import { describe, expect, it } from 'vitest'
import { SCHEMA_MIGRATIONS } from '../src/worker/db/schema'

describe('blog schema revert', () => {
  it('adds a migration 14 that drops blog_published', () => {
    const m14 = SCHEMA_MIGRATIONS.find((m) => m.version === 14)
    expect(m14).toBeDefined()
    expect(m14!.statements.some((s) => /DROP COLUMN blog_published/i.test(s))).toBe(true)
  })
})
