// @vitest-environment node
import { expect, it } from 'vitest'
import { LIMITS } from '../src/shared/constants'
import { assertContentSize } from '../src/worker/lib/request'

it('accepts the content boundary with room for metadata below the D1 row limit', () => {
  expect(LIMITS.contentMaxBytes).toBeLessThanOrEqual(2_000_000 - 64 * 1024)
  expect(() => assertContentSize('a'.repeat(LIMITS.contentMaxBytes))).not.toThrow()
  expect(() => assertContentSize('a'.repeat(LIMITS.contentMaxBytes + 1)))
    .toThrow('Note content exceeds the 1.9 MB limit')
})

it('rejects content by UTF-8 byte size rather than character count', () => {
  const content = '中'.repeat(Math.floor(LIMITS.contentMaxBytes / 3) + 1)
  expect(content.length).toBeLessThan(LIMITS.contentMaxBytes)
  expect(() => assertContentSize(content)).toThrow()
})
