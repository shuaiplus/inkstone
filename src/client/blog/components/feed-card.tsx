import type { BlogPostSummary } from '@shared/blog/types'
import { coverSrc } from '../cover'

function formatDate(ts: number): string {
  if (!Number.isFinite(ts) || !ts)
    return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function FeedCard({ post, username }: {
  post: BlogPostSummary
  username: string
}) {
  const base = `/blog/${encodeURIComponent(username)}`
  const cover = coverSrc(post)
  const href = `${base}/posts/${encodeURIComponent(post.slug)}`
  return (
    <article className="blog-feed-card">
      <a className="blog-feed-card-link" href={href} aria-label={post.title}>
        <div className="blog-feed-card-body">
          <h2 className="blog-feed-card-title">{post.title}</h2>
          <div className="blog-feed-card-meta">
            <time dateTime={new Date(post.created_at).toISOString()}>{formatDate(post.created_at)}</time>
          </div>
          {post.excerpt && <p className="blog-feed-card-excerpt">{post.excerpt}</p>}
          {post.tags.length > 0 && (
            <div className="blog-feed-card-tags">
              {post.tags.map((tag) => (
                <span key={tag} className="blog-chip blog-chip--sm blog-chip--static">{tag}</span>
              ))}
            </div>
          )}
        </div>
        {cover && (
          <div className="blog-feed-card-thumb">
            <img src={cover} alt="" loading="lazy" />
          </div>
        )}
      </a>
    </article>
  )
}
