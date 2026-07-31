import { useEffect, useRef, useState } from 'react'
import { KeyRound, Loader2, Save, Sparkles } from 'lucide-react'
import { api, ApiError } from '../../lib/api'
import { Button } from '../../components/primitives'
import { Input, SettingRow } from '../../components/form'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { t } from '../../lib/i18n'
import type { AiConfig } from '@shared/types'

export function AiSettings() {
  const toast = useUi((s) => s.toast)
  const user = useSession((s) => s.user)
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [keyDirty, setKeyDirty] = useState(false)
  const mountedRef = useRef(true)

  const isOwner = user?.role === 'owner'

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!isOwner) {
      setLoading(false)
      return
    }
    api.ai
      .getConfig()
      .then((cfg) => {
        if (!mountedRef.current) return
        setConfig(cfg)
        setBaseUrl(cfg.baseUrl)
        setModel(cfg.model)
      })
      .catch((err) => {
        if (!mountedRef.current) return
        toast({
          title: t('ai.config_load_failed'),
          description: err instanceof ApiError ? err.message : String(err),
          tone: 'danger',
        })
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false)
      })
  }, [isOwner, toast])

  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      const patch: { baseUrl?: string; model?: string; apiKey?: string | null } = {}
      if (baseUrl !== (config?.baseUrl ?? '')) patch.baseUrl = baseUrl.trim()
      if (model !== (config?.model ?? '')) patch.model = model.trim()
      if (keyDirty) {
        patch.apiKey = apiKey.trim() === '' ? null : apiKey
      }
      const updated = await api.ai.saveConfig(patch)
      if (!mountedRef.current) return
      setConfig(updated)
      setBaseUrl(updated.baseUrl)
      setModel(updated.model)
      setApiKey('')
      setKeyDirty(false)
      toast({ title: t('ai.config_saved'), tone: 'success' })
    } catch (err) {
      toast({
        title: t('ai.config_save_failed'),
        description: err instanceof ApiError ? err.message : String(err),
        tone: 'danger',
      })
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  if (!isOwner) {
    return (
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4 text-[12.5px] text-[var(--text-tertiary)]">
        {t('ai.owner_only')}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-[12.5px] text-[var(--text-tertiary)]">
        <Loader2 size={14} className="animate-spin" />
        {t('ai.loading_config')}
      </div>
    )
  }

  const hasKey = Boolean(config?.hasKey)

  return (
    <div className="space-y-6">
      <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
        <div className="mb-2 flex items-center gap-2.5">
          <span className="text-[var(--accent)]">
            <Sparkles size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-[var(--text-primary)]">{t('ai.status')}</div>
            <div className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
              {hasKey ? t('ai.status_ready') : t('ai.status_not_configured')}
            </div>
          </div>
        </div>

        <div className="mt-3">
          <SettingRow
            title={t('ai.api_key')}
            description={hasKey ? t('ai.api_key_set_description') : t('ai.api_key_description')}
          >
            <div className="w-full md:w-[280px]">
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  setKeyDirty(true)
                }}
                placeholder={hasKey ? '••••••••••••' : t('ai.api_key_placeholder')}
                leading={<KeyRound size={13} />}
                autoComplete="off"
              />
            </div>
          </SettingRow>

          <SettingRow title={t('ai.base_url')} description={t('ai.base_url_description')}>
            <div className="w-full md:w-[280px]">
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </div>
          </SettingRow>

          <SettingRow title={t('ai.model')} description={t('ai.model_description')}>
            <div className="w-full md:w-[280px]">
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-4o-mini"
              />
            </div>
          </SettingRow>
        </div>

        <div className="mt-3 flex justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            loading={saving}
            icon={<Save size={13} />}
          >
            {t('common.save')}
          </Button>
        </div>
      </section>

      <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
        <div className="text-[13px] font-medium text-[var(--text-primary)]">{t('ai.usage_title')}</div>
        <ul className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
          <li>{t('ai.usage_polish')}</li>
          <li>{t('ai.usage_summarize')}</li>
          <li>{t('ai.usage_draft')}</li>
        </ul>
      </section>
    </div>
  )
}