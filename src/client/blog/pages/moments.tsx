import { blogApi } from '../api'
import type { MomentItem } from '@shared/blog/types'
import { BlogMarkdown } from '../components/markdown'
import LoginPage from './login'
import { useBlogQuery } from './use-blog-query'

function formatDate(ts: number): string {
  if (!Number.isFinite(ts) || !ts)
    return ''
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export default function MomentsPage({ username }: {
  username: string
}) {
  const { status, data } = useBlogQuery<{ moments: MomentItem[] }>(
    () => blogApi.moments(username),
    [username],
  )

  if (status === 'auth')
    return <LoginPage username={username} />
  if (status === 'loading')
    return <div className="blog-loading">Loading…</div>
  if (status === 'error' || !data)
    return (
      <div className="blog-error-card">
        <p>Could not load moments.</p>
      </div>
    )

  return (
    <div>
      <h1 className="blog-page-title">Moments</h1>
      {data.moments.length === 0 ? (
        <p className="blog-empty">No moments yet.</p>
      ) : (
        data.moments.map((moment) => (
          <article key={moment.id} className="blog-card">
            <BlogMarkdown content={moment.content} slug={moment.id} />
            <div className="blog-card-meta">
              <time dateTime={new Date(moment.created_at).toISOString()}>{formatDate(moment.created_at)}</time>
            </div>
          </article>
        ))
      )}
    </div>
  )
}
