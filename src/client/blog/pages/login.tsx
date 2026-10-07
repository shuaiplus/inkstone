import { useEffect, useState, type FormEvent } from 'react'
import { blogApi } from '../api'
import { t } from '../../lib/i18n'

type AuthState = 'checking' | 'anonymous' | 'authed'

export default function LoginPage({ username }: {
  username: string
}) {
  const [authState, setAuthState] = useState<AuthState>('checking')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    blogApi.session(username)
      .then(({ authed }) => {
        if (cancelled) return
        setAuthState(authed ? 'authed' : 'anonymous')
      })
      .catch(() => {
        if (cancelled) return
        setAuthState('anonymous')
      })
    return () => {
      cancelled = true
    }
  }, [username])

  const base = `/blog/${encodeURIComponent(username)}`

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy)
      return
    setBusy(true)
    setError(null)
    try {
      const ok = await blogApi.auth(username, password)
      if (ok) {
        window.location.reload()
        return
      }
      setError(t('blog.incorrect_password'))
    }
    catch {
      setError(t('blog.something_went_wrong'))
    }
    finally {
      setBusy(false)
    }
  }

  const onLogout = async () => {
    if (busy)
      return
    setBusy(true)
    setError(null)
    try {
      await blogApi.logout(username)
      window.location.href = base
    }
    catch {
      setError(t('blog.something_went_wrong'))
      setBusy(false)
    }
  }

  if (authState === 'checking') {
    return (
      <div className="blog-login">
        <p className="blog-page-muted">{t('blog.loading')}</p>
      </div>
    )
  }

  if (authState === 'authed') {
    return (
      <div className="blog-login">
        <h1>{t('blog.already_unlocked')}</h1>
        <p>{t('blog.already_unlocked_desc')}</p>
        {error && <p className="blog-login-error" role="alert">{error}</p>}
        <div className="blog-login-actions">
          <a className="blog-login-ghost" href={base}>
            {t('blog.articles')}
          </a>
          <a className="blog-login-ghost" href={`${base}/moments`}>
            {t('blog.moments')}
          </a>
        </div>
        <button type="button" className="blog-login-ghost" disabled={busy} onClick={onLogout}>
          {busy ? t('blog.logging_out') : t('blog.logout')}
        </button>
      </div>
    )
  }

  return (
    <div className="blog-login">
      <h1>{t('blog.protected_blog')}</h1>
      <p>{t('blog.password_prompt')}</p>
      <form className="blog-login-form" onSubmit={onSubmit}>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={t('blog.password')}
          autoComplete="current-password"
          autoFocus
          aria-label={t('blog.password')}
        />
        {error && <p className="blog-login-error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? t('blog.unlocking') : t('blog.unlock')}
        </button>
      </form>
    </div>
  )
}
