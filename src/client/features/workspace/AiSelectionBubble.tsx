import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { EditorView } from '@codemirror/view'
import { Sparkles, Wand2, Scissors, Maximize2, Minimize2, SpellCheck, X } from 'lucide-react'
import { t } from '../../lib/i18n'
import type { AiTask, AiMode } from '../../lib/ai-stream'

export interface AiSelectionBubbleProps {
  view: EditorView | null
  running: boolean
  onRun: (task: AiTask, mode: AiMode, prompt?: string) => void
}

interface BubblePos {
  top: number
  left: number
}

interface QuickAction {
  id: string
  label: string
  icon: React.ReactNode
  task: AiTask
  mode: AiMode
  prompt?: string
}

export function AiSelectionBubble({ view, running, onRun }: AiSelectionBubbleProps) {
  const [hasSelection, setHasSelection] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [pos, setPos] = useState<BubblePos | null>(null)
  const [instruction, setInstruction] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const hideTimerRef = useRef<number>(0)

  const checkSelection = useCallback(() => {
    if (!view || running) {
      setHasSelection(false)
      setExpanded(false)
      return
    }
    const { main } = view.state.selection
    const selected = main.from !== main.to
    if (!selected) {
      setHasSelection(false)
      setExpanded(false)
      return
    }
    const coords = view.coordsAtPos(main.from)
    if (!coords) return
    const rect = view.dom.getBoundingClientRect()
    setHasSelection(true)
    setPos({ top: coords.top - rect.top - 8, left: coords.left - rect.left })
  }, [view, running])

  // Listen to editor DOM events for selection changes
  useEffect(() => {
    if (!view) return
    const dom = view.dom
    const onSelect = () => {
      window.clearTimeout(hideTimerRef.current)
      // small delay to let selection settle after mousedown/mouseup
      hideTimerRef.current = window.setTimeout(checkSelection, 10)
    }
    const onScroll = () => {
      if (hasSelection) checkSelection()
    }
    dom.addEventListener('mouseup', onSelect)
    dom.addEventListener('keyup', onSelect)
    dom.addEventListener('touchend', onSelect, { passive: true })
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      dom.removeEventListener('mouseup', onSelect)
      dom.removeEventListener('keyup', onSelect)
      dom.removeEventListener('touchend', onSelect)
      view.scrollDOM.removeEventListener('scroll', onScroll)
      window.clearTimeout(hideTimerRef.current)
    }
  }, [view, checkSelection, hasSelection])

  // Hide when selection becomes empty (also catches clicking away)
  useEffect(() => {
    if (!view || expanded) return
    const check = () => {
      if (!view) return
      const { main } = view.state.selection
      if (main.from === main.to) {
        setHasSelection(false)
      }
    }
    const id = window.setInterval(check, 200)
    return () => window.clearInterval(id)
  }, [view, expanded])

  // Reposition on scroll/resize
  useLayoutEffect(() => {
    if (!hasSelection || !view) return
    const reposition = () => checkSelection()
    window.addEventListener('resize', reposition)
    return () => window.removeEventListener('resize', reposition)
  }, [hasSelection, view, checkSelection])

  // Focus input when expanded
  useEffect(() => {
    if (expanded) {
      const id = window.setTimeout(() => inputRef.current?.focus(), 0)
      return () => window.clearTimeout(id)
    } else {
      setInstruction('')
    }
  }, [expanded])

  // Hide on Escape
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setExpanded(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [expanded])

  const runQuick = (action: QuickAction) => {
    onRun(action.task, action.mode, action.prompt)
    setExpanded(false)
  }

  const runCustom = () => {
    const trimmed = instruction.trim()
    if (!trimmed) return
    onRun('edit', 'replace', trimmed)
    setExpanded(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      runCustom()
    }
  }

  const quickActions: QuickAction[] = [
    { id: 'polish', label: t('ai.polish'), icon: <Wand2 size={13} />, task: 'polish', mode: 'replace' },
    { id: 'shorter', label: t('ai.make_shorter'), icon: <Minimize2 size={13} />, task: 'edit', mode: 'replace', prompt: t('ai.make_shorter') },
    { id: 'longer', label: t('ai.make_longer'), icon: <Maximize2 size={13} />, task: 'edit', mode: 'replace', prompt: t('ai.make_longer') },
    { id: 'grammar', label: t('ai.fix_grammar'), icon: <SpellCheck size={13} />, task: 'edit', mode: 'replace', prompt: t('ai.fix_grammar') },
    { id: 'summarize', label: t('ai.summarize'), icon: <Scissors size={13} />, task: 'summarize', mode: 'insert' },
  ]

  if (!hasSelection || !pos || running) return null

  // Place above selection; flip below if not enough space above
  const flipDown = pos.top < 60
  const editorWidth = view?.dom.clientWidth ?? 800
  const finalStyle: React.CSSProperties = {
    position: 'absolute',
    left: Math.max(8, Math.min(pos.left, editorWidth - 340)),
    top: pos.top,
    transform: flipDown ? 'translateY(8px)' : 'translateY(-100%)',
    zIndex: 230,
  }

  return createPortal(
    <div ref={panelRef} style={finalStyle} className="anim-pop">
      {!expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] shadow-[var(--shadow-pop)] backdrop-blur transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Sparkles size={13} className="text-[var(--accent)]" />
          {t('ai.ask_ai')}
        </button>
      ) : (
        <div className="w-[320px] overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-pop)] backdrop-blur">
          {/* Quick actions row */}
          <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border-subtle)] p-1.5">
            {quickActions.map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() => runQuick(action)}
                className="inline-flex items-center gap-1 rounded-[var(--r-sm)] px-2 py-1 text-[11.5px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                {action.icon}
                <span>{action.label}</span>
              </button>
            ))}
          </div>
          {/* Custom instruction input */}
          <div className="flex items-end gap-2 p-2">
            <textarea
              ref={inputRef}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t('ai.suggest_placeholder')}
              rows={2}
              className="min-h-[44px] flex-1 resize-none rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2 py-1.5 text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-ring)] focus:outline-none"
            />
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => setExpanded(false)}
                aria-label={t('common.close')}
                className="inline-flex size-7 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <X size={13} />
              </button>
              <button
                type="button"
                onClick={runCustom}
                disabled={!instruction.trim()}
                className="inline-flex items-center gap-1 rounded-[var(--r-sm)] bg-[var(--accent)] px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
              >
                <Sparkles size={12} />
                {t('ai.replace')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    view?.dom ?? document.body,
  )
}