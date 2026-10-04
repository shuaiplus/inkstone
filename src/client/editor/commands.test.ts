import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { completeCodeFenceOnEnter, insertMathBlock, setHeading, toggleComment } from './commands'
import { renderMarkdown } from '../lib/markdown/renderer'

function runFenceCompletion(doc: string, cursor = doc.length) {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) })
  let next = state
  const handled = completeCodeFenceOnEnter({ state, dispatch: (transaction) => { next = transaction.state } })
  return { handled, state: next }
}

describe('completeCodeFenceOnEnter', () => {
  it('adds a closing fence and places the cursor inside a new code block', () => {
    const result = runFenceCompletion('```ts')

    expect(result.handled).toBe(true)
    expect(result.state.doc.toString()).toBe('```ts\n\n```')
    expect(result.state.selection.main.head).toBe(6)
  })

  it('does not add another fence when Enter is pressed on a closing fence', () => {
    const result = runFenceCompletion('```\nconsole.log(1)\n```')

    expect(result.handled).toBe(false)
    expect(result.state.doc.toString()).toBe('```\nconsole.log(1)\n```')
  })
})

describe('toolbar formatting commands', () => {
  it('restores selected headings to body text without changing ordinary lines', () => {
    const doc = '# Title\nBody\n### Section'
    let state = EditorState.create({ doc, selection: EditorSelection.range(0, doc.length) })
    setHeading(0)({ state, dispatch: (transaction) => { state = transaction.state } })
    expect(state.doc.toString()).toBe('Title\nBody\nSection')
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe('Title\nBody\nSection')
    expect(setHeading(0)({ state, dispatch: () => {} })).toBe(false)
  })

  it('preserves selected math inside a renderable block in the middle of a paragraph', () => {
    let state = EditorState.create({ doc: 'Before a^2 After', selection: EditorSelection.range(7, 10) })
    insertMathBlock({ state, dispatch: (transaction) => { state = transaction.state } })
    expect(state.doc.toString()).toBe('Before \n\n$$\na^2\n$$\n\n After')
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe('a^2')
    const rendered = renderMarkdown(state.doc.toString())
    expect(rendered.hasMath).toBe(true)
    expect(rendered.html).toContain('class="math-block"')
    expect(rendered.html).toContain('Before')
    expect(rendered.html).toContain('After')
  })

  it('places the cursor inside an empty block formula', () => {
    let state = EditorState.create()
    insertMathBlock({ state, dispatch: (transaction) => { state = transaction.state } })
    expect(state.doc.toString()).toBe('$$\n\n$$\n')
    expect(state.selection.main.head).toBe(3)
  })

  it('hides multiline comments in preview and restores the selected text when toggled again', () => {
    const doc = 'Public\n\nPrivate first\nPrivate second'
    let state = EditorState.create({ doc, selection: EditorSelection.range(8, doc.length) })
    toggleComment({ state, dispatch: (transaction) => { state = transaction.state } })
    expect(renderMarkdown(state.doc.toString()).html).not.toContain('Private')
    expect(renderMarkdown(state.doc.toString()).html).toContain('Public')
    toggleComment({ state, dispatch: (transaction) => { state = transaction.state } })
    expect(state.doc.toString()).toBe(doc)
  })
})
