import { blogApi } from '../api'
import type { BlogPostDetail } from '@shared/blog/types'
import { BlogMarkdown } from '../components/markdown'
import LoginPage from './login'
import { useBlogQuery } from './use-blog-query'
import { t } from '../../lib/i18n'

function formatDate(ts: number): string {
  if (!Number.isFinite(ts) || !ts)
    return ''
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export default function PostPage({ username, slug }: {
  username: string
  slug: string
}) {
  const decodedSlug = decodeURIComponent(slug)
  const { status, data } = useBlogQuery<BlogPostDetail>(
    () => blogApi.post(username, decodedSlug),
    [username, decodedSlug],
  )

  if (status === 'auth')
    return <LoginPage username={username} />
  if (status === 'loading')
    return <div className="blog-loading">{t('blog.loading')}</div>
  if (status === 'error' || !data)
    return (
      <div className="blog-error-card">
        <p>{t('blog.post_load_error')}</p>
      </div>
    )

  const base = `/blog/${encodeURIComponent(username)}`
  return (
    <article>
      <h1 className="blog-page-title">{data.title}</h1>
      <div className="blog-card-meta">
        <time dateTime={new Date(data.created_at).toISOString()}>{formatDate(data.created_at)}</time>
      </div>
      {data.tags.length > 0 && (
        <div className="blog-card-tags">
          {data.tags.map((tag) => (
            <a key={tag} className="blog-chip" href={`${base}/tags/${encodeURIComponent(tag)}`}>
              {tag}
            </a>
          ))}
        </div>
      )}
      <BlogMarkdown content={data.content} slug={data.slug} />
    </article>
  )
}
