import { useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { parseFrontMatter } from '@shared/markdown-utils'
import { t } from '../../lib/i18n'

interface TocItem {
  level: number
  text: string
  slug: string
}

export function TableOfContents({ content }: { content: string }) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const navRef = useRef<HTMLElement>(null)

  const items = useMemo<TocItem[]>(() => {
    const body = parseFrontMatter(content).body
    const { headings } = renderMarkdown(body)
    return headings.map((h) => ({ level: h.level, text: h.text, slug: h.slug }))
  }, [content])

  useEffect(() => {
    if (items.length === 0) return
    const root = document.querySelector('.blog-app')
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActiveId(visible[0].target.id)
      },
      { root, rootMargin: '-80px 0px -70% 0px', threshold: 0 },
    )
    for (const item of items) {
      const el = document.getElementById(item.slug)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [items])

  if (items.length === 0) return null

  const handleClick = (e: React.MouseEvent, slug: string) => {
    e.preventDefault()
    const el = document.getElementById(slug)
    const container = document.querySelector('.blog-app')
    if (el && container) {
      const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 80
      container.scrollTo({ top, behavior: 'smooth' })
    }
  }

  return (
    <nav className="blog-toc" ref={navRef} aria-label={t('blog.toc')}>
      <ul className="blog-toc-list">
        {items.map((item, i) => (
          <li key={i} className={`blog-toc-item${activeId === item.slug ? ' blog-toc-active' : ''}`} style={{ paddingLeft: `${(item.level - 1) * 12}px` }}>
            <a href={`#${item.slug}`} onClick={(e) => handleClick(e, item.slug)} title={item.text}>
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}