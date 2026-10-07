import { useState } from 'react'
import { blogApi } from '../api'
import type { BlogPostsResponse } from '@shared/blog/types'
import { FeedCard } from '../components/feed-card'
import LoginPage from './login'
import { useBlogQuery } from './use-blog-query'
import { t } from '../../lib/i18n'

function pageNumbers(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 7)
    return Array.from({ length: total }, (_, i) => i + 1)
  const wanted = new Set([1, total, current, current - 1, current + 1])
  const sorted = [...wanted].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b)
  const out: (number | 'ellipsis')[] = []
  let prev = 0
  for (const p of sorted) {
    if (prev && p - prev > 1)
      out.push('ellipsis')
    out.push(p)
    prev = p
  }
  return out
}

export default function FeedPage({ username, title, description, hiddenTags }: {
  username: string
  title?: string
  description?: string
  hiddenTags?: string[]
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

  const totalPages = Math.max(1, data.totalPages)
  const initial = (username || '?').charAt(0).toUpperCase()

  return (
    <div>
      {(title || description) && (
        <section className="blog-intro">
          <span className="blog-intro-avatar">{initial}</span>
          <div className="blog-intro-body">
            {title && <h2 className="blog-intro-name">{title}</h2>}
            {description && <p className="blog-intro-text">{description}</p>}
          </div>
        </section>
      )}
      <h1 className="blog-section-title">{t('blog.articles')}</h1>
      {data.posts.length === 0 ? (
        <p className="blog-empty">{t('blog.no_articles')}</p>
      ) : (
        <div className="blog-feed-list">
          {data.posts.map((post) => (
            <FeedCard key={post.id} post={post} username={username} hiddenTags={hiddenTags} />
          ))}
        </div>
      )}
      {totalPages > 1 && (
        <nav className="blog-pagination" aria-label={t('blog.pagination')}>
          <button
            type="button"
            className="blog-page-btn"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            {t('blog.previous')}
          </button>
          {pageNumbers(page, totalPages).map((item, i) =>
            item === 'ellipsis' ? (
              <span key={`e${i}`} className="blog-page-ellipsis">...</span>
            ) : (
              <button
                key={item}
                type="button"
                className={`blog-page-btn${item === page ? ' blog-page-btn--active' : ''}`}
                aria-current={item === page ? 'page' : undefined}
                onClick={() => setPage(item)}
              >
                {item}
              </button>
            ),
          )}
          <button
            type="button"
            className="blog-page-btn"
            disabled={!data.hasMore}
            onClick={() => setPage((p) => p + 1)}
          >
            {t('blog.next')}
          </button>
        </nav>
      )}
    </div>
  )
}
