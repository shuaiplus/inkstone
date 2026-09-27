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
    <article className="blog-card">
      <a className="blog-card-link" href={href} aria-label={post.title}>
        {cover && (
          <div className="blog-card-cover" aria-hidden>
            <img src={cover} alt="" loading="lazy" />
          </div>
        )}
        <h2 className="blog-card-title">{post.title}</h2>
        {post.excerpt && <p className="blog-card-excerpt">{post.excerpt}</p>}
        <div className="blog-card-meta">
          <time dateTime={new Date(post.created_at).toISOString()}>{formatDate(post.created_at)}</time>
        </div>
      </a>
      {post.tags.length > 0 && (
        <div className="blog-card-tags">
          {post.tags.map((tag) => (
            <a key={tag} className="blog-chip" href={`${base}/tags/${encodeURIComponent(tag)}`}>
              {tag}
            </a>
          ))}
        </div>
      )}
    </article>
  )
}
