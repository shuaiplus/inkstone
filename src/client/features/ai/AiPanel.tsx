import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, FilePlus2, Replace, Settings2, Square, Wand2 } from 'lucide-react'
import { Textarea } from '../../components/form'
import { Modal } from '../../components/overlay'
import { Button } from '../../components/primitives'
import type { LossReport } from '../../lib/ai/guard'
import { AI_SYSTEM_PROMPT_CONVERT, AI_SYSTEM_PROMPT_TIDY, classifyAiError, streamMarkdown } from '../../lib/ai/ollama'
import { t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { readTextFile } from './read-text-file'
import { applyToTarget, isTargetUnchanged, takeAiPanelRequest, type AiPanelRequest } from './request'

function lossMessage(loss: LossReport): string {
  if (loss.kind === 'truncated') return t('ai.loss_truncated')
  return t('ai.loss_short', { percent: Math.round((loss.ratio ?? 0) * 100) })
}

function failureMessage(error: unknown): string {
  const classified = classifyAiError(error)
  if (classified.kind === 'unsupported-browser') return t('settings.ai_error_browser')
  if (classified.kind === 'http') {
    return t('settings.ai_error_http', { status: classified.status ?? 0, detail: classified.detail })
  }
  if (classified.kind === 'unreachable') return t('settings.ai_error_unreachable')
  return t('settings.ai_error_unknown', { detail: classified.detail })
}

const FALLBACK_REQUEST: AiPanelRequest = { mode: 'convert', input: '', target: null }

export function AiPanel({ onClose }: { onClose: () => void }) {
  const requestRef = useRef<AiPanelRequest>(takeAiPanelRequest() ?? FALLBACK_REQUEST)
  const request = requestRef.current
  const abortRef = useRef<AbortController | null>(null)
  const toast = useUi((state) => state.toast)
  const openPanel = useUi((state) => state.openPanel)
  const createNote = useNotes((state) => state.createNote)
  const editContent = useNotes((state) => state.editContent)

  const [input, setInput] = useState(request.input)
  const [output, setOutput] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null)
  const [loss, setLoss] = useState<LossReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => () => abortRef.current?.abort(), [])

  const run = async () => {
    if (!input.trim() || running) return
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setOutput('')
    setLoss(null)
    setError(null)
    setProgress(null)
    try {
      const result = await streamMarkdown({
        input,
        systemPrompt: request.mode === 'tidy' ? AI_SYSTEM_PROMPT_TIDY : AI_SYSTEM_PROMPT_CONVERT,
        signal: controller.signal,
        onToken: (delta) => setOutput((current) => current + delta),
        onChunk: (index, total) => setProgress(total > 1 ? { index, total } : null),
      })
      setOutput(result.markdown)
      setLoss(result.loss)
    } catch (failure) {
      if (classifyAiError(failure).kind !== 'aborted') setError(failureMessage(failure))
    } finally {
      abortRef.current = null
      setRunning(false)
      setProgress(null)
    }
  }

  const stop = () => {
    abortRef.current?.abort()
  }

  const acceptAsNewNote = async () => {
    const id = await createNote({ content: output, open: true })
    if (id) onClose()
  }

  const acceptAsReplacement = () => {
    const target = request.target
    if (!target) return
    const state = useNotes.getState()
    const note = state.notes[target.noteId]
    const current = state.contents[target.noteId]
    if (!note || current === undefined) {
      toast({ title: t('ai.target_note_gone'), tone: 'danger' })
      return
    }
    if (!isTargetUnchanged(current, target)) {
      toast({ title: t('ai.target_note_changed'), tone: 'danger' })
      return
    }
    editContent(target.noteId, applyToTarget(current, target, output))
    onClose()
  }

  const acceptFile = async (file: File) => {
    const result = await readTextFile(file)
    if (result.ok) {
      setInput(result.text)
      return
    }
    const reasons = {
      'not-text': t('ai.file_not_text'),
      'too-large': t('ai.file_too_large'),
      'read-failed': t('ai.file_read_failed'),
    }
    toast({ title: reasons[result.reason], tone: 'danger' })
  }

  const title = request.mode === 'tidy' ? t('ai.tidy_title') : t('ai.convert_title')
  const description = request.mode === 'tidy' ? t('ai.tidy_description') : t('ai.convert_description')

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={description}
      width={720}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {running ? (
            <Button type="button" variant="secondary" icon={<Square size={13} />} onClick={stop}>
              {t('ai.stop')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              icon={<Wand2 size={13} />}
              onClick={() => void run()}
              disabled={!input.trim()}
            >
              {output ? t('ai.run_again') : t('ai.run')}
            </Button>
          )}
          {request.mode === 'tidy' ? (
            <Button
              type="button"
              variant="primary"
              icon={<Replace size={13} />}
              onClick={acceptAsReplacement}
              disabled={running || !output}
            >
              {t('ai.replace_note')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              icon={<FilePlus2 size={13} />}
              onClick={() => void acceptAsNewNote()}
              disabled={running || !output}
            >
              {t('ai.create_note')}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-3">
        {loss && (
          <div className="flex items-start gap-2 rounded-[var(--r-lg)] border border-[var(--warning)] bg-[var(--bg-sunken)] p-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--warning)]" />
            <div>
              <div className="font-medium text-[var(--text-primary)]">{lossMessage(loss)}</div>
              <div className="mt-0.5">{t('ai.loss_advice')}</div>
            </div>
          </div>
        )}

        {error && (
          <div className="flex flex-col gap-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
            <span>{error}</span>
            <div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<Settings2 size={13} />}
                onClick={() => {
                  openPanel('settings')
                }}
              >
                {t('ai.open_settings')}
              </Button>
            </div>
          </div>
        )}

        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            const file = event.dataTransfer.files[0]
            if (file) void acceptFile(file)
          }}
        >
          <div className="mb-1 text-[12px] font-medium text-[var(--text-secondary)]">{t('ai.input_label')}</div>
          <Textarea
            rows={7}
            value={input}
            placeholder={t('ai.input_placeholder')}
            className={dragging ? 'border-[var(--accent)]' : undefined}
            onChange={(event) => setInput(event.target.value)}
          />
        </div>

        {(output || running) && (
          <div>
            <div className="mb-1 flex items-center justify-between text-[12px] font-medium text-[var(--text-secondary)]">
              <span>{t('ai.output_label')}</span>
              {progress && <span>{t('ai.chunk_progress', { index: progress.index, total: progress.total })}</span>}
            </div>
            <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3 text-[12px] leading-relaxed text-[var(--text-primary)]">
              {output || t('ai.waiting')}
            </pre>
          </div>
        )}
      </div>
    </Modal>
  )
}
