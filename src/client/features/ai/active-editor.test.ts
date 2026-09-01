import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { getEditorSelection, setActiveEditorView } from './active-editor'

function viewWith(doc: string, from: number, to: number): EditorView {
  return new EditorView({ state: EditorState.create({ doc, selection: { anchor: from, head: to } }) })
}

afterEach(() => {
  setActiveEditorView(null)
})

describe('getEditorSelection', () => {
  it('returns null when no editor has been registered', () => {
    expect(getEditorSelection()).toBeNull()
  })

  it('returns null for an empty caret selection', () => {
    setActiveEditorView(viewWith('hello world', 3, 3))
    expect(getEditorSelection()).toBeNull()
  })

  it('returns null for a whitespace-only selection', () => {
    setActiveEditorView(viewWith('a   b', 1, 4))
    expect(getEditorSelection()).toBeNull()
  })

  it('returns the selected text with its range', () => {
    setActiveEditorView(viewWith('hello world', 6, 11))
    expect(getEditorSelection()).toEqual({ text: 'world', from: 6, to: 11 })
  })

  it('forgets the editor once it is unregistered', () => {
    setActiveEditorView(viewWith('hello world', 6, 11))
    setActiveEditorView(null)
    expect(getEditorSelection()).toBeNull()
  })
})
