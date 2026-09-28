import { useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { enhancePreview, renderPendingMermaid } from '../../lib/markdown/enhance'
import { t } from '../../lib/i18n'
import { isBlogDark, onBlogThemeChange } from '../theme'

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
      body.textContent = t('blog.embed_private_not_included')
    }
  }
  for (const task of template.content.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')) {
    task.disabled = true
    task.removeAttribute('data-task-line')
    task.setAttribute('aria-label', t('blog.tasks_read_only'))
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
  const [dark, setDark] = useState(() => isBlogDark())

  useEffect(() => {
    return onBlogThemeChange(() => setDark(isBlogDark()))
  }, [])

  const html = useMemo(() => {
    const result = renderMarkdown(content)
    return addShareAccess(result.html, slug)
  }, [content, slug])

  useEffect(() => {
    const host = hostRef.current
    if (!host)
      return
    let cancelled = false
    const isCurrent = () => !cancelled && hostRef.current === host
    void (async () => {
      await enhancePreview(host, { math: true, mermaid: true, dark })
      if (!isCurrent())
        return
      await renderPendingMermaid(host, dark, { isCurrent })
    })()
    return () => {
      cancelled = true
    }
  }, [html, dark])

  return (
    <div className="blog-prose" dangerouslySetInnerHTML={{ __html: html }} ref={hostRef} />
  )
}
