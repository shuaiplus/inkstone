import { useState } from 'react'
import type { MomentItem } from '@shared/blog/types'
import { BlogMarkdown } from './markdown'
import { BlogLightbox } from './lightbox'
import { visibleTags } from '../filter-tags'
import { extractImageSrcs } from '@shared/markdown-utils'

function formatDate(ts: number): string {
  if (!Number.isFinite(ts) || !ts)
    return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function appendShare(src: string, slug: string): string {
  try {
    const url = new URL(src, window.location.origin)
    if (url.origin !== window.location.origin ||
        !/^\/api\/files\/[0-9a-hjkmnp-tv-z]{26}$/i.test(url.pathname)) {
      return src
    }
    url.searchParams.set('share', slug)
    return `${url.pathname}${url.search}`
  } catch {
    return src
  }
}

export function MomentCard({ moment, hiddenTags }: {
  moment: MomentItem
  hiddenTags?: string[]
}) {
  const [lightbox, setLightbox] = useState<{ images: string[]; index: number } | null>(null)
  const tags = visibleTags(moment.tags, hiddenTags)
  const images = extractImageSrcs(moment.content).map((src) => appendShare(src, moment.slug))

  return (
    <article className="blog-moment">
      <div className="blog-moment-time">
        {formatDate(moment.created_at)}
      </div>
      {tags.length > 0 && (
        <div className="blog-moment-tags">
          {tags.map((tag) => (
            <span key={tag} className="blog-chip blog-chip--sm blog-chip--static">{tag}</span>
          ))}
        </div>
      )}
      <div className={`blog-moment-body${images.length > 0 ? ' blog-moment-body--has-images' : ''}`}>
        <BlogMarkdown content={moment.content} slug={moment.slug} />
      </div>
      {images.length > 0 && (
        <div
          className={`blog-moment-images blog-moment-images--${Math.min(images.length, 9)}`}
        >
          {images.slice(0, 9).map((src, i) => (
            <button
              key={i}
              type="button"
              className="blog-moment-image"
              onClick={() => setLightbox({ images, index: i })}
            >
              <img src={src} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {lightbox && (
        <BlogLightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onNavigate={(i) => setLightbox({ images: lightbox.images, index: i })}
        />
      )}
    </article>
  )
}
