const NAV_ITEMS = [
  { label: 'Articles', path: '' },
  { label: 'Timeline', path: '/timeline' },
  { label: 'Tags', path: '/tags' },
  { label: 'Moments', path: '/moments' },
]

export function BlogHeader({ username, title }: {
  username: string
  title?: string
}) {
  const base = `/blog/${encodeURIComponent(username)}`
  return (
    <header className="blog-header">
      <div className="blog-header-inner">
        <a className="blog-header-title" href={base}>
          {title || username}
        </a>
        <nav className="blog-nav">
          {NAV_ITEMS.map((item) => (
            <a key={item.label} className="blog-nav-link" href={`${base}${item.path}`}>
              {item.label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  )
}
