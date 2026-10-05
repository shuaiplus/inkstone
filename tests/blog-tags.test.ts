import { describe, expect, it } from 'vitest'
import { BLOG_PUBLIC_TAG, BLOG_PRIVATE_TAG, MOMENT_PUBLIC_TAG, MOMENT_PRIVATE_TAG, blogTierOfTags, blogEntryOfTags, hiddenBlogTags } from '../src/shared/blog/tags'

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
  it('hiddenBlogTags returns the configured tags including moments', () => {
    expect(hiddenBlogTags()).toEqual([BLOG_PUBLIC_TAG, BLOG_PRIVATE_TAG, MOMENT_PUBLIC_TAG, MOMENT_PRIVATE_TAG])
    expect(hiddenBlogTags({ publicTag: 'p', privateTag: 'q', momentsPublicTag: 'mp', momentsPrivateTag: 'mq' })).toEqual(['p', 'q', 'mp', 'mq'])
  })
})

describe('blog moment tags', () => {
  it('resolves kind and tier from moment tags, moments winning over article tags', () => {
    expect(blogEntryOfTags([])).toBeNull()
    expect(blogEntryOfTags(['x'])).toBeNull()
    expect(blogEntryOfTags([MOMENT_PUBLIC_TAG])).toEqual({ tier: 'public', kind: 'moment' })
    expect(blogEntryOfTags([MOMENT_PRIVATE_TAG])).toEqual({ tier: 'private', kind: 'moment' })
    expect(blogEntryOfTags([MOMENT_PRIVATE_TAG, MOMENT_PUBLIC_TAG])).toEqual({ tier: 'private', kind: 'moment' })
    expect(blogEntryOfTags([BLOG_PUBLIC_TAG, MOMENT_PUBLIC_TAG])).toEqual({ tier: 'public', kind: 'moment' })
    expect(blogEntryOfTags([BLOG_PUBLIC_TAG])).toEqual({ tier: 'public', kind: 'article' })
    expect(blogEntryOfTags([BLOG_PRIVATE_TAG])).toEqual({ tier: 'private', kind: 'article' })
  })
  it('respects custom moment tag names', () => {
    const config = { publicTag: 'p', privateTag: 'q', momentsPublicTag: 'mp', momentsPrivateTag: 'mq' }
    expect(blogEntryOfTags(['mp'], config)).toEqual({ tier: 'public', kind: 'moment' })
    expect(blogEntryOfTags(['mq'], config)).toEqual({ tier: 'private', kind: 'moment' })
    expect(blogEntryOfTags([MOMENT_PUBLIC_TAG], config)).toBeNull()
  })
  it('hiddenBlogTags includes the moment tags', () => {
    expect(hiddenBlogTags()).toContain(MOMENT_PUBLIC_TAG)
    expect(hiddenBlogTags()).toContain(MOMENT_PRIVATE_TAG)
  })
})
