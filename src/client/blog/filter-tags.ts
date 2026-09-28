import { RESERVED_BLOG_TAGS } from '@shared/blog/tags'

const HIDDEN = new Set(RESERVED_BLOG_TAGS)

export function visibleTags(tags: readonly string[]): string[] {
  return tags.filter((t) => !HIDDEN.has(t))
}
