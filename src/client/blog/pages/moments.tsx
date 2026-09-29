import { useEffect, useState } from 'react'
import { blogApi } from '../api'
import type { BlogMomentsResponse, MomentItem } from '@shared/blog/types'
import { BlogMarkdown } from '../components/markdown'
import { BlogLightbox } from '../components/lightbox'
import { useBlogQuery } from './use-blog-query'
import { visibleTags } from '../filter-tags'
import { extractImageSrcs } from '@shared/markdown-utils'
import { t } from '../../lib/i18n'

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

export default function MomentsPage({ username, hiddenTags }: {
  username: string
  hiddenTags?: string[]
}) {
  const [page, setPage] = useState(1)
  const [moments, setMoments] = useState<MomentItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [lightbox, setLightbox] = useState<{ images: string[]; index: number } | null>(null)
  const { status, data } = useBlogQuery<BlogMomentsResponse>(
    () => blogApi.moments(username, page),
    [username, page],
  )

  useEffect(() => {
    if (!data || data.page !== page)
      return
    setMoments((prev) => (page === 1 ? data.moments : [...prev, ...data.moments]))
    setHasMore(data.hasMore)
  }, [data, page])

  if (status === 'auth')
    return <div className="blog-loading">{t('blog.loading')}</div>
  if (page === 1 && (status === 'loading' || !data))
    return <div className="blog-loading">{t('blog.loading')}</div>
  if (status === 'error' || !data)
    return (
      <div className="blog-error-card">
        <p>{t('blog.moments_load_error')}</p>
      </div>
    )

  const loadingMore = status === 'loading' && page > 1

  return (
    <div>
      <h1 className="blog-section-title">{t('blog.moments')}</h1>
      {moments.length === 0 ? (
        <p className="blog-empty">{t('blog.no_moments')}</p>
      ) : (
        <div className="blog-moments-feed">
          {moments.map((moment) => {
            const tags = visibleTags(moment.tags, hiddenTags)
            const images = extractImageSrcs(moment.content).map((src) => appendShare(src, moment.slug))
            return (
              <article key={moment.id} className="blog-moment">
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
              </article>
            )
          })}
        </div>
      )}
      {hasMore && (
        <div className="blog-load-more">
          <button type="button" disabled={loadingMore} onClick={() => setPage((p) => p + 1)}>
            {loadingMore ? t('blog.loading') : t('blog.load_more')}
          </button>
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
    </div>
  )
}
