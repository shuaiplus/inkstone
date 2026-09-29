import { blogApi } from '../api'
import type { BlogPostDetail } from '@shared/blog/types'
import { BlogMarkdown } from '../components/markdown'
import { TableOfContents } from '../components/toc'
import LoginPage from './login'
import { useBlogQuery } from './use-blog-query'
import { visibleTags } from '../filter-tags'
import { t } from '../../lib/i18n'

function formatDate(ts: number): string {
  if (!Number.isFinite(ts) || !ts)
    return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export default function PostPage({ username, slug, hiddenTags }: {
  username: string
  slug: string
  hiddenTags?: string[]
}) {
  const decodedSlug = safeDecodeURIComponent(slug)
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
  const tags = visibleTags(data.tags, hiddenTags)
  return (
    <div className="blog-post-page">
      <div className="blog-post-content">
        <article className="blog-post">
          <header className="blog-post-header">
            <h1 className="blog-post-title">{data.title}</h1>
            <div className="blog-post-meta">
              <time dateTime={new Date(data.created_at).toISOString()}>{formatDate(data.created_at)}</time>
            </div>
            {tags.length > 0 && (
              <div className="blog-post-tags">
                {tags.map((tag) => (
                  <a key={tag} className="blog-chip blog-chip--sm" href={`${base}/tags/${encodeURIComponent(tag)}`}>
                    {tag}
                  </a>
                ))}
              </div>
            )}
          </header>
          <BlogMarkdown content={data.content} slug={data.slug} />
          {(data.previous || data.next) && (
            <nav className="blog-post-nav" aria-label={t('blog.post_navigation')}>
              {data.previous && (
                <a className="blog-post-nav-link blog-post-nav-previous" href={`${base}/posts/${encodeURIComponent(data.previous.slug)}`}>
                  <span className="blog-post-nav-label">{t('blog.previous_post')}</span>
                  <span className="blog-post-nav-title">{data.previous.title}</span>
                </a>
              )}
              {data.next && (
                <a className="blog-post-nav-link blog-post-nav-next" href={`${base}/posts/${encodeURIComponent(data.next.slug)}`}>
                  <span className="blog-post-nav-label">{t('blog.next_post')}</span>
                  <span className="blog-post-nav-title">{data.next.title}</span>
                </a>
              )}
            </nav>
          )}
        </article>
      </div>
      <aside className="blog-toc-aside">
        <TableOfContents content={data.content} />
      </aside>
    </div>
  )
}
