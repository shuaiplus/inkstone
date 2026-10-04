import { EditorSelection, EditorState } from '@codemirror/state'
import { history } from '@codemirror/commands'
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_SHORTCUTS } from '../lib/shortcuts'
import { IS_MAC } from '../lib/hotkeys'
import { EDITOR_SHORTCUTS, editorKeymap } from './shortcuts'

let view: EditorView | undefined
afterEach(() => view?.destroy())

function editor(doc: string) {
  view = new EditorView({ state: EditorState.create({
    doc, selection: EditorSelection.range(0, doc.length), extensions: [history(), EditorState.allowMultipleSelections.of(true), keymap.of(editorKeymap)],
  }) })
  return view
}

function key(target: EditorView, init: KeyboardEventInit) {
  const keyCode = init.code?.startsWith('Key') ? init.code.charCodeAt(3)
    : init.code?.startsWith('Digit') ? init.code.charCodeAt(5) : 0
  return runScopeHandlers(target, new KeyboardEvent('keydown', {
    cancelable: true, keyCode, ...(IS_MAC ? { metaKey: true } : { ctrlKey: true }), ...init,
  }), 'editor')
}

describe('editor keyboard behavior', () => {
  it('does not bind the same combination to global and editor actions', () => {
    const combinations = [...Object.values(APP_SHORTCUTS), ...EDITOR_SHORTCUTS.map((item) => item.combo)]
    expect(new Set(combinations).size).toBe(combinations.length)
  })

  it('inserts a link with the standard shortcut while preserving the selected label', () => {
    const target = editor('Link label')
    expect(key(target, { key: 'k', code: 'KeyK' })).toBe(true)
    expect(target.state.doc.toString()).toBe('[Link label]()')
  })

  it('leaves tab-number shortcuts alone and formats headings with Alt instead', () => {
    const target = editor('Title')
    expect(key(target, { key: '1', code: 'Digit1' })).toBe(false)
    expect(target.state.doc.toString()).toBe('Title')
    expect(key(target, { key: '1', code: 'Digit1', altKey: true })).toBe(true)
    expect(target.state.doc.toString()).toBe('# Title')
    expect(key(target, { key: '0', code: 'Digit0', altKey: true })).toBe(true)
    expect(target.state.doc.toString()).toBe('Title')
  })

  it('supports Shift-Z redo on Windows as well as the platform default', () => {
    const target = editor('Text')
    key(target, { key: 'b', code: 'KeyB' })
    key(target, { key: 'z', code: 'KeyZ' })
    expect(target.state.doc.toString()).toBe('Text')
    expect(key(target, { key: 'Z', code: 'KeyZ', shiftKey: true })).toBe(true)
    expect(target.state.doc.toString()).toBe('**Text**')
    if (!IS_MAC) {
      key(target, { key: 'z', code: 'KeyZ' })
      expect(key(target, { key: 'y', code: 'KeyY' })).toBe(true)
      expect(target.state.doc.toString()).toBe('**Text**')
    }
  })

  it('selects matching text with Mod-D instead of changing note favorites', () => {
    const target = editor('word word')
    target.dispatch({ selection: EditorSelection.range(0, 4) })
    expect(key(target, { key: 'd', code: 'KeyD' })).toBe(true)
    expect(target.state.doc.toString()).toBe('word word')
    expect(target.state.selection.ranges).toHaveLength(2)
  })
})
