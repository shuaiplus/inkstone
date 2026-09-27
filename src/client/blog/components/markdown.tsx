import { useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { enhancePreview } from '../../lib/markdown/enhance'

function addShareAccess(html: string, slug: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const embed of template.content.querySelectorAll<HTMLElement>('.note-embed[data-embed-target]')) {
    embed.removeAttribute('data-embed-target')
    embed.classList.remove('loading')
    embed.classList.add('error')
    const body = embed.querySelector<HTMLElement>('.note-embed-body')
    if (body) {
      body.removeAttribute('aria-busy')
      body.textContent = 'Embedded private notes are not included in this blog'
    }
  }
  for (const task of template.content.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')) {
    task.disabled = true
    task.removeAttribute('data-task-line')
    task.setAttribute('aria-label', 'Tasks on this blog are read-only')
  }
  for (const element of template.content.querySelectorAll<HTMLImageElement | HTMLAnchorElement>('img[src], a[href]')) {
    const attr = element instanceof HTMLImageElement ? 'src' : 'href'
    const raw = element.getAttribute(attr)
    if (!raw)
      continue
    try {
      const url = new URL(raw, window.location.origin)
      if (url.origin !== window.location.origin ||
          !/^\/api\/files\/[0-9a-hjkmnp-tv-z]{26}$/i.test(url.pathname)) {
        continue
      }
      url.searchParams.set('share', slug)
      element.setAttribute(attr, `${url.pathname}${url.search}`)
    }
    catch {
      // ignore malformed URLs
    }
  }
  return template.innerHTML
}

export function BlogMarkdown({ content, slug }: {
  content: string
  slug: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setDark(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const html = useMemo(() => {
    const result = renderMarkdown(content)
    return addShareAccess(result.html, slug)
  }, [content, slug])

  useEffect(() => {
    if (!hostRef.current)
      return
    void enhancePreview(hostRef.current, { math: true, mermaid: true, dark })
  }, [html, dark])

  return (
    <div className="blog-prose" dangerouslySetInnerHTML={{ __html: html }} ref={hostRef} />
  )
}
