export const BLOG_PUBLIC_TAG = 'blog-public'
export const BLOG_PRIVATE_TAG = 'blog-private'
export const RESERVED_BLOG_TAGS: readonly string[] = [BLOG_PUBLIC_TAG, BLOG_PRIVATE_TAG]
export const MOMENTS_FOLDER_NAME = 'Moments'

export type BlogTier = 'none' | 'public' | 'private'

export function blogTierOfTags(tags: readonly string[]): BlogTier {
  if (tags.includes(BLOG_PRIVATE_TAG)) return 'private'
  if (tags.includes(BLOG_PUBLIC_TAG)) return 'public'
  return 'none'
}

export function isReservedBlogTag(name: string): boolean {
  return RESERVED_BLOG_TAGS.includes(name)
}

export function filterVisibleTags<T extends { name: string }>(tags: T[]): T[] {
  return tags.filter((tag) => !isReservedBlogTag(tag.name))
}
