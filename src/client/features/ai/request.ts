export type AiPanelMode = 'convert' | 'tidy' | 'summarize' | 'title'

export interface AiPanelTarget {
  noteId: string
  from: number
  to: number
  originalText: string
}

export interface AiPanelRequest {
  mode: AiPanelMode
  input: string
  target: AiPanelTarget | null
}

export const WHOLE_NOTE_RANGE = -1

let pending: AiPanelRequest | null = null

export function setAiPanelRequest(request: AiPanelRequest): void {
  pending = request
}

export function takeAiPanelRequest(): AiPanelRequest | null {
  const request = pending
  pending = null
  return request
}

export function isWholeNote(target: AiPanelTarget): boolean {
  return target.from === WHOLE_NOTE_RANGE && target.to === WHOLE_NOTE_RANGE
}

export function isTargetUnchanged(current: string, target: AiPanelTarget): boolean {
  if (isWholeNote(target)) return current === target.originalText
  return current.slice(target.from, target.to) === target.originalText
}

export function applyToTarget(current: string, target: AiPanelTarget, replacement: string): string {
  if (isWholeNote(target)) return replacement
  return current.slice(0, target.from) + replacement + current.slice(target.to)
}
