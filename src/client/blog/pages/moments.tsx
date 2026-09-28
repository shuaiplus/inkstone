import { useEffect, useState } from 'react'
import { blogApi } from '../api'
import type { BlogMomentsResponse, MomentItem } from '@shared/blog/types'
import { BlogMarkdown } from '../components/markdown'
import LoginPage from './login'
import { useBlogQuery } from './use-blog-query'
import { t } from '../../lib/i18n'

function formatDate(ts: number): string {
  if (!Number.isFinite(ts) || !ts)
    return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export default function MomentsPage({ username }: {
  username: string
}) {
  const [page, setPage] = useState(1)
  const [moments, setMoments] = useState<MomentItem[]>([])
  const [hasMore, setHasMore] = useState(false)
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
    return <LoginPage username={username} />
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
          {moments.map((moment) => (
            <article key={moment.id} className="blog-moment">
              <div className="blog-moment-time">
                {formatDate(moment.created_at)}
              </div>
              {moment.tags.length > 0 && (
                <div className="blog-moment-tags">
                  {moment.tags.map((tag) => (
                    <span key={tag} className="blog-chip blog-chip--sm blog-chip--static">{tag}</span>
                  ))}
                </div>
              )}
              <div className="blog-moment-body">
                <BlogMarkdown content={moment.content} slug={moment.slug} />
              </div>
            </article>
          ))}
        </div>
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
