import { t } from '../../lib/i18n'

export function BlogFooter() {
  return (
    <footer className="blog-footer">
      <p>
        <a href="/">{t('blog.powered_by_inkstone')}</a>
      </p>
    </footer>
  )
}
