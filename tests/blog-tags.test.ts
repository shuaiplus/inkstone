import { describe, expect, it } from 'vitest'
import { BLOG_PUBLIC_TAG, BLOG_PRIVATE_TAG, MOMENTS_TAG, PINNED_TAG, blogTierOfTags, blogEntryOfTags, hiddenBlogTags, isPinnedTag } from '../src/shared/blog/tags'

describe('blog tier tags', () => {
  it('derives tier: none/public/private with private winning', () => {
    expect(blogTierOfTags([])).toBe('none')
    expect(blogTierOfTags(['x'])).toBe('none')
    expect(blogTierOfTags([BLOG_PUBLIC_TAG])).toBe('public')
    expect(blogTierOfTags([BLOG_PRIVATE_TAG])).toBe('private')
    expect(blogTierOfTags([BLOG_PUBLIC_TAG, BLOG_PRIVATE_TAG])).toBe('private')
  })
  it('respects custom config for tag names', () => {
    const config = { publicTag: 'my-public', privateTag: 'my-private' }
    expect(blogTierOfTags(['my-public'], config)).toBe('public')
    expect(blogTierOfTags(['my-private'], config)).toBe('private')
    expect(blogTierOfTags([BLOG_PUBLIC_TAG], config)).toBe('none')
  })
  it('hiddenBlogTags returns all configured tags', () => {
    expect(hiddenBlogTags()).toEqual([BLOG_PUBLIC_TAG, BLOG_PRIVATE_TAG, MOMENTS_TAG, PINNED_TAG])
    expect(hiddenBlogTags({ publicTag: 'p', privateTag: 'q', momentsTag: 'm', pinnedTag: 'pin' })).toEqual(['p', 'q', 'm', 'pin'])
  })
  it('isPinnedTag detects the pinned marker', () => {
    expect(isPinnedTag([PINNED_TAG])).toBe(true)
    expect(isPinnedTag(['x'])).toBe(false)
    expect(isPinnedTag(['pin'], { publicTag: 'p', privateTag: 'q', pinnedTag: 'pin' })).toBe(true)
    expect(isPinnedTag([PINNED_TAG], { publicTag: 'p', privateTag: 'q', pinnedTag: 'pin' })).toBe(false)
  })
})

describe('blog entry resolution (visibility x kind)', () => {
  it('resolves kind from the moments tag, visibility from blog tags', () => {
    expect(blogEntryOfTags([])).toBeNull()
    expect(blogEntryOfTags(['x'])).toBeNull()
    expect(blogEntryOfTags([BLOG_PUBLIC_TAG])).toEqual({ tier: 'public', kind: 'article' })
    expect(blogEntryOfTags([BLOG_PRIVATE_TAG])).toEqual({ tier: 'private', kind: 'article' })
    expect(blogEntryOfTags([MOMENTS_TAG])).toBeNull()
    expect(blogEntryOfTags([MOMENTS_TAG, BLOG_PUBLIC_TAG])).toEqual({ tier: 'public', kind: 'moment' })
    expect(blogEntryOfTags([MOMENTS_TAG, BLOG_PRIVATE_TAG])).toEqual({ tier: 'private', kind: 'moment' })
    expect(blogEntryOfTags([BLOG_PUBLIC_TAG, BLOG_PRIVATE_TAG])).toEqual({ tier: 'private', kind: 'article' })
  })
  it('respects custom tag names', () => {
    const config = { publicTag: 'p', privateTag: 'q', momentsTag: 'm' }
    expect(blogEntryOfTags(['m', 'p'], config)).toEqual({ tier: 'public', kind: 'moment' })
    expect(blogEntryOfTags(['m', 'q'], config)).toEqual({ tier: 'private', kind: 'moment' })
    expect(blogEntryOfTags([MOMENTS_TAG, 'p'], config)).toEqual({ tier: 'public', kind: 'article' })
  })
})
