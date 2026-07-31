import { useEffect, useId, useRef, useState } from 'react'
import { Sparkles, ImagePlus, X, Loader2, Check } from 'lucide-react'
import { Modal } from '../../components/overlay'
import { Button } from '../../components/primitives'
import { Textarea } from '../../components/form'
import { api, ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import type { AiImageResponse } from '@shared/types'

export interface AiImageDialogProps {
  open: boolean
  onClose: () => void
  onInsert: (url: string, alt: string) => void
}

type ImageSize = '1024x1024' | '1792x1024' | '1024x1792'

interface SizeOption {
  value: ImageSize
  label: string
  hint: string
  icon: string
}

export function AiImageDialog({ open, onClose, onInsert }: AiImageDialogProps) {
  const toast = useUi((s) => s.toast)
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState<ImageSize>('1024x1024')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<AiImageResponse | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const hintId = useId()

  useEffect(() => {
    if (!open) return
    setPrompt('')
    setResult(null)
    setLoading(false)
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  const sizeOptions: SizeOption[] = [
    { value: '1024x1024', label: t('ai.image_size_square'), hint: '1:1', icon: '□' },
    { value: '1792x1024', label: t('ai.image_size_landscape'), hint: '16:9', icon: '▭' },
    { value: '1024x1792', label: t('ai.image_size_portrait'), hint: '9:16', icon: '▯' },
  ]

  const handleGenerate = async () => {
    const trimmed = prompt.trim()
    if (!trimmed || loading) return
    setLoading(true)
    setResult(null)
    try {
      const res = await api.ai.image({ prompt: trimmed, size })
      setResult(res)
    } catch (err) {
      let message: string
      if (err instanceof ApiError) {
        // Show raw code + original message to avoid translation masking the real cause
        message = `[${err.code}] ${err.message}`
      } else {
        message = String(err)
      }
      toast({ title: t('ai.image_failed'), description: message, tone: 'danger' })
    } finally {
      setLoading(false)
    }
  }

  const handleInsert = () => {
    if (!result) return
    onInsert(result.url, prompt.trim().slice(0, 60))
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !loading) {
      e.preventDefault()
      handleGenerate()
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-2">
          <span className="ai-brand-text">
            <ImagePlus size={15} />
          </span>
          <span className="ai-brand-text">{t('ai.image_title')}</span>
        </span>
      }
      description={t('ai.image_description')}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
          {result && (
            <Button variant="primary" onClick={handleInsert} icon={<Check size={13} />}>
              {t('ai.image_insert')}
            </Button>
          )}
          {!result && (
            <Button
              variant="primary"
              onClick={handleGenerate}
              loading={loading}
              disabled={!prompt.trim()}
              icon={<Sparkles size={13} />}
            >
              {loading ? t('ai.image_generating') : t('ai.image_generate')}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {/* Prompt input */}
        <div className="space-y-2">
          <Textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('ai.image_prompt_placeholder')}
            rows={3}
            aria-describedby={hintId}
            disabled={loading || !!result}
            className="min-h-[80px]"
          />
          <p id={hintId} className="text-[11px] text-[var(--text-quaternary)]">
            {t('ai.shortcut_submit')}
          </p>
        </div>

        {/* Size selector */}
        {!result && (
          <div className="space-y-2">
            <label className="text-[12px] font-medium text-[var(--text-secondary)]">
              {t('ai.image_size')}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {sizeOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setSize(opt.value)}
                  disabled={loading}
                  className={
                    'flex flex-col items-center gap-1 rounded-[var(--r-md)] border px-2 py-3 transition-colors ' +
                    (size === opt.value
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]'
                      : 'border-[var(--border-default)] text-[var(--text-tertiary)] hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)]')
                  }
                >
                  <span className="text-[18px] leading-none">{opt.icon}</span>
                  <span className="text-[10.5px] font-medium leading-tight">{opt.label}</span>
                  <span className="text-[9.5px] text-[var(--text-quaternary)]">{opt.hint}</span>
                </button>
              ))}
            </div>
            <p className="text-[10.5px] text-[var(--text-quaternary)]">{t('ai.image_size_hint')}</p>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="ai-shimmer-bg flex items-center justify-center rounded-[var(--r-md)] py-12">
            <div className="flex flex-col items-center gap-2">
              <Loader2 size={24} className="animate-spin text-[var(--accent)]" />
              <span className="text-[12px] text-[var(--text-secondary)]">{t('ai.image_generating')}</span>
            </div>
          </div>
        )}

        {/* Result preview */}
        {result && (
          <div className="space-y-2">
            <div className="overflow-hidden rounded-[var(--r-md)] border border-[var(--border-default)]">
              <img
                src={result.url}
                alt={prompt}
                className="max-h-[320px] w-full object-contain bg-[var(--bg-inset)]"
              />
            </div>
            {result.revisedPrompt && (
              <div className="rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2.5 py-1.5">
                <p className="text-[10.5px] font-medium text-[var(--text-tertiary)]">
                  {t('ai.image_revised_prompt')}
                </p>
                <p className="mt-0.5 text-[11.5px] text-[var(--text-secondary)]">{result.revisedPrompt}</p>
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setResult(null)
                setPrompt('')
                window.setTimeout(() => textareaRef.current?.focus(), 0)
              }}
              className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--accent)] hover:underline"
            >
              <X size={12} />
              {t('ai.image_regenerate')}
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}