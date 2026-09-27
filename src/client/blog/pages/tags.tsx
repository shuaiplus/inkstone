import { blogApi } from '../api'
import type { BlogTag } from '@shared/blog/types'
import LoginPage from './login'
import { useBlogQuery } from './use-blog-query'

export default function TagsPage({ username }: {
  username: string
}) {
  const { status, data } = useBlogQuery<{ tags: BlogTag[] }>(
    () => blogApi.tags(username),
    [username],
  )

  if (status === 'auth')
    return <LoginPage username={username} />
  if (status === 'loading')
    return <div className="blog-loading">Loading…</div>
  if (status === 'error' || !data)
    return (
      <div className="blog-error-card">
        <p>Could not load tags.</p>
      </div>
    )

  const base = `/blog/${encodeURIComponent(username)}`
  return (
    <div>
      <h1 className="blog-page-title">Tags</h1>
      {data.tags.length === 0 ? (
        <p className="blog-empty">No tags yet.</p>
      ) : (
        <div className="blog-card-tags">
          {data.tags.map((tag) => (
            <a key={tag.name} className="blog-chip" href={`${base}/tags/${encodeURIComponent(tag.name)}`}>
              {tag.name} ({tag.count})
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
