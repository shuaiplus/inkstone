import { useState } from 'react'
import { blogApi } from '../api'
import type { BlogPostsResponse } from '@shared/blog/types'
import { FeedCard } from '../components/feed-card'
import LoginPage from './login'
import { useBlogQuery } from './use-blog-query'
import { t } from '../../lib/i18n'

export default function FeedPage({ username }: {
  username: string
}) {
  const [page, setPage] = useState(1)
  const { status, data } = useBlogQuery<BlogPostsResponse>(
    () => blogApi.posts(username, page),
    [username, page],
  )

  if (status === 'auth')
    return <LoginPage username={username} />
  if (status === 'loading')
    return <div className="blog-loading">{t('blog.loading')}</div>
  if (status === 'error' || !data)
    return (
      <div className="blog-error-card">
        <p>{t('blog.feed_load_error')}</p>
      </div>
    )

  return (
    <div>
      <h1 className="blog-page-title">{t('blog.articles')}</h1>
      {data.posts.length === 0 ? (
        <p className="blog-empty">{t('blog.no_articles')}</p>
      ) : (
        data.posts.map((post) => (
          <FeedCard key={post.id} post={post} username={username} />
        ))
      )}
      <nav className="blog-pagination" aria-label={t('blog.pagination')}>
        <button type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          {t('blog.previous')}
        </button>
        <button type="button" disabled={!data.hasMore} onClick={() => setPage((p) => p + 1)}>
          {t('blog.next')}
        </button>
      </nav>
    </div>
  )
}
