import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorSelection, EditorState } from '@codemirror/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { EditorToolbar } from './EditorToolbar'
import { editorCombo } from '../../editor/shortcuts'
import { prettyCombo } from '../../lib/hotkeys'

let root: Root
let container: HTMLDivElement

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  await initI18n()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function toolbarButton(label: string) {
  const button = [...container.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === label)
  expect(button).toBeDefined()
  return button!
}

describe('editor toolbar interactions', () => {
  it('shows the actual link binding on hover and omits invented shortcuts for unbound actions', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    await act(() => root.render(createElement(EditorToolbar, { onPickImage: vi.fn() })))
    const link = toolbarButton(t('workspace.link'))
    vi.spyOn(link, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 28, 28))
    await act(() => link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(() => vi.advanceTimersByTime(500))
    const tooltip = document.querySelector('[role="tooltip"]')!
    expect(tooltip.textContent).toContain(t('workspace.link'))
    expect([...tooltip.querySelectorAll('kbd')].map((key) => key.textContent)).toEqual(prettyCombo(editorCombo('link')!))
    await act(() => link.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    const highlight = toolbarButton(t('common.highlight'))
    vi.spyOn(highlight, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 28, 28))
    await act(() => highlight.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(() => vi.advanceTimersByTime(500))
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(t('common.highlight'))
    expect(document.querySelector('[role="tooltip"] kbd')).toBeNull()
  })
  it('keeps uploading one click away and inserts remote image syntax through the image menu', async () => {
    const pickImage = vi.fn()
    let state = EditorState.create({ doc: 'Alt text', selection: EditorSelection.range(0, 8) })
    await act(() => root.render(createElement(EditorToolbar, {
      onPickImage: pickImage,
      runCommand: (command) => command({ state, dispatch: (transaction: { state: EditorState }) => { state = transaction.state } } as never),
    })))
    await act(() => toolbarButton(t('workspace.upload_image')).click())
    expect(pickImage).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).toBeNull()

    await act(() => toolbarButton(t('workspace.insert_image')).click())
    const remote = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((node) => node.textContent === t('workspace.remote_image'))!
    await act(() => remote.click())
    expect(state.doc.toString()).toBe('![Alt text]()')
    expect(pickImage).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('lets keyboard users choose a block formula without losing their selected text', async () => {
    let state = EditorState.create({ doc: 'x^2', selection: EditorSelection.range(0, 3) })
    await act(() => root.render(createElement(EditorToolbar, {
      mobile: true,
      onPickImage: vi.fn(),
      runCommand: (command) => command({ state, dispatch: (transaction: { state: EditorState }) => { state = transaction.state } } as never),
    })))
    const trigger = toolbarButton(t('workspace.math'))
    await act(() => trigger.click())
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })))
    expect(document.activeElement?.textContent).toBe(t('workspace.block_math'))
    await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })))
    expect(state.doc.toString()).toBe('$$\nx^2\n$$\n')
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe('x^2')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})
