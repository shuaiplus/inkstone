import { useState, type FormEvent } from 'react'
import { blogApi } from '../api'
import { t } from '../../lib/i18n'

export default function LoginPage({ username }: {
  username: string
}) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
      setError('Incorrect password. Please try again.')
    }
    catch {
      setError('Something went wrong. Please try again.')
    }
    finally {
      setBusy(false)
    }
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
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}
