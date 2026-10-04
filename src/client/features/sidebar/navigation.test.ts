import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Folder, NoteSummary } from '@shared/types';
import { initI18n, t } from '../../lib/i18n';
import { api } from '../../lib/api';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { Sidebar } from './Sidebar';
import { groupExplorerNotes } from './ExplorerNote';
import { MobileLibraryFilters } from '../shell/MobileLibraryFilters';
import { NoteList } from '../list/NoteList';

const folder: Folder = { id: 'folder', name: 'Project', parentId: null, icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 };
const note: NoteSummary = { id: 'note', title: 'Nested note', excerpt: '', folderId: folder.id, tags: [], isPinned: false, isStarred: false, isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null };
const originalUi = useUi.getState();
const originalNotes = useNotes.getState();
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    await initI18n();
    useUi.setState({ ...originalUi, listCollapsed: true, view: 'all', folderId: null, activeNoteId: null, expandedFolders: [], mobilePane: 'list', searchList: false });
    useNotes.setState({ ...originalNotes, folders: [folder], notes: { [note.id]: note }, tags: [], openNote: vi.fn(async (id) => { useUi.getState().setActiveNote(id); }) });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    useUi.setState(originalUi, true);
    useNotes.setState(originalNotes, true);
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim() === label || element.getAttribute('aria-label') === label)!;
const click = async (element: HTMLElement) => { expect(element).toBeTruthy(); await act(() => element.click()); };

describe('folder drag feedback', () => {
    async function drag(target: EventTarget, type: string) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
            dataTransfer: { value: { types: ['application/x-inkstone-folder'], getData: (format: string) => format === 'application/x-inkstone-folder' ? 'dragged-folder' : '', dropEffect: 'move' } },
            clientY: { value: 0 },
            relatedTarget: { value: null },
        });
        await act(() => target.dispatchEvent(event));
    }
    const highlighted = (element: Element) => element.classList.contains('ring-1');
    async function renderTree() {
        await act(() => root.render(createElement(Sidebar)));
        return {
            section: container.querySelector('[role="tree"]')!.closest('section')!,
            folderRow: container.querySelector<HTMLElement>('[data-folder-drop-target]')!,
        };
    }

    it('clears the root highlight when a folder handles and stops the drop event', async () => {
        const move = vi.fn(() => true);
        useNotes.setState({ patchFolder: move });
        const { section, folderRow } = await renderTree();
        await drag(section, 'dragover');
        expect(highlighted(section)).toBe(true);
        await drag(folderRow, 'drop');
        expect(move).toHaveBeenCalledExactlyOnceWith('dragged-folder', { parentId: folder.id, beforeId: null });
        expect(highlighted(section)).toBe(false);
        expect(highlighted(folderRow)).toBe(false);
    });

    it('highlights only the folder while moving from the root into that folder', async () => {
        const { section, folderRow } = await renderTree();
        await drag(section, 'dragover');
        expect(highlighted(section)).toBe(true);
        await drag(folderRow, 'dragover');
        expect(highlighted(section)).toBe(false);
        expect(highlighted(folderRow)).toBe(true);
        await drag(document.body, 'dragend');
        expect(highlighted(folderRow)).toBe(false);
    });

    it.each(['dragend', 'escape', 'blur', 'leave-window', 'drop-outside'])('clears the root highlight after %s', async (ending) => {
        const { section } = await renderTree();
        await drag(section, 'dragover');
        expect(highlighted(section)).toBe(true);
        if (ending === 'escape') {
            await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        } else if (ending === 'blur') {
            await act(() => window.dispatchEvent(new Event('blur')));
        } else {
            await drag(ending === 'leave-window' ? document.documentElement : document.body,
                ending === 'leave-window' ? 'dragleave' : ending === 'drop-outside' ? 'drop' : 'dragend');
        }
        expect(highlighted(section)).toBe(false);
    });
});

describe('explorer and collection navigation', () => {
    it('defaults to a hidden desktop list and reopens it for every collection', () => {
        expect(useUi.getInitialState().listCollapsed).toBe(true);
        for (const view of ['all', 'recent', 'starred', 'unfiled', 'archived', 'trash', 'tag', 'folder'] as const) {
            useUi.getState().openView(view, { folderId: folder.id, tag: 'topic' });
            expect(useUi.getState().listCollapsed).toBe(false);
            useUi.getState().toggleList();
        }
    });

    it('groups active notes at their actual depth, keeps root notes, and excludes archive and trash', () => {
        const rootNote = { ...note, id: 'root', folderId: null };
        const orphan = { ...note, id: 'orphan', folderId: 'missing' };
        const archived = { ...note, id: 'archive', isArchived: true };
        const trashed = { ...note, id: 'trash', deletedAt: 1 };
        const groups = groupExplorerNotes(Object.fromEntries([note, rootNote, orphan, archived, trashed].map((item) => [item.id, item])), [folder], 'en-US');
        expect(groups.get(folder.id)).toEqual([note]);
        expect(groups.get(null)?.map((item) => item.id).sort()).toEqual(['orphan', 'root']);
    });

    it('opens a collection, then opens a tree note without keeping the list', async () => {
        await act(() => root.render(createElement(Sidebar)));
        await click(button(container, t('navigation.all_notes') + '1'));
        expect(useUi.getState().listCollapsed).toBe(false);
        await click(button(container, folder.name));
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
        expect(useUi.getState().listCollapsed).toBe(true);
        expect(container.querySelector('[data-tree-note-id="note"]')).toBeTruthy();
        await click(container.querySelector<HTMLButtonElement>('[data-tree-note-open]')!);
        expect(useUi.getState().activeNoteId).toBe(note.id);
        expect(useUi.getState().folderId).toBe(folder.id);
        expect(useUi.getState().listCollapsed).toBe(true);
    });

    it('opens global search as a list and returns to folder context when using the explorer', () => {
        useUi.getState().openView('trash');
        useUi.getState().openSearchList();
        expect(useUi.getState()).toMatchObject({ searchList: true, listCollapsed: false, view: 'all', mobilePane: 'list' });
        useUi.getState().openExplorer(folder.id);
        expect(useUi.getState()).toMatchObject({ searchList: false, listCollapsed: true, view: 'folder', folderId: folder.id });
    });

    it('restores the note in the background on mobile without interrupting navigation', () => {
        useUi.getState().setWorkspaceNote('primary', note.id, true, false);
        expect(useUi.getState()).toMatchObject({ activeNoteId: note.id, mobilePane: 'list' });
        useUi.getState().setMobilePane('account');
        useUi.getState().setWorkspaceNote('primary', note.id, true, false);
        expect(useUi.getState().mobilePane).toBe('account');
        useUi.getState().setActiveNote(note.id);
        expect(useUi.getState().mobilePane).toBe('preview');
    });
});

