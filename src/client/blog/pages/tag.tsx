import { blogApi } from '../api'
import type { BlogPostSummary } from '@shared/blog/types'
import { FeedCard } from '../components/feed-card'
import LoginPage from './login'
import { useBlogQuery } from './use-blog-query'

export default function TagPage({ username, name }: {
  username: string
  name: string
}) {
  const decodedName = decodeURIComponent(name)
  const { status, data } = useBlogQuery<{ name: string; posts: BlogPostSummary[] }>(
    () => blogApi.tag(username, decodedName),
    [username, decodedName],
  )

  if (status === 'auth')
    return <LoginPage username={username} />
  if (status === 'loading')
    return <div className="blog-loading">Loading…</div>
  if (status === 'error' || !data)
    return (
      <div className="blog-error-card">
        <p>Could not load this tag.</p>
      </div>
    )

  return (
    <div>
      <h1 className="blog-page-title">Tag: {data.name}</h1>
      {data.posts.length === 0 ? (
        <p className="blog-empty">No posts with this tag yet.</p>
      ) : (
        data.posts.map((post) => (
          <FeedCard key={post.id} post={post} username={username} />
        ))
      )}
    </div>
  )
}
