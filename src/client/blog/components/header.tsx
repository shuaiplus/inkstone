import { useEffect, useState } from 'react'
import { t } from '../../lib/i18n'
import type { BlogTheme } from '../theme'

const LOCK_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
)

const MOON_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 14.2A8 8 0 0 1 9.8 4a8 8 0 1 0 10.2 10.2z" />
  </svg>
)

const SUN_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
  </svg>
)

const MENU_ICON = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </svg>
)

const CLOSE_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 6l12 12M6 18L18 6" />
  </svg>
)

const ARTICLES_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 5h16M4 10h16M4 15h10M4 20h7" />
  </svg>
)

const TIMELINE_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)

const TAGS_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 7v5.2a2 2 0 0 0 .6 1.4l7.8 7.8a2 2 0 0 0 2.8 0l5.4-5.4a2 2 0 0 0 0-2.8L12.8 6a2 2 0 0 0-1.4-.6H6a3 3 0 0 0-3 3z" />
    <circle cx="7.5" cy="9.5" r="1.2" fill="currentColor" stroke="none" />
  </svg>
)

const MOMENTS_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 8.5a2 2 0 0 1 2-2h2.2l1.2-1.8a1 1 0 0 1 .8-.4h5.6a1 1 0 0 1 .8.4l1.2 1.8H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
)

const BRAND_MARK = (
  <svg className="blog-brand-mark" width="28" height="28" viewBox="0 0 32 32" fill="none" aria-hidden>
    <rect x="3" y="3" width="26" height="26" rx="8" style={{ fill: 'var(--blog-text)' }} />
    <path d="M16 8.5c2.6 3.4 5.2 6.1 5.2 9a5.2 5.2 0 1 1-10.4 0c0-2.9 2.6-5.6 5.2-9z" style={{ fill: 'var(--blog-accent)' }} />
  </svg>
)

export function BlogHeader({ username, title, path, theme, onToggleTheme }: {
  username: string
  title?: string
  path: string
  theme: BlogTheme
  onToggleTheme: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const base = `/blog/${encodeURIComponent(username)}`
  const navItems = [
    { label: t('blog.articles'), path: '', icon: ARTICLES_ICON },
    { label: t('blog.timeline'), path: '/timeline', icon: TIMELINE_ICON },
    { label: t('blog.tags'), path: '/tags', icon: TAGS_ICON },
    { label: t('blog.moments'), path: '/moments', icon: MOMENTS_ICON },
  ]

  useEffect(() => {
    setMenuOpen(false)
  }, [path])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menuOpen])

  const isActive = (itemPath: string): boolean => {
    if (itemPath === '') return path === base || path === `${base}/`
    return path.startsWith(`${base}${itemPath}`)
  }

  const themeLabel = theme === 'dark' ? t('blog.to_light') : t('blog.to_dark')
  const momentsHref = `${base}/moments`

  return (
    <>
      <header className="blog-header">
        <div className="blog-header-inner">
          <a className="blog-brand" href={base}>
            {BRAND_MARK}
            <span className="blog-brand-name">{title || username}</span>
          </a>
          <nav className="blog-nav" aria-label={t('blog.navigation')}>
            <ul className="blog-nav-list">
              {navItems.map((item) => (
                <li key={item.label}>
                  <a
                    className={`blog-nav-item${isActive(item.path) ? ' blog-nav-item--active' : ''}`}
                    href={`${base}${item.path}`}
                    aria-current={isActive(item.path) ? 'page' : undefined}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="blog-header-actions">
            <a
              className="blog-icon-btn blog-icon-btn--quick"
              href={base}
              aria-label={t('blog.articles')}
              title={t('blog.articles')}
            >
              {ARTICLES_ICON}
            </a>
            <a
              className="blog-icon-btn blog-icon-btn--quick"
              href={momentsHref}
              aria-label={t('blog.moments')}
              title={t('blog.moments')}
            >
              {MOMENTS_ICON}
            </a>
            <a
              className="blog-icon-btn blog-icon-btn--lock"
              href={`${base}/login`}
              aria-label={t('blog.password')}
              title={t('blog.password')}
            >
              {LOCK_ICON}
            </a>
            <button
              type="button"
              className="blog-icon-btn"
              onClick={onToggleTheme}
              aria-label={themeLabel}
              title={themeLabel}
            >
              {theme === 'dark' ? SUN_ICON : MOON_ICON}
            </button>
            <button
              type="button"
              className="blog-menu-toggle"
              onClick={() => setMenuOpen(true)}
              aria-label={t('blog.open_menu')}
            >
              {MENU_ICON}
            </button>
          </div>
        </div>
      </header>
      {menuOpen && (
        <>
          <div className="blog-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="blog-menu-panel">
            <div className="blog-menu-inner">
              <div className="blog-menu-head">
                <span className="blog-menu-title">{t('blog.menu')}</span>
                <button
                  type="button"
                  className="blog-menu-close"
                  onClick={() => setMenuOpen(false)}
                  aria-label={t('blog.close')}
                >
                  {CLOSE_ICON}
                </button>
              </div>
              <nav className="blog-menu-nav">
                {navItems.map((item) => (
                  <a
                    key={item.label}
                    className={`blog-menu-item${isActive(item.path) ? ' blog-menu-item--active' : ''}`}
                    href={`${base}${item.path}`}
                  >
                    <span className="blog-menu-item-icon">{item.icon}</span>
                    {item.label}
                  </a>
                ))}
                <a className="blog-menu-item" href={`${base}/login`}>
                  <span className="blog-menu-item-icon">{LOCK_ICON}</span>
                  {t('blog.password')}
                </a>
              </nav>
              <div className="blog-menu-foot">
                <span className="blog-menu-foot-label">{t('blog.theme')}</span>
                <button
                  type="button"
                  className="blog-icon-btn"
                  onClick={onToggleTheme}
                  aria-label={themeLabel}
                >
                  {theme === 'dark' ? SUN_ICON : MOON_ICON}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}
