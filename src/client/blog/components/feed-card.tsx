import type { BlogPostSummary } from '@shared/blog/types'
import { isReservedBlogTag } from '@shared/blog/tags'

function formatDate(ts: number): string {
  if (!Number.isFinite(ts) || !ts)
    return ''
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function FeedCard({ post, username }: {
  post: BlogPostSummary
  username: string
}) {
  const base = `/blog/${encodeURIComponent(username)}`
  return (
    <article className="blog-card">
      <h2 className="blog-card-title">
        <a href={`${base}/posts/${encodeURIComponent(post.slug)}`}>{post.title}</a>
      </h2>
      {post.excerpt && <p className="blog-card-excerpt">{post.excerpt}</p>}
      <div className="blog-card-meta">
        <time dateTime={new Date(post.created_at).toISOString()}>{formatDate(post.created_at)}</time>
      </div>
      {post.tags.some((tag) => !isReservedBlogTag(tag)) && (
        <div className="blog-card-tags">
          {post.tags.filter((tag) => !isReservedBlogTag(tag)).map((tag) => (
            <a key={tag} className="blog-chip" href={`${base}/tags/${encodeURIComponent(tag)}`}>
              {tag}
            </a>
          ))}
        </div>
      )}
    </article>
  )
}
