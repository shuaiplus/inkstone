import { Component, lazy, Suspense, useEffect, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react'
import { blogApi, BlogAuthError } from './api'
import { BlogHeader } from './components/header'
import { BlogFooter } from './components/footer'
import { t } from '../lib/i18n'
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

const metaCache = new Map<string, { title?: string; description?: string | null }>()

export default function BlogApp({ username }: {
  username: string
}) {
  const [path, setPath] = useState(() => window.location.pathname)
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

  const { Component, props } = matchRoute(username, path)
  const [meta, setMeta] = useState<{ title?: string; description?: string | null }>(() => metaCache.get(username) ?? {})
  useEffect(() => {
    let cancelled = false
    blogApi.meta(username)
      .then((m) => {
        if (cancelled) return
        const next = { title: m.title ?? undefined, description: m.description }
        metaCache.set(username, next)
        setMeta(next)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [username])
  return (
    <div className="blog-app">
      <BlogHeader username={username} title={meta.title} description={meta.description} />
      <main className="blog-main">
        <AuthBoundary username={username}>
          <Suspense fallback={<div className="blog-loading">{t('blog.loading')}</div>}>
            <Component key={`${username}:${path}`} {...props} />
          </Suspense>
        </AuthBoundary>
      </main>
      <BlogFooter />
    </div>
  )
}
