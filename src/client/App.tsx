import { lazy, Suspense, useEffect, useState } from 'react'
import { ConfirmHost } from './components/overlay'
import { Toaster } from './components/feedback'
import { Spinner } from './components/primitives'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LoginPage } from './features/auth/LoginPage'
import { dismissBootScreen } from './lib/boot'
import { t, useLocale } from './lib/i18n'
import { initializePwa, requestOfflineWarmup } from './store/pwa'
import { useSession, watchSystemTheme } from './store/session'

const AppShell = lazy(() =>
  import('./features/shell/AppShell').then((module) => ({ default: module.AppShell })),
)
const SharePage = lazy(() =>
  import('./features/share/SharePage').then((module) => ({ default: module.SharePage })),
)
const BlogApp = lazy(() => import('./blog/router'))

export function App() {

  useLocale()
  const status = useSession((s) => s.status)
  const load = useSession((s) => s.load)
  const [blogUsername, setBlogUsername] = useState<string | null>(() => {
    const match = /^\/blog\/([A-Za-z0-9_-]+)/.exec(location.pathname)
    return match?.[1] ?? null
  })
  const [shareSlug] = useState(() => {
    const match = /^\/s\/([A-Za-z0-9_-]+)/.exec(location.pathname)
    return match?.[1] ?? null
  })

  useEffect(() => {
    if (blogUsername) return
    const isBlogRoot = /^\/blog\/?$/.test(location.pathname)
    if (!isBlogRoot) return
    let cancelled = false
    fetch('/api/blog/owner', { headers: { 'X-Inkstone-Client': '1' } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.username) return
        const target = `/blog/${encodeURIComponent(data.username)}`
        window.history.replaceState(null, '', target)
        setBlogUsername(data.username)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [blogUsername])

  useEffect(() => {
    if (shareSlug || blogUsername) return
    void load()
  }, [load, shareSlug, blogUsername])

  useEffect(() => watchSystemTheme(), [])

  useEffect(() => {
    initializePwa()
  }, [])

  useEffect(() => {
    if (!shareSlug && !blogUsername && status !== 'loading') requestOfflineWarmup()
  }, [shareSlug, blogUsername, status])

  useEffect(() => {
    if (shareSlug || blogUsername || status !== 'loading') dismissBootScreen()
  }, [status, shareSlug, blogUsername])

  useEffect(() => {
    if (shareSlug || blogUsername) return
    const timer = window.setTimeout(() => dismissBootScreen(), 8000)
    return () => window.clearTimeout(timer)
  }, [shareSlug, blogUsername])

  const isBlogRoot = /^\/blog\/?$/.test(location.pathname)

  if (blogUsername) {
    return (
      <>
        <ErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            <BlogApp username={blogUsername} />
          </Suspense>
        </ErrorBoundary>
        <Toaster />
      </>
    )
  }

  if (isBlogRoot) {
    return (
      <>
        <PageFallback />
        <Toaster />
      </>
    )
  }

  if (shareSlug) {
    return (
      <>
        <ErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            <SharePage slug={shareSlug} />
          </Suspense>
        </ErrorBoundary>
        <Toaster />
      </>
    )
  }

  return (
    <>
      <ErrorBoundary>
        {status === 'loading' && <div className="h-full" />}
        {status === 'anonymous' && <LoginPage />}
        {status === 'authed' && (
          <Suspense fallback={<PageFallback />}>
            <AppShell />
          </Suspense>
        )}
      </ErrorBoundary>
      <Toaster />
      <ConfirmHost />
    </>
  )
}

function PageFallback() {
  return (
    <div
      role="status"
      aria-label={t("common.loading")}
      className="flex h-full items-center justify-center bg-[var(--bg-base)] text-[var(--text-tertiary)]"
    >
      <Spinner size={18} />
    </div>
  )
}
