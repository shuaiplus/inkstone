import type { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import { api, ApiError } from './api'
import { t } from './i18n'
import type {
  AiContentRequest,
  AiContinueRequest,
  AiDraftRequest,
  AiEditRequest,
} from '@shared/types'
import {
  getAiGenerationMarker,
  updateAiGenerationMarker,
  type AiGenerationPhase,
} from '../editor/ai-generation'

type ToastFn = (toast: { title: string; description?: string; tone?: 'default' | 'success' | 'warning' | 'danger' }) => void

export type AiMode = 'replace' | 'append' | 'insert' | 'insert-below'

export type AiTask = 'summarize' | 'polish' | 'draft' | 'edit' | 'continue' | 'image'

export interface AiRunOptions {
  view: EditorView
  task: AiTask
  mode: AiMode
  toast: ToastFn
  signal?: AbortSignal
  /** topic for 'draft', instruction for 'edit', prompt for 'image' */
  prompt?: string
  onProgress?: (progress: AiRunProgress) => void
}

export interface AiRunProgress {
  phase: AiGenerationPhase
  characters: number
}

export interface AiRunContext {
  selection: string
  content: string
  from: number
  to: number
}

function captureContext(view: EditorView): AiRunContext {
  const { main } = view.state.selection
  const from = main.from
  const to = main.to
  const selection = from === to ? '' : view.state.sliceDoc(from, to)
  const content = view.state.doc.toString()
  return { selection, content, from, to }
}

function paragraphSeparatorBefore(view: EditorView, position: number): string {
  if (position === 0) return ''
  const before = view.state.sliceDoc(Math.max(0, position - 2), position)
  if (before.endsWith('\n\n')) return ''
  if (before.endsWith('\n')) return '\n'
  return '\n\n'
}

export async function runAiIntoEditor(opts: AiRunOptions): Promise<void> {
  const { view, task, mode, toast, signal, onProgress } = opts
  if (task === 'image') return
  const ctx = captureContext(view)

  if (task === 'draft' || task === 'continue') {
    if (task === 'draft' && (!opts.prompt || opts.prompt.trim() === '')) {
      toast({ title: t('ai.empty_topic'), tone: 'warning' })
      return
    }
  } else if (task === 'edit') {
    if (!opts.prompt || opts.prompt.trim() === '') {
      toast({ title: t('ai.empty_topic'), tone: 'warning' })
      return
    }
    if (ctx.selection.trim() === '') {
      toast({ title: t('ai.empty_content'), tone: 'warning' })
      return
    }
  } else {
    const source = ctx.selection || ctx.content
    if (source.trim() === '') {
      toast({ title: t('ai.empty_content'), tone: 'warning' })
      return
    }
  }

  const initialFrom = mode === 'replace' && ctx.from !== ctx.to
    ? ctx.from
    : mode === 'append'
      ? view.state.doc.length
      : ctx.to
  const initialTo = mode === 'replace' && ctx.from !== ctx.to ? ctx.to : initialFrom
  updateAiGenerationMarker(view, {
    from: initialFrom,
    to: initialTo,
    phase: 'connecting',
    label: t('ai.connecting'),
  })
  onProgress?.({ phase: 'connecting', characters: 0 })

  let produced = false
  let generatedCharacters = 0
  let pending = ''
  let animationFrame = 0

  const flushPending = () => {
    if (!pending || !view.dom.isConnected) return
    const chunk = pending
    pending = ''
    const marker = getAiGenerationMarker(view)

    if (!produced) {
      const from = Math.min(marker?.from ?? initialFrom, view.state.doc.length)
      const to = Math.min(Math.max(marker?.to ?? initialTo, from), view.state.doc.length)
      const separator = mode === 'append' || mode === 'insert-below'
        ? paragraphSeparatorBefore(view, from)
        : ''
      const inserted = `${separator}${chunk}`
      const generatedFrom = from + separator.length
      const next = from + inserted.length
      view.dispatch({
        changes: { from, to, insert: inserted },
        selection: EditorSelection.cursor(next),
        scrollIntoView: true,
        userEvent: 'input.ai',
      })
      updateAiGenerationMarker(view, {
        from: generatedFrom,
        to: next,
        phase: 'streaming',
        label: t('ai.writing'),
      })
      produced = true
    } else {
      const current = getAiGenerationMarker(view)
      const position = Math.min(current?.to ?? view.state.selection.main.head, view.state.doc.length)
      const generatedFrom = Math.min(current?.from ?? position, position)
      const next = position + chunk.length
      view.dispatch({
        changes: { from: position, insert: chunk },
        selection: EditorSelection.cursor(next),
        scrollIntoView: true,
        userEvent: 'input.ai',
      })
      updateAiGenerationMarker(view, {
        from: generatedFrom,
        to: next,
        phase: 'streaming',
        label: t('ai.writing'),
      })
    }

    generatedCharacters += chunk.length
    onProgress?.({ phase: 'streaming', characters: generatedCharacters })
  }

  const scheduleFlush = () => {
    if (animationFrame) return
    animationFrame = window.requestAnimationFrame(() => {
      animationFrame = 0
      flushPending()
    })
  }

  const finishPending = () => {
    if (animationFrame) {
      window.cancelAnimationFrame(animationFrame)
      animationFrame = 0
    }
    flushPending()
  }

  try {
    let body: AiContentRequest | AiDraftRequest | AiEditRequest | AiContinueRequest
    if (task === 'draft') {
      body = { topic: opts.prompt! }
    } else if (task === 'edit') {
      body = { instruction: opts.prompt!, content: ctx.content, selection: ctx.selection || undefined }
    } else if (task === 'continue') {
      body = { content: ctx.content }
    } else {
      body = { content: ctx.content, selection: ctx.selection || undefined }
    }
    await api.ai.stream(
      task,
      body,
      (chunk) => {
        pending += chunk
        scheduleFlush()
      },
      signal,
    )
    finishPending()
    if (produced) {
      view.focus()
    } else {
      toast({ title: t('ai.empty_result'), tone: 'warning' })
    }
  } catch (err) {
    finishPending()
    if ((err as Error)?.name === 'AbortError') return
    const message = err instanceof ApiError ? err.message : String(err)
    toast({ title: t('ai.request_failed'), description: message, tone: 'danger' })
  } finally {
    if (animationFrame) window.cancelAnimationFrame(animationFrame)
    if (view.dom.isConnected) updateAiGenerationMarker(view, null)
  }
}

export async function runAiImageIntoEditor(opts: AiRunOptions): Promise<void> {
  const { view, task, toast, signal, prompt } = opts
  if (task !== 'image') return
  if (!prompt || prompt.trim() === '') {
    toast({ title: t('ai.empty_topic'), tone: 'warning' })
    return
  }
  const ctx = captureContext(view)
  try {
    const result = await api.ai.image({ prompt: prompt.trim() }, signal)
    const alt = prompt.trim().slice(0, 60).replace(/[\[\]]/g, '')
    insertMarkdownBlock(view, ctx.to, `![${alt}](${result.url})`)
    view.focus()
    if (result.revisedPrompt) {
      toast({ title: t('ai.image_revised_prompt'), description: result.revisedPrompt, tone: 'default' })
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return
    const message = err instanceof ApiError ? err.message : String(err)
    toast({ title: t('ai.image_failed'), description: message, tone: 'danger' })
  }
}

export function insertMarkdownBlock(view: EditorView, position: number, markdown: string): void {
  const prefix = paragraphSeparatorBefore(view, position)
  const after = view.state.sliceDoc(position, Math.min(view.state.doc.length, position + 2))
  const suffix = position === view.state.doc.length
    ? '\n'
    : after.startsWith('\n\n')
      ? ''
      : after.startsWith('\n')
        ? '\n'
        : '\n\n'
  const inserted = `${prefix}${markdown.trim()}${suffix}`
  const next = position + inserted.length
  view.dispatch({
    changes: { from: position, insert: inserted },
    selection: EditorSelection.cursor(next),
    scrollIntoView: true,
    userEvent: 'input.ai',
  })
  view.focus()
}
