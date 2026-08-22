import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Plug } from 'lucide-react'
import { Input, Segmented, Select, SettingRow, Switch, Textarea } from '../../components/form'
import { Badge, Button } from '../../components/primitives'
import { CLOUDFLARE_AI_MODELS } from '@shared/ai-models'
import { DEFAULT_AI_CONFIG, getAiConfig, setAiConfig, type AiConfig, type AiProvider } from '../../lib/ai/config'
import { classifyAiError, listModels } from '../../lib/ai/ollama'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'

const PROBE_TIMEOUT_MS = 12000

type Probe =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'ok'; models: string[] }
  | { state: 'failed'; message: string }

function describeFailure(error: unknown): string {
  const classified = classifyAiError(error)
  if (classified.kind === 'unsupported-browser') return t('settings.ai_error_browser')
  if (classified.kind === 'http') {
    if (classified.status === 429) return t('settings.ai_error_quota')
    return t('settings.ai_error_http', { status: classified.status ?? 0, detail: classified.detail })
  }
  if (classified.kind === 'unreachable') return t('settings.ai_error_unreachable')
  return t('settings.ai_error_unknown', { detail: classified.detail })
}

function numericField(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function AiSettings() {
  const toast = useUi((state) => state.toast)
  const [config, setConfig] = useState<AiConfig>(() => getAiConfig())
  const [probe, setProbe] = useState<Probe>({ state: 'idle' })
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const update = (patch: Partial<AiConfig>) => {
    setConfig(setAiConfig(patch))
  }

  const testConnection = async () => {
    setProbe({ state: 'testing' })
    const controller = new AbortController()
    let timedOut = false
    const timer = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, PROBE_TIMEOUT_MS)
    try {
      const models = await listModels(config.baseUrl, controller.signal)
      if (!mountedRef.current) return
      setProbe({ state: 'ok', models })
      toast({ title: t('settings.ai_connected', { count: models.length }), tone: 'success' })
    } catch (error) {
      if (!mountedRef.current) return
      const message = timedOut ? t('settings.ai_error_timeout') : describeFailure(error)
      setProbe({ state: 'failed', message })
      toast({ title: t('settings.ai_connection_failed'), description: message, tone: 'danger' })
    } finally {
      window.clearTimeout(timer)
    }
  }

  const isCloud = config.provider === 'cloudflare'
  const knownModels = probe.state === 'ok' ? probe.models : []
  const resolvedModel = knownModels.includes(config.model)
    ? config.model
    : (knownModels.find((model) => model === `${config.model}:latest`) ?? config.model)
  const modelChoices = knownModels.includes(resolvedModel) ? knownModels : [resolvedModel, ...knownModels].filter(Boolean)

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <div className="text-[13px] font-medium text-[var(--text-primary)]">{t('settings.ai_provider')}</div>
        <Segmented<AiProvider>
          value={config.provider}
          label={t('settings.ai_provider')}
          options={[
            { value: 'ollama', label: t('settings.ai_provider_ollama') },
            { value: 'cloudflare', label: t('settings.ai_provider_cloudflare') },
          ]}
          onChange={(provider) => update({ provider })}
        />
      </div>

      {isCloud ? (
        <div className="rounded-[var(--r-lg)] border border-[var(--warning)] bg-[var(--bg-sunken)] p-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
          <p className="font-medium text-[var(--text-primary)]">{t('settings.ai_cloud_privacy')}</p>
          <p className="mt-1.5">{t('settings.ai_cloud_quota')}</p>
        </div>
      ) : (
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
          <p>{t('settings.ai_intro')}</p>
          <p className="mt-1.5">{t('settings.ai_browser_notice')}</p>
        </div>
      )}

      <div>
        {isCloud ? (
          <SettingRow title={t('settings.ai_model')} description={t('settings.ai_cloud_model_hint')}>
            <Select
              value={config.cloudflareModel}
              className="w-full md:w-[280px]"
              onChange={(event) => update({ cloudflareModel: event.target.value })}
            >
              {CLOUDFLARE_AI_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </Select>
          </SettingRow>
        ) : null}

        {isCloud ? null : (
        <SettingRow title={t('settings.ai_base_url')} description={t('settings.ai_base_url_hint')}>
          <Input
            value={config.baseUrl}
            spellCheck={false}
            className="w-full md:w-[280px]"
            onChange={(event) => update({ baseUrl: event.target.value })}
          />
        </SettingRow>

        )}

        {isCloud ? null : (
        <SettingRow title={t('settings.ai_model')} description={t('settings.ai_model_hint')}>
          {knownModels.length > 0 ? (
            <Select
              value={resolvedModel}
              className="w-full md:w-[280px]"
              onChange={(event) => update({ model: event.target.value })}
            >
              {modelChoices.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              value={config.model}
              spellCheck={false}
              className="w-full md:w-[280px]"
              onChange={(event) => update({ model: event.target.value })}
            />
          )}
        </SettingRow>
        )}

        <SettingRow title={t('settings.ai_chunk_chars')} description={t('settings.ai_chunk_chars_hint')}>
          <Input
            type="number"
            min={0}
            value={String(config.chunkChars)}
            className="w-full md:w-[140px]"
            onChange={(event) => update({ chunkChars: numericField(event.target.value, DEFAULT_AI_CONFIG.chunkChars) })}
          />
        </SettingRow>

        <SettingRow title={t('settings.ai_max_tokens')} description={t('settings.ai_max_tokens_hint')}>
          <Input
            type="number"
            min={0}
            value={String(config.maxTokens)}
            className="w-full md:w-[140px]"
            onChange={(event) => update({ maxTokens: numericField(event.target.value, DEFAULT_AI_CONFIG.maxTokens) })}
          />
        </SettingRow>

        <SettingRow title={t('settings.ai_strict_convert')} description={t('settings.ai_strict_convert_hint')}>
          <Switch checked={config.strictConvert} onChange={(strictConvert) => update({ strictConvert })} />
        </SettingRow>
      </div>

      <div className="space-y-1.5">
        <div className="text-[13px] font-medium text-[var(--text-primary)]">{t('settings.ai_extra_instruction')}</div>
        <div className="text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
          {t('settings.ai_extra_instruction_hint')}
        </div>
        <Textarea
          rows={3}
          value={config.extraInstruction}
          onChange={(event) => update({ extraInstruction: event.target.value })}
        />
      </div>

      {isCloud ? null : (
      <div className="space-y-2">
        <Button
          type="button"
          icon={<Plug size={13} />}
          loading={probe.state === 'testing'}
          onClick={() => void testConnection()}
        >
          {probe.state === 'testing' ? t('settings.ai_testing') : t('settings.ai_test_connection')}
        </Button>

        {probe.state === 'ok' && (
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-secondary)]">
            <Badge tone="success">
              <CheckCircle2 size={12} className="mr-1 inline-block align-[-2px]" />
              {t('settings.ai_connected', { count: probe.models.length })}
            </Badge>
            {probe.models.length === 0 && <span>{t('settings.ai_no_models')}</span>}
          </div>
        )}

        {probe.state === 'failed' && (
          <div className="flex items-start gap-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--warning)]" />
            <span>{probe.message}</span>
          </div>
        )}
      </div>
      )}
    </div>
  )
}
