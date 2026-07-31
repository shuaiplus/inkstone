import { createPortal } from 'react-dom'
import { X, Sparkles } from 'lucide-react'
import { t } from '../../lib/i18n'
import type { AiTask } from '../../lib/ai-stream'

export interface AiGeneratingBarProps {
  task: AiTask
  onCancel: () => void
}

export function AiGeneratingBar({ task, onCancel }: AiGeneratingBarProps) {
  const taskLabel =
    task === 'polish'
      ? t('ai.task_polish')
      : task === 'summarize'
        ? t('ai.task_summarize')
        : task === 'edit'
          ? t('ai.task_edit')
          : task === 'continue'
            ? t('ai.continue_writing')
            : task === 'image'
              ? t('ai.task_image')
              : t('ai.task_draft')
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="anim-pop fixed bottom-4 left-1/2 z-[240] flex -translate-x-1/2 items-center gap-3 overflow-hidden rounded-[var(--r-xl)] border border-[var(--border-default)] bg-[var(--bg-overlay)] py-2.5 pl-3 pr-2 shadow-[var(--shadow-pop)] backdrop-blur md:bottom-6"
    >
      <span className="ai-shimmer-bg absolute inset-x-0 top-0 h-[2px]" />
      <span className="relative flex size-6 items-center justify-center rounded-full bg-[var(--accent-soft)]">
        <Sparkles size={12} className="text-[var(--accent)]" />
        <span className="absolute inset-0 animate-ping rounded-full bg-[var(--accent)] opacity-20" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
          {t('ai.generating_with_task', { task: taskLabel })}
        </span>
        <span className="hidden text-[11px] text-[var(--text-tertiary)] md:block">
          {t('ai.generating_hint')}
        </span>
      </span>
      <button
        type="button"
        onClick={onCancel}
        aria-label={t('ai.cancel_generation')}
        className="ml-1 inline-flex items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] px-2 py-1 text-[11.5px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      >
        <X size={12} />
        <span>{t('common.cancel')}</span>
      </button>
    </div>,
    document.body,
  )
}