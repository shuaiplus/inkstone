const HIDDEN = new Set<string>()

export function visibleTags(tags: readonly string[], hidden?: string[]): string[] {
  const set = hidden ? new Set(hidden) : HIDDEN
  return tags.filter((t) => !set.has(t))
}
