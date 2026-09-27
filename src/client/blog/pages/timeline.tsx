import { useEffect, useMemo, useState } from 'react'
import { blogApi } from '../api'
import type { BlogTimelineResponse, TimelineItem } from '@shared/blog/types'
import LoginPage from './login'
import { useBlogQuery } from './use-blog-query'
import { t } from '../../lib/i18n'

function formatMonthDay(ts: number): string {
  if (!Number.isFinite(ts) || !ts)
    return ''
  return new Date(ts).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })
}

export default function TimelinePage({ username }: {
  username: string
}) {
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<TimelineItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const { status, data } = useBlogQuery<BlogTimelineResponse>(
    () => blogApi.timeline(username, page),
    [username, page],
  )

  useEffect(() => {
    if (!data || data.page !== page)
      return
    setItems((prev) => (page === 1 ? data.items : [...prev, ...data.items]))
    setHasMore(data.hasMore)
  }, [data, page])

  const byYear = useMemo(() => {
    const groups = new Map<string, TimelineItem[]>()
    for (const item of items) {
      const year = String(item.year ?? new Date(item.created_at).getFullYear())
      const list = groups.get(year)
      if (list)
        list.push(item)
      else
        groups.set(year, [item])
    }
    return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [items])

  if (status === 'auth')
    return <LoginPage username={username} />
  if (page === 1 && (status === 'loading' || !data))
    return <div className="blog-loading">{t('blog.loading')}</div>
  if (status === 'error' || !data)
    return (
      <div className="blog-error-card">
        <p>{t('blog.timeline_load_error')}</p>
      </div>
    )

  const loadingMore = status === 'loading' && page > 1
  const base = `/blog/` + encodeURIComponent(username)

  return (
    <div>
      <h1 className="blog-section-title">{t('blog.timeline')}</h1>
      {items.length === 0 ? (
        <p className="blog-empty">{t('blog.no_timeline')}</p>
      ) : (
        byYear.map(([year, yearItems]) => (
          <section key={year} className="blog-timeline-group">
            <h2 className="blog-timeline-year">{year}</h2>
            <ul className="blog-timeline-list">
              {yearItems.map((item) => (
                <li key={item.id} className="blog-timeline-row">
                  <a href={`${base}/posts/${encodeURIComponent(item.slug)}`}>
                    <span className="blog-timeline-date">{formatMonthDay(item.created_at)}</span>
                    <span className="blog-timeline-title">{item.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {hasMore && (
        <div className="blog-load-more">
          <button type="button" disabled={loadingMore} onClick={() => setPage((p) => p + 1)}>
            {loadingMore ? t('blog.loading') : t('blog.load_more')}
          </button>
        </div>
      )}
    </div>
  )
}