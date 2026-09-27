import { describe, expect, it } from 'vitest'
import { BLOG_PUBLIC_TAG, BLOG_PRIVATE_TAG, blogTierOfTags, filterVisibleTags, isReservedBlogTag, RESERVED_BLOG_TAGS } from '../src/shared/blog/tags'

describe('blog tier tags', () => {
  it('derives tier: none/public/private with private winning', () => {
    expect(blogTierOfTags([])).toBe('none')
    expect(blogTierOfTags(['x'])).toBe('none')
    expect(blogTierOfTags([BLOG_PUBLIC_TAG])).toBe('public')
    expect(blogTierOfTags([BLOG_PRIVATE_TAG])).toBe('private')
    expect(blogTierOfTags([BLOG_PUBLIC_TAG, BLOG_PRIVATE_TAG])).toBe('private')
  })
  it('recognizes reserved tags', () => {
    expect(isReservedBlogTag(BLOG_PUBLIC_TAG)).toBe(true)
    expect(isReservedBlogTag('x')).toBe(false)
    expect(RESERVED_BLOG_TAGS).toEqual([BLOG_PUBLIC_TAG, BLOG_PRIVATE_TAG])
  })
  it('filters reserved tags from visible lists', () => {
    const tags = [{ id: 'a', name: 'blog-public', color: null }, { id: 'b', name: 'work', color: null }]
    expect(filterVisibleTags(tags).map((t) => t.name)).toEqual(['work'])
  })
})
