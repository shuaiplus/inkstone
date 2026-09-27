import { t } from '../../lib/i18n'

export function BlogHeader({ username, title }: {
  username: string
  title?: string
}) {
  const base = `/blog/${encodeURIComponent(username)}`
  const navItems = [
    { label: t('blog.articles'), path: '' },
    { label: t('blog.timeline'), path: '/timeline' },
    { label: t('blog.tags'), path: '/tags' },
    { label: t('blog.moments'), path: '/moments' },
  ]
  return (
    <header className="blog-header">
      <div className="blog-header-inner">
        <a className="blog-header-title" href={base}>
          {title || username}
        </a>
        <nav className="blog-nav">
          {navItems.map((item) => (
            <a key={item.label} className="blog-nav-link" href={`${base}${item.path}`}>
              {item.label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  )
}
