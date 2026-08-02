import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { EditorView } from '@codemirror/view'
import { Sparkles, X, PenLine, Wand2, ImagePlus } from 'lucide-react'
import { Tooltip } from '../../components/overlay'
import { t } from '../../lib/i18n'

export interface AiInlinePromptProps {
  view: EditorView | null
  open: boolean
  /** 'draft' = no selection, write new content; 'edit' = has selection, edit it; 'continue' = continue writing */
  mode: 'draft' | 'edit' | 'continue'
  onClose: () => void
  onSubmit: (prompt: string) => void
  onImage?: () => void
}

interface PanelPos {
  top: number
  left: number
}

export function AiInlinePrompt({ view, open, mode, onClose, onSubmit, onImage }: AiInlinePromptProps) {
  const [value, setValue] = useState('')
  const [pos, setPos] = useState<PanelPos | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const computePos = useCallback(() => {
    if (!view || !open) return
    const { main } = view.state.selection
    const coords = view.coordsAtPos(main.from)
    if (!coords) return
    const rect = view.dom.getBoundingClientRect()
    setPos({ top: coords.bottom - rect.top + 6, left: coords.left - rect.left })
  }, [view, open])

  useLayoutEffect(() => {
    computePos()
  }, [computePos])

  useEffect(() => {
    if (!open) {
      setValue('')
      return
    }
    const id = window.setTimeout(() => {
      inputRef.current?.focus()
      computePos()
    }, 0)
    return () => window.clearTimeout(id)
  }, [open, computePos])

  useEffect(() => {
    if (!open || !view) return
    const onScroll = () => computePos()
    const scrollDom = view.scrollDOM
    scrollDom.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      scrollDom.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, view, computePos])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return
      onClose()
    }
    window.addEventListener('mousedown', onMouseDown)
    return () => window.removeEventListener('mousedown', onMouseDown)
  }, [open, onClose])

  if (!open || !view || !pos) return null

  const trimmed = value.trim()
  const canSubmit = trimmed.length > 0 || mode === 'continue'
  const hintText =
    mode === 'edit'
      ? t('ai.suggest_edit_hint')
      : mode === 'continue'
        ? t('ai.continue_hint')
        : t('ai.suggest_draft_hint')

  const handleSubmit = () => {
    if (!canSubmit) return
    onSubmit(trimmed)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }

  const editorWidth = view.dom.clientWidth
  const panelWidth = Math.min(360, Math.max(200, editorWidth - 16))
  const maxLeft = Math.max(8, editorWidth - panelWidth - 8)

  const headerIcon =
    mode === 'edit' ? <Wand2 size={13} /> : mode === 'continue' ? <PenLine size={13} /> : <Sparkles size={13} />
  const headerTitle =
    mode === 'edit'
      ? t('ai.ask_ai_to_edit')
      : mode === 'continue'
        ? t('ai.continue_writing')
        : t('ai.draft_title')

  return createPortal(
    <div
      ref={panelRef}
      className="anim-pop"
      style={{
        position: 'absolute',
        top: pos.top,
        left: Math.max(8, Math.min(pos.left, maxLeft)),
        width: panelWidth,
        zIndex: 235,
      }}
    >
      <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-pop)] backdrop-blur">
        {/* Header with brand gradient accent */}
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2">
          <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--text-primary)]">
            <span className="ai-brand-text">{headerIcon}</span>
            <span className="ai-brand-text">{headerTitle}</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="inline-flex size-6 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <X size={13} />
          </button>
        </div>
        {/* Input */}
        <div className="p-2">
          {mode !== 'continue' ? (
            <textarea
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t('ai.suggest_placeholder')}
              rows={3}
              className="w-full resize-none rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-2 text-[12.5px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-ring)] focus:outline-none"
            />
          ) : (
            <p className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
              {t('ai.continue_hint')}
            </p>
          )}
          <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-quaternary)]">{hintText}</p>
        </div>
        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--border-subtle)] px-3 py-2">
          <div className="flex items-center gap-1">
            {onImage && (
              <Tooltip label={t('ai.task_image')}>
                <button
                  type="button"
                  onClick={onImage}
                  aria-label={t('ai.task_image')}
                  className="inline-flex size-7 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
                >
                  <ImagePlus size={14} />
                </button>
              </Tooltip>
            )}
            <span className="ml-1 text-[10.5px] text-[var(--text-quaternary)]">
              <span className="hidden md:inline">⌘↵ </span>
              {t('ai.shortcut_submit')}
            </span>
          </div>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="ai-brand-gradient inline-flex items-center gap-1 rounded-[var(--r-sm)] px-3 py-1.5 text-[11.5px] font-medium text-white transition-transform hover:scale-[1.03] active:scale-95 disabled:opacity-40"
          >
            <Sparkles size={11} />
            {t('ai.generate')}
          </button>
        </div>
      </div>
    </div>,
    view.dom,
  )
}
