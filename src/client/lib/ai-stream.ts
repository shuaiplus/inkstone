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

type ToastFn = (toast: { title: string; description?: string; tone?: 'default' | 'success' | 'warning' | 'danger' }) => void

export type AiMode = 'replace' | 'append' | 'insert'

export type AiTask = 'summarize' | 'polish' | 'draft' | 'edit' | 'continue' | 'image'

export interface AiRunOptions {
  view: EditorView
  task: AiTask
  mode: AiMode
  toast: ToastFn
  signal?: AbortSignal
  /** topic for 'draft', instruction for 'edit', prompt for 'image' */
  prompt?: string
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

function beginInsertion(view: EditorView, mode: AiMode, ctx: AiRunContext): number {
  if (mode === 'replace' && ctx.from !== ctx.to) {
    view.dispatch({
      changes: { from: ctx.from, to: ctx.to, insert: '' },
      selection: EditorSelection.cursor(ctx.from),
    })
    return ctx.from
  }
  if (mode === 'append') {
    const docEnd = view.state.doc.length
    const insert = '\n\n'
    view.dispatch({
      changes: { from: docEnd, insert },
      selection: EditorSelection.cursor(docEnd + insert.length),
    })
    return docEnd + insert.length
  }
  const pos = ctx.to
  return pos
}

function appendChunk(view: EditorView, position: number, chunk: string): number {
  const next = position + chunk.length
  view.dispatch({
    changes: { from: position, insert: chunk },
    selection: EditorSelection.cursor(next),
    scrollIntoView: true,
    userEvent: 'input.ai',
  })
  return next
}

export async function runAiIntoEditor(opts: AiRunOptions): Promise<void> {
  const { view, task, mode, toast, signal } = opts
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

  const startPos = beginInsertion(view, mode, ctx)
  let cursor = startPos
  let produced = false

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
        cursor = appendChunk(view, cursor, chunk)
        produced = true
      },
      signal,
    )
    if (produced) {
      view.focus()
    } else {
      toast({ title: t('ai.empty_result'), tone: 'warning' })
      if (startPos !== ctx.to || mode !== 'insert') {
        view.dispatch({ changes: { from: startPos, to: cursor, insert: '' } })
      }
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return
    const message = err instanceof ApiError ? err.message : String(err)
    toast({ title: t('ai.request_failed'), description: message, tone: 'danger' })
    if (!produced && startPos !== ctx.to) {
      view.dispatch({ changes: { from: startPos, to: cursor, insert: '' } })
    }
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
    const md = `![${alt}](${result.url})\n`
    view.dispatch({
      changes: { from: ctx.to, insert: md },
      selection: EditorSelection.cursor(ctx.to + md.length),
      scrollIntoView: true,
      userEvent: 'input.ai',
    })
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