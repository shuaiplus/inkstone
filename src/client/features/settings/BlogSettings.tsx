import { useEffect, useRef, useState } from 'react'
import { KeyRound, RefreshCw, Rss, Trash2, Type } from 'lucide-react'
import { LIMITS } from '@shared/constants'
import { blogApi } from '../../blog/api'
import { Button } from '../../components/primitives'
import { Field, Input } from '../../components/form'
import { confirm } from '../../components/overlay'
import { SettingsLoading as LoadingBlock } from './SettingsLoading'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'

type BusyAction = 'title' | 'setPassword' | 'clearPassword' | null

export function BlogSettings() {
  const username = useSession((s) => s.user?.username)
  const toast = useUi((s) => s.toast)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [hasPassword, setHasPassword] = useState(false)
  const [title, setTitle] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<BusyAction>(null)
  const mountedRef = useRef(true)
  const busyRef = useRef<BusyAction>(null)

  const load = async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const settings = await blogApi.settings()
      if (mountedRef.current) {
        setTitle(settings.title ?? '')
        setHasPassword(settings.hasPassword)
      }
    } catch (error) {
      if (mountedRef.current) setLoadError(errorMessage(error))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    mountedRef.current = true
    void load()
    return () => {
      mountedRef.current = false
    }
  }, [])

  const begin = (action: Exclude<BusyAction, null>): boolean => {
    if (busyRef.current) return false
    busyRef.current = action
    setBusy(action)
    return true
  }

  const finish = () => {
    busyRef.current = null
    if (mountedRef.current) setBusy(null)
  }

  const fail = (error: unknown) => {
    toast({
      title: t('common.action_failed'),
      description: errorMessage(error),
      tone: 'danger',
    })
  }

  const saveTitle = async () => {
    if (!begin('title')) return
    const next = title.trim()
    try {
      await blogApi.updateSettings({ title: next })
      if (mountedRef.current) setTitle(next)
      toast({ title: t('settings.blog_title_saved'), tone: 'success' })
    } catch (error) {
      fail(error)
    } finally {
      finish()
    }
  }

  const setBlogPassword = async () => {
    if (!password) {
      toast({ title: t('settings.blog_password_required'), tone: 'danger' })
      return
    }
    if (!begin('setPassword')) return
    const value = password
    try {
      await blogApi.updateSettings({ password: value })
      if (mountedRef.current) {
        setHasPassword(true)
        setPassword('')
      }
      toast({ title: t('settings.blog_password_updated'), tone: 'success' })
    } catch (error) {
      fail(error)
    } finally {
      finish()
    }
  }

  const clearBlogPassword = async () => {
    const approved = await confirm({
      title: t('settings.blog_password_clear_title'),
      description: t('settings.blog_password_clear_desc'),
      confirmLabel: t('settings.blog_clear_password'),
      tone: 'danger',
    })
    if (!approved || !begin('clearPassword')) return
    try {
      await blogApi.updateSettings({ password: null })
      if (mountedRef.current) setHasPassword(false)
      toast({ title: t('settings.blog_password_cleared'), tone: 'success' })
    } catch (error) {
      fail(error)
    } finally {
      finish()
    }
  }

  const blogUrl = username ? `/blog/${encodeURIComponent(username)}` : null

  if (loading) return <LoadingBlock label={t('settings.blog_loading')} />
  if (loadError) {
    return (
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
        <p className="text-[12.5px] text-[var(--danger)]">{loadError}</p>
        <Button className="mt-3" size="sm" icon={<RefreshCw size={12} />} onClick={() => void load()}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
        <div className="flex items-start gap-3 p-4">
          <span className="mt-0.5 rounded-[var(--r-md)] bg-[var(--accent-soft)] p-2 text-[var(--accent)]">
            <Rss size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[13.5px] font-semibold text-[var(--text-primary)]">{t('settings.blog')}</h3>
            <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
              {t('settings.blog_intro')}
            </p>
          </div>
        </div>
        {blogUrl && (
          <div className="border-t border-[var(--border-subtle)] px-4 py-3">
            <div className="mb-1 text-[11px] font-medium text-[var(--text-tertiary)]">{t('settings.blog_url')}</div>
            <code className="block min-w-0 overflow-x-auto rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2.5 py-2 text-[11.5px] text-[var(--text-secondary)]">
              {blogUrl}
            </code>
            <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--text-quaternary)]">
              {t('settings.blog_url_desc')}
            </p>
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-1 px-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
          {t('settings.blog_title')}
        </h3>
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
          <Field label={t('settings.blog_title')} hint={t('settings.blog_title_desc')}>
            <Input
              value={title}
              maxLength={120}
              placeholder={t('settings.blog_title_placeholder')}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveTitle() }}
            />
          </Field>
          <div className="mt-3 flex justify-end">
            <Button size="sm" variant="secondary" icon={<Type size={13} />} loading={busy === 'title'} disabled={busy !== null} onClick={() => void saveTitle()}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-1 px-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
          {t('settings.blog_password')}
        </h3>
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
          <Field label={t('settings.blog_password')} hint={t('settings.blog_password_desc')}>
            <Input
              type="password"
              value={password}
              maxLength={LIMITS.passwordMaxLength}
              autoComplete="new-password"
              placeholder={t('settings.blog_password_placeholder')}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void setBlogPassword() }}
            />
          </Field>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            {hasPassword && (
              <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} className="text-[var(--danger)]" loading={busy === 'clearPassword'} disabled={busy !== null} onClick={() => void clearBlogPassword()}>
                {t('settings.blog_clear_password')}
              </Button>
            )}
            <Button size="sm" variant="secondary" icon={<KeyRound size={13} />} loading={busy === 'setPassword'} disabled={busy !== null} onClick={() => void setBlogPassword()}>
              {t('settings.blog_set_password')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
