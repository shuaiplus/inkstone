import { describe, expect, it } from 'vitest'
import { BLOG_PUBLIC_TAG, BLOG_PRIVATE_TAG, blogTierOfTags, hiddenBlogTags } from '../src/shared/blog/tags'

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
  it('hiddenBlogTags returns the configured public and private tags', () => {
    expect(hiddenBlogTags()).toEqual([BLOG_PUBLIC_TAG, BLOG_PRIVATE_TAG])
    expect(hiddenBlogTags({ publicTag: 'p', privateTag: 'q' })).toEqual(['p', 'q'])
  })
})
