import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Spinner } from '../../components/primitives'
import { t } from '../../lib/i18n'

export interface AiGeneratingBarProps {
  task: 'summarize' | 'polish' | 'draft'
  onCancel: () => void
}

export function AiGeneratingBar({ task, onCancel }: AiGeneratingBarProps) {
  const taskLabel =
    task === 'polish'
      ? t('ai.task_polish')
      : task === 'summarize'
        ? t('ai.task_summarize')
        : t('ai.task_draft')
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="anim-pop fixed bottom-4 left-1/2 z-[240] flex -translate-x-1/2 items-center gap-3 rounded-[var(--r-xl)] border border-[var(--border-default)] bg-[var(--bg-overlay)] px-3.5 py-2.5 shadow-[var(--shadow-pop)] backdrop-blur md:bottom-6"
    >
      <span className="flex items-center gap-2 text-[var(--accent)]">
        <Spinner size={14} />
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