export const BLOG_PUBLIC_TAG = 'blog-public'
export const BLOG_PRIVATE_TAG = 'blog-private'
export const MOMENTS_FOLDER_NAME = 'Moments'

export type BlogTier = 'none' | 'public' | 'private'

export interface BlogTagConfig {
  publicTag: string
  privateTag: string
}

export function blogTierOfTags(tags: readonly string[], config?: BlogTagConfig): BlogTier {
  const privateTag = config?.privateTag ?? BLOG_PRIVATE_TAG
  const publicTag = config?.publicTag ?? BLOG_PUBLIC_TAG
  if (tags.includes(privateTag)) return 'private'
  if (tags.includes(publicTag)) return 'public'
  return 'none'
}

export function hiddenBlogTags(config?: BlogTagConfig): string[] {
  return [config?.publicTag ?? BLOG_PUBLIC_TAG, config?.privateTag ?? BLOG_PRIVATE_TAG]
}
