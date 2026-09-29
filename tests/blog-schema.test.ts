import { describe, expect, it } from 'vitest'
import { SCHEMA_MIGRATIONS } from '../src/worker/db/schema'

describe('blog schema', () => {
  it('does not include the abandoned blog_published column migrations', () => {
    const m13 = SCHEMA_MIGRATIONS.find((m) => m.version === 13)
    const m14 = SCHEMA_MIGRATIONS.find((m) => m.version === 14)
    expect(m13).toBeUndefined()
    expect(m14).toBeUndefined()
  })
})
