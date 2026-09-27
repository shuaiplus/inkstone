import { blogApi } from '../api'
import type { BlogPostSummary } from '@shared/blog/types'
import { FeedCard } from '../components/feed-card'
import LoginPage from './login'
import { useBlogQuery } from './use-blog-query'
import { t } from '../../lib/i18n'

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export default function TagPage({ username, name }: {
  username: string
  name: string
}) {
  const decodedName = safeDecodeURIComponent(name)
  const { status, data } = useBlogQuery<{ name: string; posts: BlogPostSummary[] }>(
    () => blogApi.tag(username, decodedName),
    [username, decodedName],
  )

  if (status === 'auth')
    return <LoginPage username={username} />
  if (status === 'loading')
    return <div className="blog-loading">{t('blog.loading')}</div>
  if (status === 'error' || !data)
    return (
      <div className="blog-error-card">
        <p>{t('blog.tag_load_error')}</p>
      </div>
    )

  return (
    <div>
      <h1 className="blog-section-title">{t('blog.tag')} {data.name}</h1>
      {data.posts.length === 0 ? (
        <p className="blog-empty">{t('blog.no_posts_for_tag')}</p>
      ) : (
        data.posts.map((post) => (
          <FeedCard key={post.id} post={post} username={username} />
        ))
      )}
    </div>
  )
}
