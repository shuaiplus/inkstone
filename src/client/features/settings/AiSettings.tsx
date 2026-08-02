import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, KeyRound, Loader2, Radio, Save, Sparkles, XCircle } from 'lucide-react'
import { api, ApiError } from '../../lib/api'
import { Button } from '../../components/primitives'
import { Input, SettingRow } from '../../components/form'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { t } from '../../lib/i18n'
import type { AiConfig, TestConnectionResult } from '@shared/types'

export function AiSettings() {
  const toast = useUi((s) => s.toast)
  const user = useSession((s) => s.user)
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [imageModel, setImageModel] = useState('')
  const [imageMethod, setImageMethod] = useState<'generations' | 'responses'>('generations')
  const [apiKey, setApiKey] = useState('')
  const [keyDirty, setKeyDirty] = useState(false)
  const mountedRef = useRef(true)
  const testControllerRef = useRef<AbortController | null>(null)

  const isOwner = user?.role === 'owner'
  const canTest = Boolean(apiKey.trim() || (config?.hasKey && !keyDirty))
  const hasChanges = keyDirty
    || baseUrl.trim() !== (config?.baseUrl ?? '')
    || model.trim() !== (config?.model ?? '')
    || imageModel.trim() !== (config?.imageModel ?? '')
    || imageMethod !== (config?.imageMethod ?? 'generations')

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      testControllerRef.current?.abort()
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
        setImageModel(cfg.imageModel)
        setImageMethod(cfg.imageMethod)
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
      const patch: { baseUrl?: string; model?: string; imageModel?: string; imageMethod?: 'generations' | 'responses'; apiKey?: string | null } = {}
      if (baseUrl !== (config?.baseUrl ?? '')) patch.baseUrl = baseUrl.trim()
      if (model !== (config?.model ?? '')) patch.model = model.trim()
      if (imageModel !== (config?.imageModel ?? '')) patch.imageModel = imageModel.trim()
      if (imageMethod !== (config?.imageMethod ?? 'generations')) patch.imageMethod = imageMethod
      if (keyDirty) {
        patch.apiKey = apiKey.trim() === '' ? null : apiKey
      }
      const updated = await api.ai.saveConfig(patch)
      if (!mountedRef.current) return
      setConfig(updated)
      setBaseUrl(updated.baseUrl)
      setModel(updated.model)
      setImageModel(updated.imageModel)
      setImageMethod(updated.imageMethod)
      setApiKey('')
      setKeyDirty(false)
      setTestResult(null)
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

  const testConnection = async () => {
    if (testing || !canTest) return
    const controller = new AbortController()
    testControllerRef.current = controller
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api.ai.testConfig({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
      }, controller.signal)
      if (mountedRef.current && !controller.signal.aborted) setTestResult(result)
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      if (mountedRef.current) {
        setTestResult({
          ok: false,
          message: t('ai.connection_failed'),
          detail: err instanceof ApiError ? err.message : String(err),
        })
      }
    } finally {
      if (testControllerRef.current === controller) testControllerRef.current = null
      if (mountedRef.current) setTesting(false)
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
              {testResult?.ok
                ? t('ai.status_verified', { latency: testResult.latencyMs ?? 0 })
                : hasKey
                  ? t('ai.status_ready')
                  : t('ai.status_not_configured')}
            </div>
          </div>
        </div>

        {testResult && (
          <div
            role="status"
            className={
              'mt-3 flex items-start gap-2 rounded-[var(--r-md)] border px-3 py-2.5 ' +
              (testResult.ok
                ? 'border-[color-mix(in_oklab,var(--success)_28%,transparent)] bg-[color-mix(in_oklab,var(--success)_8%,transparent)]'
                : 'border-[color-mix(in_oklab,var(--danger)_28%,transparent)] bg-[color-mix(in_oklab,var(--danger)_8%,transparent)]')
            }
          >
            {testResult.ok
              ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[var(--success)]" />
              : <XCircle size={14} className="mt-0.5 shrink-0 text-[var(--danger)]" />}
            <div className="min-w-0">
              <div className="text-[11.5px] font-medium text-[var(--text-primary)]">
                {testResult.ok ? t('ai.connection_succeeded') : testResult.message}
              </div>
              {testResult.detail && (
                <div className="mt-0.5 break-words text-[10.5px] leading-relaxed text-[var(--text-tertiary)]">
                  {testResult.ok
                    ? t('ai.connection_detail', {
                        model: testResult.detail,
                        latency: testResult.latencyMs ?? 0,
                      })
                    : testResult.detail}
                </div>
              )}
            </div>
          </div>
        )}

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
                  setTestResult(null)
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
                onChange={(e) => {
                  setBaseUrl(e.target.value)
                  setTestResult(null)
                }}
                placeholder="https://api.openai.com/v1"
              />
            </div>
          </SettingRow>

          <SettingRow title={t('ai.model')} description={t('ai.model_description')}>
            <div className="w-full md:w-[280px]">
              <Input
                value={model}
                onChange={(e) => {
                  setModel(e.target.value)
                  setTestResult(null)
                }}
                placeholder="gpt-4o-mini"
              />
            </div>
          </SettingRow>

          <SettingRow title={t('ai.image_model')} description={t('ai.image_model_description')}>
            <div className="w-full md:w-[280px]">
              <Input
                value={imageModel}
                onChange={(e) => setImageModel(e.target.value)}
                placeholder="dall-e-3"
                disabled={imageMethod === 'responses'}
              />
            </div>
          </SettingRow>

          <SettingRow title={t('ai.image_method')} description={t('ai.image_method_description')}>
            <div className="w-full md:w-[280px]">
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setImageMethod('generations')}
                  className={
                    'flex-1 rounded-[var(--r-md)] border px-2.5 py-2 text-[12px] font-medium transition-colors ' +
                    (imageMethod === 'generations'
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]'
                      : 'border-[var(--border-default)] text-[var(--text-tertiary)] hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)]')
                  }
                >
                  {t('ai.image_method_generations')}
                </button>
                <button
                  type="button"
                  onClick={() => setImageMethod('responses')}
                  className={
                    'flex-1 rounded-[var(--r-md)] border px-2.5 py-2 text-[12px] font-medium transition-colors ' +
                    (imageMethod === 'responses'
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]'
                      : 'border-[var(--border-default)] text-[var(--text-tertiary)] hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)]')
                  }
                >
                  {t('ai.image_method_responses')}
                </button>
              </div>
            </div>
          </SettingRow>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={testConnection}
            loading={testing}
            disabled={saving || !canTest}
            icon={<Radio size={13} />}
          >
            {testing ? t('ai.testing_connection') : t('ai.test_connection')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            loading={saving}
            disabled={testing || !hasChanges}
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