describe('mobile navigation sheets', () => {
    it('keeps archive and trash in the view sheet and closes after selection', async () => {
        await act(() => root.render(createElement(MobileLibraryFilters)));
        await click(container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!);
        const sheet = document.querySelector('[role="dialog"]')!;
        expect(sheet).toBeTruthy();
        expect(sheet.contains(document.activeElement)).toBe(true);
        await click(button(sheet, t('navigation.trash') + '0'));
        expect(useUi.getState().view).toBe('trash');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('expands folders without closing, then opens a note and dismisses the sheet', async () => {
        await act(() => root.render(createElement(MobileLibraryFilters)));
        await click(container.querySelectorAll<HTMLButtonElement>('[aria-haspopup="dialog"]')[2]!);
        const sheet = document.querySelector('[role="dialog"]')!;
        await click(button(sheet, t('sidebar.expand')));
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
        expect(document.querySelector('[role="dialog"]')).toBeTruthy();
        await click(sheet.querySelector<HTMLButtonElement>('[data-tree-note-open]')!);
        expect(useUi.getState().activeNoteId).toBe(note.id);
        expect(useUi.getState().mobilePane).toBe('preview');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('dismisses with Escape and restores focus to the trigger', async () => {
        await act(() => root.render(createElement(MobileLibraryFilters)));
        const trigger = container.querySelectorAll<HTMLButtonElement>('[aria-haspopup="dialog"]')[1]!;
        trigger.focus();
        await click(trigger);
        await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('selects a folder as a list filter without opening an arbitrary note', async () => {
        await act(() => root.render(createElement(MobileLibraryFilters)));
        await click(container.querySelectorAll<HTMLButtonElement>('[aria-haspopup="dialog"]')[2]!);
        await click(button(document.querySelector('[role="dialog"]')!, folder.name));
        expect(useUi.getState()).toMatchObject({ view: 'folder', folderId: folder.id, mobilePane: 'list', activeNoteId: null });
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
});

describe('search list', () => {
    async function input(value: string) {
        const element = container.querySelector<HTMLInputElement>('input')!;
        await act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
            element.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(() => vi.advanceTimersByTimeAsync(200));
    }

    it('ignores stale full-text results after the query changes', async () => {
        vi.useFakeTimers();
        const requests: { signal?: AbortSignal; resolve: (response: Awaited<ReturnType<typeof api.search>>) => void }[] = [];
        vi.spyOn(api, 'search').mockImplementation((_query, _limit, signal) => new Promise((resolve) => requests.push({ signal, resolve })));
        useUi.getState().openSearchList();
        await act(() => root.render(createElement(NoteList)));
        await input('first');
        await input('second');
        expect(requests).toHaveLength(2);
        expect(requests[0]!.signal?.aborted).toBe(true);
        const response = (title: string): Awaited<ReturnType<typeof api.search>> => ({ results: [{ note: { ...note, id: title, title }, snippet: '', score: 1 }], mode: 'fts', took: 1, query: { text: title, tags: [], folder: null, starred: null, archived: null } });
        await act(() => requests[1]!.resolve(response('Current result')));
        await act(() => requests[0]!.resolve(response('Stale result')));
        const list = container.querySelector('[data-note-list]')!;
        expect(list.textContent).toContain('Current result');
        expect(list.textContent).not.toContain('Stale result');
    });

    it('keeps cached full-text matches usable if the server search fails', async () => {
        vi.useFakeTimers();
        vi.spyOn(api, 'search').mockRejectedValue(new Error('offline'));
        useNotes.setState({ contents: { [note.id]: 'A unique cached keyword' } });
        useUi.getState().openSearchList();
        await act(() => root.render(createElement(NoteList)));
        await input('keyword');
        expect(container.querySelector('[data-note-list]')?.textContent).toContain(note.title);
        expect(container.querySelector('[role="status"]')?.textContent).toBe(t('navigation.local_search_only'));
    });
});
