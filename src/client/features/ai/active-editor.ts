import type { EditorView } from '@codemirror/view'

export interface EditorSelection {
  text: string
  from: number
  to: number
}

let activeView: EditorView | null = null

export function setActiveEditorView(view: EditorView | null): void {
  activeView = view
}

export function getEditorSelection(): EditorSelection | null {
  if (!activeView) return null
  const range = activeView.state.selection.main
  const text = activeView.state.sliceDoc(range.from, range.to)
  if (!text.trim()) return null
  return { text, from: range.from, to: range.to }
}
