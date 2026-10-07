import { useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { enhancePreview, renderPendingMermaid, resetMermaidNode, toggleCodeBlockCollapse } from '../../lib/markdown/enhance'
import { selectMarkdownTab, moveMarkdownTabFocus } from '../../features/preview/markdown-tabs'
import { t } from '../../lib/i18n'
import { isBlogDark, onBlogThemeChange } from '../theme'
import { BlogLightbox } from './lightbox'

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
  const revRef = useRef(0)
  const copyTimersRef = useRef(new Map<HTMLElement, number>())
  const [dark, setDark] = useState(() => isBlogDark())
  const [lightbox, setLightbox] = useState<{ src: string; images: string[]; index: number } | null>(null)

  useEffect(() => {
    return onBlogThemeChange(() => setDark(isBlogDark()))
  }, [])

  useEffect(() => () => {
    for (const timer of copyTimersRef.current.values())
      window.clearTimeout(timer)
    copyTimersRef.current.clear()
  }, [])

  const html = useMemo(() => {
    const result = renderMarkdown(content)
    return addShareAccess(result.html, slug)
  }, [content, slug])

  useEffect(() => {
    const host = hostRef.current
    if (!host)
      return
    const rev = ++revRef.current
    let cancelled = false
    const isCurrent = () => !cancelled && revRef.current === rev && hostRef.current === host

    void (async () => {
      await enhancePreview(host, { math: true, mermaid: true, dark, codeBlockCollapseLines: 24 })
      if (!isCurrent())
        return
      await renderPendingMermaid(host, dark, { isCurrent })
    })()
    return () => {
      cancelled = true
    }
  }, [html, dark])

  const onHostClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const img = target.closest<HTMLImageElement>('img')
    if (img?.src) {
      e.preventDefault()
      setLightbox({ src: img.src, images: [img.src], index: 0 })
      return
    }
    const mermaidRetry = target.closest<HTMLElement>('[data-mermaid-retry]')
    if (mermaidRetry) {
      const block = mermaidRetry.closest<HTMLElement>('[data-mermaid]')
      const host = hostRef.current
      if (block && host) {
        resetMermaidNode(block)
        const rev = ++revRef.current
        void renderPendingMermaid(host, dark, {
          isCurrent: () => revRef.current === rev && hostRef.current === host,
        })
      }
      return
    }
    const copyButton = target.closest<HTMLElement>('[data-copy]')
    if (copyButton) {
      const code = copyButton.closest('.code-block')?.querySelector('pre')?.textContent ?? ''
      if (!navigator.clipboard?.writeText)
        return
      void navigator.clipboard.writeText(code).then(() => {
        if (!hostRef.current?.contains(copyButton))
          return
        const existing = copyTimersRef.current.get(copyButton)
        if (existing !== undefined)
          window.clearTimeout(existing)
        copyButton.textContent = t('common.copied')
        copyButton.classList.add('copied')
        const timer = window.setTimeout(() => {
          if (hostRef.current?.contains(copyButton)) {
            copyButton.textContent = t('common.copy')
            copyButton.classList.remove('copied')
          }
          copyTimersRef.current.delete(copyButton)
        }, 900)
        copyTimersRef.current.set(copyButton, timer)
      }).catch(() => {})
      return
    }
    const collapseButton = target.closest<HTMLButtonElement>('[data-code-collapse]')
    if (collapseButton) {
      toggleCodeBlockCollapse(collapseButton)
      return
    }
    const tabButton = target.closest<HTMLButtonElement>('[data-tab-button]')
    if (tabButton) {
      e.preventDefault()
      selectMarkdownTab(tabButton)
    }
  }

  const onHostKeyDown = (e: React.KeyboardEvent) => {
    const tab = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tab-button]')
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault()
      moveMarkdownTabFocus(tab, e.key)
    }
  }

  return (
    <>
      <div
        className="blog-prose"
        dangerouslySetInnerHTML={{ __html: html }}
        ref={hostRef}
        onClick={onHostClick}
        onKeyDown={onHostKeyDown}
      />
      {lightbox && (
        <BlogLightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onNavigate={(i) => setLightbox({ src: lightbox.images[i]!, images: lightbox.images, index: i })}
        />
      )}
    </>
  )
}
