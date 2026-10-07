import { EditorSelection, EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { closeSearchPanel, getSearchQuery, searchPanelOpen } from '@codemirror/search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n, setLocaleAsync, t } from '../lib/i18n';
import { IS_MAC } from '../lib/hotkeys';
import { editorKeymap } from './shortcuts';
import { noteSearch, openFindPanel, openReplacePanel } from './search';
import { livePreview } from './live-preview';

let view: EditorView;
let resizeObservers: { callback: () => void; targets: Element[]; disconnected: boolean }[];
const originalClientRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
const originalBoundingRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
beforeEach(async () => {
    await initI18n();
    await setLocaleAsync('en-US', false);
    resizeObservers = [];
    vi.stubGlobal('ResizeObserver', class {
        targets: Element[] = [];
        disconnected = false;
        constructor(readonly callback: () => void) { resizeObservers.push(this); }
        observe(target: Element) { this.targets.push(target); }
        disconnect() { this.disconnected = true; }
    });
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
});
afterEach(() => {
    view?.destroy(); view?.dom.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    if (originalClientRects) Object.defineProperty(Range.prototype, 'getClientRects', originalClientRects);
    else Reflect.deleteProperty(Range.prototype, 'getClientRects');
    if (originalBoundingRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalBoundingRect);
    else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
});

function editor(doc: string, selection?: [number, number], live = false) {
    view = new EditorView({ parent: document.body, state: EditorState.create({
        doc, selection: selection ? EditorSelection.range(...selection) : undefined,
        extensions: [history(), noteSearch(), keymap.of(editorKeymap), ...(live ? [livePreview(() => {})] : [])],
    }) });
    openFindPanel(view);
    return view;
}
function field(name: string) { return view.dom.querySelector<HTMLTextAreaElement>(`textarea[name="${name}"]`)!; }
function button(name: string) { return view.dom.querySelector<HTMLButtonElement>(`button[name="${name}"]`)!; }
function checkbox(name: string) { return view.dom.querySelector<HTMLInputElement>(`input[name="${name}"]`)!; }
function enter(name: string, value: string) { field(name).value = value; field(name).dispatchEvent(new Event('input', { bubbles: true })); }
function status() { return view.dom.querySelector('[role="status"]')!.textContent; }
function count() { return view.dom.querySelector('.ink-note-search-count')!.textContent; }
function press(target: HTMLElement, key: string, options: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event;
}
function pointer(target: EventTarget, type: string, x: number, y: number, pointerId = 1) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    target.dispatchEvent(event);
}

