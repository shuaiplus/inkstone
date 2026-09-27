import { t } from '../../lib/i18n'

const LOCK_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
)

export function BlogHeader({ username, title, description }: {
  username: string
  title?: string
  description?: string | null
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
        <div className="blog-header-left">
          <a className="blog-header-title" href={base}>
            {title || username}
          </a>
          {description && <p className="blog-header-desc">{description}</p>}
        </div>
        <nav className="blog-nav-inline" aria-label={t('blog.navigation')}>
          {navItems.map((item) => (
            <a key={item.label} className="blog-nav-item" href={`${base}${item.path}`}>
              {item.label}
            </a>
          ))}
          <a className="blog-nav-item blog-nav-lock" href={`${base}/login`} aria-label={t('blog.password')} title={t('blog.password')}>
            {LOCK_ICON}
          </a>
        </nav>
      </div>
    </header>
  )
}
