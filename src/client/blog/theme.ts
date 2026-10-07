export type BlogTheme = 'light' | 'dark'

const STORAGE_KEY = 'inkstone-blog-theme'

export function initialBlogTheme(): BlogTheme {
  try {
    const s = localStorage.getItem(STORAGE_KEY)
    if (s === 'light' || s === 'dark') return s
  } catch {
    // ignore
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function saveBlogTheme(theme: BlogTheme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // ignore
  }
}

export function dispatchBlogTheme(theme: BlogTheme): void {
  window.dispatchEvent(new CustomEvent('blog:theme', { detail: { theme } }))
}

export function isBlogDark(): boolean {
  return document.querySelector('.blog-app')?.getAttribute('data-theme') === 'dark'
}

export function onBlogThemeChange(cb: () => void): () => void {
  const handler = () => cb()
  window.addEventListener('blog:theme', handler)
  return () => window.removeEventListener('blog:theme', handler)
}
