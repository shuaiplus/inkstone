import { useEffect, useState } from 'react'
import { blogApi } from '../api'
import type { BlogMomentsResponse, MomentItem } from '@shared/blog/types'
import { MomentCard } from '../components/moment-card'
import { useBlogQuery } from './use-blog-query'
import { t } from '../../lib/i18n'

export default function MomentsPage({ username, hiddenTags }: {
  username: string
  hiddenTags?: string[]
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
          {moments.map((moment) => (
            <MomentCard key={moment.id} moment={moment} username={username} hiddenTags={hiddenTags} />
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