describe('note find and replace', () => {
    it('expands leftwards and downwards from the minimum size, then clamps shrinkage and editor bounds', () => {
        editor('cat cat');
        Object.defineProperty(view.dom, 'clientWidth', { configurable: true, value: 600 });
        Object.defineProperty(view.dom, 'clientHeight', { configurable: true, value: 500 });
        const panel = view.dom.querySelector<HTMLElement>('.ink-note-search')!;
        pointer(button('resize'), 'pointerdown', 300, 220);
        pointer(window, 'pointermove', 220, 280);
        expect(panel.style.width).toBe('400px');
        expect(panel.style.height).toBe('280px');
        pointer(window, 'pointermove', 420, 160);
        expect(panel.style.width).toBe('320px');
        expect(panel.style.height).toBe('220px');
        pointer(window, 'pointermove', -400, 900);
        expect(panel.style.width).toBe('576px');
        expect(panel.style.height).toBe('476px');
        pointer(window, 'pointerup', -400, 900);
        expect(panel.classList.contains('is-resizing')).toBe(false);
        expect(view.state.doc.toString()).toBe('cat cat');
    });

    it('ignores other pointers and stops resizing after cancellation or closing', () => {
        editor('cat cat');
        const panel = view.dom.querySelector<HTMLElement>('.ink-note-search')!;
        pointer(button('resize'), 'pointerdown', 300, 220);
        pointer(window, 'pointermove', 200, 280, 2);
        expect(panel.style.width).toBe('');
        pointer(window, 'pointermove', 200, 280);
        expect(panel.style.width).toBe('420px');
        pointer(window, 'pointercancel', 200, 280);
        pointer(window, 'pointermove', 100, 380);
        expect(panel.style.width).toBe('420px');
        pointer(button('resize'), 'pointerdown', 200, 280);
        closeSearchPanel(view);
        pointer(window, 'pointermove', 100, 380);
        expect(panel.style.width).toBe('420px');
        expect(panel.classList.contains('is-resizing')).toBe(false);
    });

    it('resizes with arrow keys using the same minimum and directions as dragging', () => {
        editor('cat cat');
        const panel = view.dom.querySelector<HTMLElement>('.ink-note-search')!;
        press(button('resize'), 'ArrowLeft');
        press(button('resize'), 'ArrowDown');
        expect(panel.style.width).toBe('330px');
        expect(panel.style.height).toBe('230px');
        press(button('resize'), 'ArrowRight', { shiftKey: true });
        press(button('resize'), 'ArrowUp', { shiftKey: true });
        expect(panel.style.width).toBe('320px');
        expect(panel.style.height).toBe('220px');
    });

    it('preserves manual window dimensions across modes and reopening without changing the document', () => {
        editor('cat cat');
        enter('search', 'cat');
        const panel = view.dom.querySelector<HTMLElement>('.ink-note-search')!;
        panel.style.width = '600px';
        panel.style.height = '450px';
        openReplacePanel(view);
        expect(panel.style.width).toBe('600px');
        expect(panel.style.height).toBe('450px');
        closeSearchPanel(view);
        view.dispatch({ selection: EditorSelection.cursor(0) });
        openFindPanel(view);
        const reopened = view.dom.querySelector<HTMLElement>('.ink-note-search')!;
        expect(reopened.style.width).toBe('600px');
        expect(reopened.style.height).toBe('450px');
        expect(field('search').value).toBe('cat');
        expect(view.state.doc.toString()).toBe('cat cat');
    });

    it('updates the floating window height limit when the editor shrinks and stops observing after close', () => {
        editor('cat cat');
        const panel = view.dom.querySelector<HTMLElement>('.ink-note-search')!;
        const observer = resizeObservers.find((item) => item.targets.includes(panel))!;
        Object.defineProperty(view.dom, 'clientHeight', { configurable: true, value: 600 });
        observer.callback();
        expect(panel.style.getPropertyValue('--note-search-max-height')).toBe('576px');
        Object.defineProperty(view.dom, 'clientHeight', { configurable: true, value: 320 });
        observer.callback();
        expect(panel.style.getPropertyValue('--note-search-max-height')).toBe('296px');
        closeSearchPanel(view);
        expect(observer.disconnected).toBe(true);
    });

    it('finds immediately, lists safe snippets, navigates and wraps without losing input focus', () => {
        editor('one Alpha\ntwo alpha\n<img src=x onerror=alert(1)> alpha');
        enter('search', 'alpha');
        expect(count()).toBe('1 / 3');
        expect(view.state.selection.main.from).toBe(4);
        expect(view.dom.querySelectorAll('.ink-note-search-result')).toHaveLength(3);
        expect(view.dom.querySelector('.ink-note-search-results img')).toBeNull();
        press(field('search'), 'Enter');
        expect(count()).toBe('2 / 3');
        expect(document.activeElement).toBe(field('search'));
        press(field('search'), 'Enter', { shiftKey: true });
        expect(count()).toBe('1 / 3');
        press(field('search'), 'Enter', { shiftKey: true });
        expect(count()).toBe('3 / 3');
        expect(status()).toBe(t('editor.search.wrapped_end'));
        button('next').click();
        expect(count()).toBe('1 / 3');
        expect(status()).toBe(t('editor.search.wrapped_start'));
        const result = view.dom.querySelectorAll<HTMLButtonElement>('.ink-note-search-result')[1];
        result.click();
        expect(count()).toBe('2 / 3');
        press(field('search'), 'Escape');
        expect(searchPanelOpen(view.state)).toBe(false);
        expect(view.hasFocus).toBe(true);
    });

    it('filters case and whole words, reports empty results and invalid patterns', () => {
        editor('cat Cat scatter cat_ cat');
        enter('search', 'cat');
        expect(count()).toBe('1 / 5');
        checkbox('word').click();
        expect(count()).toBe('1 / 3');
        checkbox('case').click();
        expect(count()).toBe('1 / 2');
        enter('search', 'missing');
        expect(status()).toBe(t('editor.search.no_matches'));
        expect(button('next').disabled).toBe(true);
        checkbox('regexp').click();
        enter('search', '[');
        expect(status()).toBe(t('editor.search.invalid_regexp'));
        expect(field('search').getAttribute('aria-invalid')).toBe('true');
        expect(button('replace-all').disabled).toBe(true);
    });

    it('keeps paths literal by default and supports optional escapes and multiline text', () => {
        editor('C:\\new\\test\nline\nnext\tend');
        enter('search', 'C:\\new\\test');
        expect(count()).toBe('1 / 1');
        enter('search', 'line\\nnext\\t');
        expect(count()).toBe('');
        checkbox('escapes').click();
        expect(count()).toBe('1 / 1');
        checkbox('escapes').click();
        enter('search', 'line\nnext\t');
        expect(count()).toBe('1 / 1');
    });

    it('prefills selected text and retains replacements and options when reopened', async () => {
        editor('Alpha Alpha', [0, 5]);
        await Promise.resolve();
        expect(field('search').value).toBe('Alpha');
        openReplacePanel(view);
        expect(view.dom.querySelector<HTMLElement>('.ink-note-search-row:has(textarea[name="replace"])')!.hidden).toBe(false);
        enter('replace', 'Beta');
        checkbox('case').click();
        closeSearchPanel(view);
        view.dispatch({ selection: EditorSelection.cursor(0) });
        openReplacePanel(view);
        expect(field('replace').value).toBe('Beta');
        expect(checkbox('case').checked).toBe(true);
        expect(document.activeElement).toBe(field('search'));
    });

    it('replaces the current match then advances, with a single undo for replace all', () => {
        editor('cat cat cat');
        openReplacePanel(view);
        enter('search', 'cat');
        enter('replace', 'dog');
        button('replace').click();
        expect(view.state.doc.toString()).toBe('dog cat cat');
        expect(view.state.selection.main.from).toBe(4);
        expect(status()).toBe(t('editor.search.replaced', { count: 1 }));
        button('replace-all').click();
        expect(view.state.doc.toString()).toBe('dog dog dog');
        expect(status()).toBe(t('editor.search.replaced', { count: 2 }));
        button('undo-replace').click();
        expect(view.state.doc.toString()).toBe('dog cat cat');
        expect(undo(view)).toBe(true);
        expect(view.state.doc.toString()).toBe('cat cat cat');
    });

    it('isolates replacement undo from preceding typing and supports an empty replacement', () => {
        editor('cat cat');
        view.dispatch({ changes: { from: 7, insert: '!' }, userEvent: 'input.type' });
        openReplacePanel(view);
        enter('search', 'cat');
        button('replace-all').click();
        expect(view.state.doc.toString()).toBe(' !');
        button('undo-replace').click();
        expect(view.state.doc.toString()).toBe('cat cat!');
        undo(view);
        expect(view.state.doc.toString()).toBe('cat cat');
    });

    it('limits navigation and replacement to the original selection and maps its boundaries through undo', () => {
        editor('cat cat cat cat', [4, 11]);
        enter('search', 'cat');
        checkbox('selection').click();
        expect(count()).toBe('1 / 2');
        openReplacePanel(view);
        enter('replace', 'kitten');
        button('replace-all').click();
        expect(view.state.doc.toString()).toBe('cat kitten kitten cat');
        enter('search', 'kitten');
        expect(count()).toBe('1 / 2');
        undo(view);
        enter('search', 'cat');
        expect(count()).toBe('1 / 2');
        button('previous').click();
        expect(view.state.selection.main.from).toBe(8);
        enter('replace', '');
        button('replace-all').click();
        expect(view.state.doc.toString()).toBe('cat   cat');
        expect(count()).toBe('');
        expect(button('replace-all').disabled).toBe(true);
    });

    it('supports regex groups and traverses zero-width matches without getting stuck', () => {
        editor('cat-1 cat-2');
        checkbox('regexp').click();
        enter('search', 'cat-(\\d)');
        openReplacePanel(view);
        enter('replace', 'dog-$1');
        button('replace-all').click();
        expect(view.state.doc.toString()).toBe('dog-1 dog-2');
        enter('search', '(?=dog)');
        expect(count()).toBe('1 / 2');
        button('next').click();
        expect(count()).toBe('2 / 2');
        button('next').click();
        expect(count()).toBe('1 / 2');
        enter('replace', '>');
        button('replace-all').click();
        expect(view.state.doc.toString()).toBe('>dog-1 >dog-2');
    });

    it('advances after each single zero-width replacement and wraps to the first match', () => {
        editor('dog dog');
        checkbox('regexp').click();
        enter('search', '(?=dog)');
        openReplacePanel(view);
        enter('replace', '>');
        button('replace').click();
        expect(view.state.doc.toString()).toBe('>dog dog');
        expect(view.state.selection.main.from).toBe(5);
        expect(view.state.selection.main.empty).toBe(true);
        expect(count()).toBe('2 / 2');
        button('replace').click();
        expect(view.state.doc.toString()).toBe('>dog >dog');
        expect(view.state.selection.main.from).toBe(1);
        expect(count()).toBe('1 / 2');
        button('undo-replace').click();
        expect(view.state.doc.toString()).toBe('>dog dog');
        undo(view);
        expect(view.state.doc.toString()).toBe('dog dog');
    });

    it('advances zero-width matches with an empty replacement using Enter', () => {
        editor('dog dog');
        checkbox('regexp').click();
        enter('search', '(?=dog)');
        openReplacePanel(view);
        press(field('replace'), 'Enter');
        expect(view.state.selection.main.from).toBe(4);
        expect(count()).toBe('2 / 2');
        press(field('replace'), 'Enter');
        expect(view.state.selection.main.from).toBe(0);
        expect(count()).toBe('1 / 2');
        expect(view.state.doc.toString()).toBe('dog dog');
    });

    it('keeps single zero-width replacement navigation inside the mapped selection', () => {
        editor('dog dog dog dog', [4, 11]);
        checkbox('regexp').click();
        enter('search', '(?=dog)');
        checkbox('selection').click();
        openReplacePanel(view);
        enter('replace', '>');
        view.dom.querySelector<HTMLButtonElement>('.ink-note-search-result')!.click();
        button('replace').click();
        expect(view.state.doc.toString()).toBe('dog >dog dog dog');
        expect(view.state.selection.main.from).toBe(9);
        expect(count()).toBe('2 / 2');
        button('replace').click();
        expect(view.state.doc.toString()).toBe('dog >dog >dog dog');
        expect(view.state.selection.main.from).toBe(5);
        expect(count()).toBe('1 / 2');
    });

    it('ignores composing Enter and only commits completed IME input', () => {
        editor('\u4e2d\u6587 \u4e2d\u6587');
        const input = field('search');
        input.dispatchEvent(new CompositionEvent('compositionstart'));
        enter('search', '\u4e2d');
        expect(getSearchQuery(view.state).search).toBe('');
        expect(press(input, 'Enter', { isComposing: true }).defaultPrevented).toBe(false);
        enter('search', '\u4e2d\u6587');
        input.dispatchEvent(new CompositionEvent('compositionend'));
        expect(count()).toBe('1 / 2');
        expect(getSearchQuery(view.state).search).toBe('\u4e2d\u6587');
    });

    it('caps rendered snippets while counting and navigating every result', () => {
        editor('cat '.repeat(140));
        enter('search', 'cat');
        expect(view.dom.querySelectorAll('.ink-note-search-result')).toHaveLength(100);
        expect(count()).toBe('1 / 140');
        button('previous').click();
        expect(count()).toBe('140 / 140');
        expect(view.state.selection.main.from).toBe(556);
    });

    it('opens replace through the editor shortcut and switches modes from its fields', () => {
        editor('cat cat');
        closeSearchPanel(view);
        const mod = IS_MAC ? { metaKey: true } : { ctrlKey: true };
        expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', keyCode: 72, ...mod }), 'editor')).toBe(true);
        expect(button('replace-tab').getAttribute('aria-pressed')).toBe('true');
        press(field('search'), 'f', mod);
        expect(button('find-tab').getAttribute('aria-pressed')).toBe('true');
        enter('search', 'cat');
        expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'F3', code: 'F3', keyCode: 114 }), 'editor')).toBe(true);
        expect(count()).toBe('2 / 2');
    });

    it('reveals live-preview source for highlighting and restores rendering when closed', () => {
        editor('# Heading\n\ncat **cat**\n\ncat', undefined, true);
        enter('search', 'cat');
        expect(count()).toBe('1 / 3');
        expect(view.dom.querySelector('.cm-live-block')).toBeNull();
        closeSearchPanel(view);
        expect(view.dom.querySelector('.cm-live-block')).not.toBeNull();
        expect(view.state.doc.toString()).toBe('# Heading\n\ncat **cat**\n\ncat');
    });

    it('updates visible labels when the language changes without discarding the query', async () => {
        editor('cat cat');
        enter('search', 'cat');
        await setLocaleAsync('zh-CN', false);
        expect(button('find-tab').textContent).toBe(t('editor.search.find'));
        expect(field('search').value).toBe('cat');
        expect(view.dom.querySelector('summary')!.textContent).toBe(t('editor.search.match_count', { count: 2 }));
        await setLocaleAsync('en-US', false);
    });
});
