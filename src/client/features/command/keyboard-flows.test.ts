import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { IS_MAC } from '../../lib/hotkeys'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { NoteList } from '../list/NoteList'
import { CommandPalette } from './CommandPalette'

const note: NoteSummary = {
  id: 'note-1', title: 'Alpha', excerpt: 'Text', folderId: null, tags: [],
  isPinned: false, isStarred: false, isArchived: false, wordCount: 1, charCount: 4,
  rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null,
}
const originalNotes = useNotes.getState()
const originalUi = useUi.getState()
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
let root: Root
let container: HTMLDivElement
let remove: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  await initI18n()
  remove = vi.fn(async () => {})
  useNotes.setState({ notes: { [note.id]: note }, folders: [], tags: [], hydrated: true, loading: false, deleteNote: remove })
  useUi.setState({ activeNoteId: note.id, selectedIds: [note.id], recentNoteIds: [note.id], view: 'all', folderId: null, tag: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  if (root) await act(() => root.unmount())
  container?.remove()
  useNotes.setState(originalNotes, true)
  useUi.setState(originalUi, true)
  vi.restoreAllMocks()
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  vi.unstubAllGlobals()
})

describe('shortcut contexts', () => {
  it('opens command mode without querying note search or listing note matches', async () => {
    const search = vi.spyOn(api, 'search').mockResolvedValue({ results: [], mode: 'fts', took: 0, query: { text: '', tags: [], folder: null, starred: null, archived: null } })
    await act(() => root.render(createElement(CommandPalette, { initialQuery: '> ', onClose: vi.fn() })))
    expect(document.querySelector<HTMLInputElement>('[role="combobox"]')?.value).toBe('> ')
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain(t('command.archive_current_note'))
    expect(document.querySelector('[role="listbox"]')?.textContent).not.toContain('Alpha')
    expect(search).not.toHaveBeenCalled()
  })

  it('opens note search separately from command mode', async () => {
    vi.spyOn(api, 'search').mockResolvedValue({ results: [], mode: 'fts', took: 0, query: { text: 'Alpha', tags: [], folder: null, starred: null, archived: null } })
    await act(() => root.render(createElement(CommandPalette, { initialQuery: 'Alpha', onClose: vi.fn() })))
    expect(document.querySelector<HTMLInputElement>('[role="combobox"]')?.value).toBe('Alpha')
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain('Alpha')
  })

  it('deletes only from the focused note list and leaves input editing and repeated keydown alone', async () => {
    await act(() => root.render(createElement(NoteList)))
    const list = container.querySelector<HTMLElement>('[data-note-list]')!
    const input = document.createElement('input')
    list.append(input)
    const deletion = IS_MAC ? { key: 'Backspace', metaKey: true } : { key: 'Delete' }
    await act(() => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...deletion })))
    await act(() => list.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, repeat: true, ...deletion })))
    expect(remove).not.toHaveBeenCalled()
    list.focus()
    await act(() => list.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...deletion })))
    expect(remove).toHaveBeenCalledExactlyOnceWith(note.id)
  })
})
