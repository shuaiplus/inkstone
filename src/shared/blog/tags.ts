export const BLOG_PUBLIC_TAG = 'blog-public'
export const BLOG_PRIVATE_TAG = 'blog-private'
export const MOMENTS_TAG = 'moment'
export const PINNED_TAG = 'blog-pinned'

export type BlogTier = 'none' | 'public' | 'private'
export type BlogKind = 'article' | 'moment'

export interface BlogTagConfig {
  publicTag: string
  privateTag: string
  momentsTag?: string
  pinnedTag?: string
}

export interface BlogEntry {
  tier: Exclude<BlogTier, 'none'>
  kind: BlogKind
}

export function blogTierOfTags(tags: readonly string[], config?: BlogTagConfig): BlogTier {
  const privateTag = config?.privateTag ?? BLOG_PRIVATE_TAG
  const publicTag = config?.publicTag ?? BLOG_PUBLIC_TAG
  if (tags.includes(privateTag)) return 'private'
  if (tags.includes(publicTag)) return 'public'
  return 'none'
}

/**
 * Orthogonal resolution: visibility comes from the blog-public/blog-private
 * tags, kind comes from the moments tag. A bare moments tag publishes
 * nothing; conflicting visibility tags resolve to private.
 */
export function blogEntryOfTags(tags: readonly string[], config?: BlogTagConfig): BlogEntry | null {
  const momentsTag = config?.momentsTag ?? MOMENTS_TAG
  const tier = blogTierOfTags(tags, config)
  if (tier === 'none') return null
  return { tier, kind: tags.includes(momentsTag) ? 'moment' : 'article' }
}

export function hiddenBlogTags(config?: BlogTagConfig): string[] {
  return [
    config?.publicTag ?? BLOG_PUBLIC_TAG,
    config?.privateTag ?? BLOG_PRIVATE_TAG,
    config?.momentsTag ?? MOMENTS_TAG,
    config?.pinnedTag ?? PINNED_TAG,
  ]
}

export function isPinnedTag(tags: readonly string[], config?: BlogTagConfig): boolean {
  return tags.includes(config?.pinnedTag ?? PINNED_TAG)
}
