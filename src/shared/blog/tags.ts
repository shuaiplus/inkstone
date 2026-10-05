export const BLOG_PUBLIC_TAG = 'blog-public'
export const BLOG_PRIVATE_TAG = 'blog-private'
export const MOMENT_PUBLIC_TAG = 'moment-public'
export const MOMENT_PRIVATE_TAG = 'moment-private'

export type BlogTier = 'none' | 'public' | 'private'
export type BlogKind = 'article' | 'moment'

export interface BlogTagConfig {
  publicTag: string
  privateTag: string
  momentsPublicTag?: string
  momentsPrivateTag?: string
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
 * Resolves both kind and tier from tags. Moment tags win over article
 * tags so a note marked as a moment never leaks into the article feed.
 */
export function blogEntryOfTags(tags: readonly string[], config?: BlogTagConfig): BlogEntry | null {
  const momentsPrivate = config?.momentsPrivateTag ?? MOMENT_PRIVATE_TAG
  const momentsPublic = config?.momentsPublicTag ?? MOMENT_PUBLIC_TAG
  const privateTag = config?.privateTag ?? BLOG_PRIVATE_TAG
  const publicTag = config?.publicTag ?? BLOG_PUBLIC_TAG
  if (tags.includes(momentsPrivate)) return { tier: 'private', kind: 'moment' }
  if (tags.includes(momentsPublic)) return { tier: 'public', kind: 'moment' }
  if (tags.includes(privateTag)) return { tier: 'private', kind: 'article' }
  if (tags.includes(publicTag)) return { tier: 'public', kind: 'article' }
  return null
}

export function hiddenBlogTags(config?: BlogTagConfig): string[] {
  return [
    config?.publicTag ?? BLOG_PUBLIC_TAG,
    config?.privateTag ?? BLOG_PRIVATE_TAG,
    config?.momentsPublicTag ?? MOMENT_PUBLIC_TAG,
    config?.momentsPrivateTag ?? MOMENT_PRIVATE_TAG,
  ]
}
