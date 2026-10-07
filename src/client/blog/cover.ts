import type { BlogPostSummary } from '@shared/blog/types'

/**
 * Resolves a cover image URL so it is viewable anonymously: same-origin
 * `/api/files/<id>` URLs get the `?share=<slug>` access token appended.
 */
export function coverSrc(post: BlogPostSummary): string | null {
  if (!post.cover)
    return null
  try {
    const url = new URL(post.cover, window.location.origin)
    if (url.origin === window.location.origin && /^\/api\/files\/[0-9a-hjkmnp-tv-z]{26}$/i.test(url.pathname)) {
      url.searchParams.set('share', post.slug)
      return `${url.pathname}${url.search}`
    }
    return post.cover
  }
  catch {
    return null
  }
}
