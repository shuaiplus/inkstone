import { blogApi } from '../api'
import type { BlogTag } from '@shared/blog/types'
import LoginPage from './login'
import { useBlogQuery } from './use-blog-query'
import { visibleTags } from '../filter-tags'
import { t } from '../../lib/i18n'

export default function TagsPage({ username, hiddenTags }: {
  username: string
  hiddenTags?: string[]
}) {
  const { status, data } = useBlogQuery<{ tags: BlogTag[] }>(
    () => blogApi.tags(username),
    [username],
  )

  if (status === 'auth')
    return <LoginPage username={username} />
  if (status === 'loading')
    return <div className="blog-loading">{t('blog.loading')}</div>
  if (status === 'error' || !data)
    return (
      <div className="blog-error-card">
        <p>{t('blog.tags_load_error')}</p>
      </div>
    )

  const base = `/blog/${encodeURIComponent(username)}`
  const visible = data.tags.filter((tag) => visibleTags([tag.name], hiddenTags).length > 0)
  return (
    <div>
      <h1 className="blog-section-title">{t('blog.tags')}</h1>
      {visible.length === 0 ? (
        <p className="blog-empty">{t('blog.no_tags')}</p>
      ) : (
        <div className="blog-tag-cloud">
          {visible.map((tag) => (
            <a key={tag.name} className="blog-chip" href={`${base}/tags/${encodeURIComponent(tag.name)}`}>
              {tag.name} <span className="blog-chip-count">{tag.count}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
