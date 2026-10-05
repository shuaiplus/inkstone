import { useEffect, useRef, useState } from 'react'
import { Folder, KeyRound, RefreshCw, Rss, Tag, Trash2 } from 'lucide-react'
import { LIMITS } from '@shared/constants'
import { BLOG_PRIVATE_TAG, BLOG_PUBLIC_TAG, MOMENT_PRIVATE_TAG, MOMENT_PUBLIC_TAG } from '@shared/blog/tags'
import { blogApi } from '../../blog/api'
import { Button } from '../../components/primitives'
import { Input } from '../../components/form'
import { confirm } from '../../components/overlay'
import { SettingsLoading as LoadingBlock } from './SettingsLoading'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'

type BusyAction = 'title' | 'description' | 'publicTag' | 'privateTag' | 'momentsPublicTag' | 'momentsPrivateTag' | 'setPassword' | 'clearPassword' | null

export function BlogSettings() {
  const username = useSession((s) => s.user?.username)
  const toast = useUi((s) => s.toast)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [hasCustomPassword, setHasCustomPassword] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [publicTag, setPublicTag] = useState(BLOG_PUBLIC_TAG)
  const [privateTag, setPrivateTag] = useState(BLOG_PRIVATE_TAG)
  const [momentsPublicTag, setMomentsPublicTag] = useState(MOMENT_PUBLIC_TAG)
  const [momentsPrivateTag, setMomentsPrivateTag] = useState(MOMENT_PRIVATE_TAG)
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
        setDescription(settings.description ?? '')
        setHasCustomPassword(settings.hasCustomPassword)
        setPublicTag(settings.publicTag || BLOG_PUBLIC_TAG)
        setPrivateTag(settings.privateTag || BLOG_PRIVATE_TAG)
        setMomentsPublicTag(settings.momentsPublicTag || MOMENT_PUBLIC_TAG)
        setMomentsPrivateTag(settings.momentsPrivateTag || MOMENT_PRIVATE_TAG)
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

  const saveDescription = async () => {
    if (!begin('description')) return
    const next = description.trim()
    try {
      await blogApi.updateSettings({ description: next })
      if (mountedRef.current) setDescription(next)
      toast({ title: t('settings.blog_description_saved'), tone: 'success' })
    } catch (error) {
      fail(error)
    } finally {
      finish()
    }
  }

  const savePublicTag = async () => {
    if (!begin('publicTag')) return
    const next = publicTag.trim()
    try {
      await blogApi.updateSettings({ publicTag: next })
      if (mountedRef.current) setPublicTag(next)
      toast({ title: t('settings.blog_tag_saved'), tone: 'success' })
    } catch (error) {
      fail(error)
    } finally {
      finish()
    }
  }

  const savePrivateTag = async () => {
    if (!begin('privateTag')) return
    const next = privateTag.trim()
    try {
      await blogApi.updateSettings({ privateTag: next })
      if (mountedRef.current) setPrivateTag(next)
      toast({ title: t('settings.blog_tag_saved'), tone: 'success' })
    } catch (error) {
      fail(error)
    } finally {
      finish()
    }
  }

  const saveMomentsPublicTag = async () => {
    if (!begin('momentsPublicTag')) return
    const next = momentsPublicTag.trim()
    try {
      await blogApi.updateSettings({ momentsPublicTag: next })
      if (mountedRef.current) setMomentsPublicTag(next)
      toast({ title: t('settings.blog_tag_saved'), tone: 'success' })
    } catch (error) {
      fail(error)
    } finally {
      finish()
    }
  }

  const saveMomentsPrivateTag = async () => {
    if (!begin('momentsPrivateTag')) return
    const next = momentsPrivateTag.trim()
    try {
      await blogApi.updateSettings({ momentsPrivateTag: next })
      if (mountedRef.current) setMomentsPrivateTag(next)
      toast({ title: t('settings.blog_tag_saved'), tone: 'success' })
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
        setHasCustomPassword(true)
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
      if (mountedRef.current) setHasCustomPassword(false)
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
    <div className="space-y-4">
      <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
        <div className="flex items-center gap-3">
          <span className="rounded-[var(--r-md)] bg-[var(--accent-soft)] p-2 text-[var(--accent)]">
            <Rss size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">{t('settings.blog')}</h3>
            {blogUrl && (
              <a href={blogUrl} className="text-[11.5px] text-[var(--accent)] hover:underline" target="_blank" rel="noreferrer">
                {blogUrl}
              </a>
            )}
          </div>
        </div>
      </section>

      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4 space-y-4">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-[var(--text-tertiary)]">{t('settings.blog_title')}</label>
          <div className="flex gap-2">
            <Input
              value={title}
              maxLength={120}
              placeholder={t('settings.blog_title_placeholder')}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveTitle() }}
            />
            <Button size="sm" variant="secondary" loading={busy === 'title'} disabled={busy !== null} onClick={() => void saveTitle()}>
              {t('common.save')}
            </Button>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-[var(--text-tertiary)]">{t('settings.blog_description')}</label>
          <div className="flex items-start gap-2">
            <textarea
              value={description}
              maxLength={300}
              rows={2}
              placeholder={t('settings.blog_description_placeholder')}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void saveDescription() }}
              className="w-full flex-1 resize-y rounded-[var(--r-sm)] border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 py-2 text-[13px] leading-relaxed text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
            />
            <Button size="sm" variant="secondary" loading={busy === 'description'} disabled={busy !== null} onClick={() => void saveDescription()}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4 space-y-4">
        <div className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
          <Tag size={13} />
          <span>{t('settings.blog_tags_hint')}</span>
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-[var(--text-tertiary)]">{t('settings.blog_public_tag')}</label>
          <div className="flex gap-2">
            <Input
              value={publicTag}
              maxLength={64}
              placeholder={BLOG_PUBLIC_TAG}
              onChange={(e) => setPublicTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void savePublicTag() }}
            />
            <Button size="sm" variant="secondary" loading={busy === 'publicTag'} disabled={busy !== null} onClick={() => void savePublicTag()}>
              {t('common.save')}
            </Button>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-[var(--text-tertiary)]">{t('settings.blog_private_tag')}</label>
          <div className="flex gap-2">
            <Input
              value={privateTag}
              maxLength={64}
              placeholder={BLOG_PRIVATE_TAG}
              onChange={(e) => setPrivateTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void savePrivateTag() }}
            />
            <Button size="sm" variant="secondary" loading={busy === 'privateTag'} disabled={busy !== null} onClick={() => void savePrivateTag()}>
              {t('common.save')}
            </Button>
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-tertiary)]">
            <Folder size={12} />
            <label>{t('settings.blog_moments_public_tag')}</label>
          </div>
          <div className="flex gap-2">
            <Input
              value={momentsPublicTag}
              maxLength={64}
              placeholder={MOMENT_PUBLIC_TAG}
              onChange={(e) => setMomentsPublicTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveMomentsPublicTag() }}
            />
            <Button size="sm" variant="secondary" loading={busy === 'momentsPublicTag'} disabled={busy !== null} onClick={() => void saveMomentsPublicTag()}>
              {t('common.save')}
            </Button>
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-tertiary)]">
            <Folder size={12} />
            <label>{t('settings.blog_moments_private_tag')}</label>
          </div>
          <div className="flex gap-2">
            <Input
              value={momentsPrivateTag}
              maxLength={64}
              placeholder={MOMENT_PRIVATE_TAG}
              onChange={(e) => setMomentsPrivateTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveMomentsPrivateTag() }}
            />
            <Button size="sm" variant="secondary" loading={busy === 'momentsPrivateTag'} disabled={busy !== null} onClick={() => void saveMomentsPrivateTag()}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
        <label className="mb-1 block text-[11px] font-medium text-[var(--text-tertiary)]">{t('settings.blog_password')}</label>
        <Input
          type="password"
          value={password}
          maxLength={LIMITS.passwordMaxLength}
          autoComplete="new-password"
          placeholder={t('settings.blog_password_placeholder')}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void setBlogPassword() }}
        />
        {!password && !hasCustomPassword && (
          <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--text-quaternary)]">
            {t('settings.blog_password_account_hint')}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {hasCustomPassword && (
            <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} className="text-[var(--danger)]" loading={busy === 'clearPassword'} disabled={busy !== null} onClick={() => void clearBlogPassword()}>
              {t('settings.blog_clear_password')}
            </Button>
          )}
          <Button size="sm" variant="secondary" icon={<KeyRound size={13} />} loading={busy === 'setPassword'} disabled={busy !== null} onClick={() => void setBlogPassword()}>
            {t('settings.blog_set_password')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
