import { Component, lazy, Suspense, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react'
import { BlogAuthError } from './api'
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

function matchRoute(username: string): RouteMatch {
  const rest = window.location.pathname.split('/').filter(Boolean).slice(2)
  if (rest[0] === 'posts' && rest[1])
    return { Component: PostPage, props: { username, slug: rest[1] } }
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

export default function BlogApp({ username }: {
  username: string
}) {
  const { Component, props } = matchRoute(username)
  return (
    <div className="blog-app">
      <BlogHeader username={username} />
      <main className="blog-main">
        <AuthBoundary username={username}>
          <Suspense fallback={<div className="blog-loading">{t('blog.loading')}</div>}>
            <Component {...props} />
          </Suspense>
        </AuthBoundary>
      </main>
      <BlogFooter />
    </div>
  )
}
