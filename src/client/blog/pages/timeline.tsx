import { useMemo } from 'react'
import { blogApi } from '../api'
import type { TimelineItem } from '@shared/blog/types'
import LoginPage from './login'
import { useBlogQuery } from './use-blog-query'
import { t } from '../../lib/i18n'

function formatDate(ts: number): string {
  if (!Number.isFinite(ts) || !ts)
    return ''
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export default function TimelinePage({ username }: {
  username: string
}) {
  const { status, data } = useBlogQuery<{ items: TimelineItem[] }>(
    () => blogApi.timeline(username),
    [username],
  )

  const byYear = useMemo(() => {
    const groups = new Map<string, TimelineItem[]>()
    for (const item of data?.items ?? []) {
      const year = String(item.year ?? new Date(item.created_at).getFullYear())
      const list = groups.get(year)
      if (list)
        list.push(item)
      else
        groups.set(year, [item])
    }
    return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [data])

  if (status === 'auth')
    return <LoginPage username={username} />
  if (status === 'loading')
    return <div className="blog-loading">{t('blog.loading')}</div>
  if (status === 'error' || !data)
    return (
      <div className="blog-error-card">
        <p>{t('blog.timeline_load_error')}</p>
      </div>
    )

  return (
    <div>
      <h1 className="blog-page-title">{t('blog.timeline')}</h1>
      {data.items.length === 0 ? (
        <p className="blog-empty">{t('blog.no_timeline')}</p>
      ) : (
        byYear.map(([year, items]) => (
          <section key={year}>
            <h2>{year}</h2>
            {items.map((item) => (
              <article key={item.id} className="blog-card">
                <h3 className="blog-card-title">{item.title}</h3>
                <div className="blog-card-meta">
                  <time dateTime={new Date(item.created_at).toISOString()}>{formatDate(item.created_at)}</time>
                </div>
              </article>
            ))}
          </section>
        ))
      )}
    </div>
  )
}
