import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react'
import { blogApi, BlogAuthError, type BlogMeta } from './api'
import { BlogHeader } from './components/header'
import { BlogFooter } from './components/footer'
import { t } from '../lib/i18n'
import { MOMENTS_TAG } from '@shared/blog/tags'
import { initialBlogTheme, saveBlogTheme, dispatchBlogTheme, type BlogTheme } from './theme'
import './styles.css'

const FeedPage = lazy(() => import('./pages/feed'))
const PostPage = lazy(() => import('./pages/post'))
const MomentsPage = lazy(() => import('./pages/moments'))
const TimelinePage = lazy(() => import('./pages/timeline'))
const TagsPage = lazy(() => import('./pages/tags'))
const TagPage = lazy(() => import('./pages/tag'))
const LoginPage = lazy(() => import('./pages/login'))

interface RouteMatch {
  Component: LazyExoticComponent<ComponentType<any>>
  props: Record<string, string>
}

function matchRoute(username: string, pathname: string): RouteMatch {
  const rest = pathname.split('/').filter(Boolean).slice(2)
  if (rest[0] === 'posts' && rest[1])
    return { Component: PostPage, props: { username, slug: rest[1] } }
  if (rest[0] === 'login')
    return { Component: LoginPage, props: { username } }
  if (rest[0] === 'moments')
    return { Component: MomentsPage, props: { username } }
  if (rest[0] === 'timeline')
    return { Component: TimelinePage, props: { username } }
  if (rest[0] === 'tags' && rest[1])
    return { Component: TagPage, props: { username, name: rest[1] } }
  if (rest[0] === 'tags')
    return { Component: TagsPage, props: { username } }
  return { Component: FeedPage, props: { username } }
}

interface AuthBoundaryProps {
  username: string
  children: ReactNode
}

interface AuthBoundaryState {
  authError: boolean
}

class AuthBoundary extends Component<AuthBoundaryProps, AuthBoundaryState> {
  state: AuthBoundaryState = { authError: false }

  static getDerivedStateFromError(error: unknown): AuthBoundaryState | null {
    if (error instanceof BlogAuthError)
      return { authError: true }
    return null
  }

  componentDidCatch(error: unknown): void {
    if (!(error instanceof BlogAuthError))
      throw error
  }

  render(): ReactNode {
    if (this.state.authError) {
      return (
        <Suspense fallback={<div className="blog-loading">{t('blog.loading')}</div>}>
          <LoginPage username={this.props.username} />
        </Suspense>
      )
    }
    return this.props.children
  }
}

const metaCache = new Map<string, BlogMeta>()

export default function BlogApp({ username }: {
  username: string
}) {
  const [path, setPath] = useState(() => window.location.pathname)
  const [theme, setTheme] = useState<BlogTheme>(() => initialBlogTheme())
  const appRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as HTMLElement)?.closest('a')
      if (!a || !a.href) return
      const url = new URL(a.href, window.location.origin)
      if (url.origin !== window.location.origin) return
      if (!url.pathname.startsWith(`/blog/${encodeURIComponent(username)}`)) return
      e.preventDefault()
      window.history.pushState(null, '', url.href)
      setPath(url.pathname)
      const app = document.querySelector('.blog-app')
      if (app) app.scrollTop = 0
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [username])

  useEffect(() => {
    const app = appRef.current
    if (!app) return
    const onScroll = () => {
      const max = app.scrollHeight - app.clientHeight
      app.style.setProperty('--blog-progress', String(max > 0 ? app.scrollTop / max : 0))
      const header = app.querySelector('.blog-header')
      if (header) header.classList.toggle('is-scrolled', app.scrollTop > 4)
    }
    app.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => app.removeEventListener('scroll', onScroll)
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: BlogTheme = prev === 'dark' ? 'light' : 'dark'
      saveBlogTheme(next)
      return next
    })
  }, [])

  useEffect(() => {
    dispatchBlogTheme(theme)
  }, [theme])

  const { Component, props } = matchRoute(username, path)
  const [meta, setMeta] = useState<BlogMeta | undefined>(() => metaCache.get(username))
  useEffect(() => {
    let cancelled = false
    blogApi.meta(username)
      .then((m) => {
        if (cancelled) return
        metaCache.set(username, m)
        setMeta(m)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [username])

  // Moments hides the public + moments markers but keeps the private tag
  // visible as a locked-content reminder; the tags index hides nothing.
  const hiddenTags = !meta
    ? []
    : Component === MomentsPage
      ? [meta.publicTag, meta.momentsTag ?? MOMENTS_TAG]
      : Component === TagsPage
        ? []
        : [meta.publicTag, meta.privateTag]

  return (
    <div ref={appRef} className="blog-app" data-theme={theme} data-accent={meta?.accent || undefined}>
      <div className="blog-read-progress" aria-hidden />
      <BlogHeader
        username={username}
        title={meta?.title ?? undefined}
        path={path}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <main className="blog-main">
        <AuthBoundary username={username}>
          <Suspense fallback={<div className="blog-loading">{t('blog.loading')}</div>}>
            <Component
              key={`${username}:${path}`}
              {...props}
        title={meta?.title ?? undefined}
              description={meta?.description ?? undefined}
              hiddenTags={hiddenTags}
            />
          </Suspense>
        </AuthBoundary>
      </main>
      <BlogFooter />
    </div>
  )
}
