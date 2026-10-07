import { EditorSelection, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, type Panel, type ViewUpdate } from '@codemirror/view';
import { isolateHistory, undo } from '@codemirror/commands';
import { SearchQuery, closeSearchPanel, getSearchQuery, openSearchPanel, replaceAll, replaceNext, search, searchPanelOpen, setSearchQuery } from '@codemirror/search';
import { subscribeLocale, t, type MessageKey } from '../lib/i18n';
import { IS_MAC } from '../lib/hotkeys';

type SearchMode = 'find' | 'replace';
interface SearchRange { from: number; to: number }
interface SearchOptions {
    mode: SearchMode;
    scope: SearchRange | null;
    candidate: SearchRange | null;
}
const setOptions = StateEffect.define<Partial<SearchOptions>>();
const searchOptions = StateField.define<SearchOptions>({
    create: () => ({ mode: 'find', scope: null, candidate: null }),
    update(value, tr) {
        const map = (range: SearchRange | null) => range && ({
            from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(range.to, 1),
        });
        let next = tr.docChanged ? { ...value, scope: map(value.scope), candidate: map(value.candidate) } : value;
        for (const effect of tr.effects) if (effect.is(setOptions)) next = { ...next, ...effect.value };
        return next;
    },
});

function withinScope(_match: string, state: EditorState, from: number, to: number): boolean {
    const scope = state.field(searchOptions, false)?.scope;
    return !scope || (from >= scope.from && to <= scope.to);
}

function openPanel(view: EditorView, mode: SearchMode): boolean {
    const previous = getSearchQuery(view.state);
    const alreadyOpen = searchPanelOpen(view.state);
    const selection = view.state.selection.main;
    const selected = !alreadyOpen && !selection.empty && selection.to - selection.from <= 200
        ? view.state.sliceDoc(selection.from, selection.to) : '';
    openSearchPanel(view);
    view.dispatch({ effects: [
        setOptions.of({ mode, ...(!alreadyOpen ? { scope: null, candidate: selection.empty ? null : { from: selection.from, to: selection.to } } : {}) }),
        setSearchQuery.of(new SearchQuery({
            ...previous, search: selected || previous.search, regexp: selected ? false : previous.regexp,
            literal: selected ? true : previous.literal, test: withinScope,
        })),
    ] });
    const field = view.dom.querySelector<HTMLTextAreaElement>('[main-field]');
    field?.focus();
    field?.select();
    return true;
}

export const openFindPanel = (view: EditorView): boolean => openPanel(view, 'find');
export const openReplacePanel = (view: EditorView): boolean => openPanel(view, 'replace');

const searchPanels = new WeakMap<EditorView, NoteSearchPanel>();
const minimumPanelSize = { width: 320, height: 220 };
const panelSizes = new WeakMap<EditorView, { width: string; height: string }>();
const createNoteSearchPanel = (view: EditorView) => new NoteSearchPanel(view);
function moveMatch(view: EditorView, direction: number): boolean {
    if (!searchPanelOpen(view.state)) openFindPanel(view);
    searchPanels.get(view)?.navigate(direction);
    return true;
}

export function noteSearch(): Extension {
    return [searchOptions, search({ top: true, literal: true, createPanel: createNoteSearchPanel }), keymap.of([
        { key: 'F3', run: (view) => moveMatch(view, 1), shift: (view) => moveMatch(view, -1), preventDefault: true },
        { key: 'Mod-g', run: (view) => moveMatch(view, 1), shift: (view) => moveMatch(view, -1), preventDefault: true },
    ])];
}

interface Match extends SearchRange { precise: boolean }

class NoteSearchPanel implements Panel {
    readonly dom = document.createElement('section');
    readonly top = true;
    private readonly searchField = this.field('search', 'editor.search.find_placeholder');
    private readonly replaceField = this.field('replace', 'editor.search.replace_placeholder');
    private readonly findTab = this.button('find-tab', 'editor.search.find', () => this.setMode('find'));
    private readonly replaceTab = this.button('replace-tab', 'editor.search.replace', () => this.setMode('replace'));
    private readonly previous = this.button('previous', 'editor.search.previous', () => this.navigate(-1), 'up');
    private readonly next = this.button('next', 'editor.search.next', () => this.navigate(1), 'down');
    private readonly replaceButton = this.button('replace', 'editor.search.replace', () => this.replace(false));
    private readonly replaceAllButton = this.button('replace-all', 'editor.search.replace_all', () => this.replace(true));
    private readonly undoButton = this.button('undo-replace', 'editor.search.undo', () => {
        if (undo(this.view)) { this.feedback.textContent = t('editor.search.undone'); this.undoButton.hidden = true; }
    });
    private readonly close = this.button('close', 'editor.search.close', () => closeSearchPanel(this.view), 'close');
    private readonly resizeHandle = this.button('resize', 'editor.search.resize', () => {}, 'resize');
    private readonly count = document.createElement('span');
    private readonly feedback = document.createElement('span');
    private readonly context = document.createElement('span');
    private readonly options = document.createElement('div');
    private readonly replaceRow = document.createElement('div');
    private readonly results = document.createElement('details');
    private readonly resultsTitle = document.createElement('summary');
    private readonly resultsList = document.createElement('div');
    private readonly resultsLimit = document.createElement('p');
    private readonly caseField = this.checkbox('case', 'editor.search.match_case');
    private readonly wordField = this.checkbox('word', 'editor.search.whole_word');
    private readonly regexpField = this.checkbox('regexp', 'editor.search.regexp');
    private readonly escapesField = this.checkbox('escapes', 'editor.search.escapes');
    private readonly scopeField = this.checkbox('selection', 'editor.search.in_selection');
    private query: SearchQuery;
    private matches: Match[] = [];
    private resultButtons: HTMLButtonElement[] = [];
    private unsubscribe?: () => void;
    private resizeObserver?: ResizeObserver;
    private resizeCleanup?: () => void;
    private composing = false;

    constructor(private readonly view: EditorView) {
        searchPanels.set(view, this);
        this.query = getSearchQuery(view.state);
        this.dom.className = 'ink-note-search';
        this.dom.style.setProperty('--note-search-min-width', `${minimumPanelSize.width}px`);
        this.dom.style.setProperty('--note-search-min-height', `${minimumPanelSize.height}px`);
        const size = panelSizes.get(view);
        if (size) { this.dom.style.width = size.width; this.dom.style.height = size.height; }
        this.dom.setAttribute('aria-label', t('command.find_and_replace_in_this_note'));
        this.dom.addEventListener('keydown', (event) => this.keydown(event));
        const header = document.createElement('div');
        header.className = 'ink-note-search-header';
        const tabs = document.createElement('div');
        tabs.className = 'ink-note-search-tabs';
        for (const tab of [this.findTab, this.replaceTab]) tab.setAttribute('aria-pressed', 'false');
        tabs.append(this.findTab, this.replaceTab);
        this.context.className = 'ink-note-search-context';
        header.append(tabs, this.context, this.close);
        const findRow = document.createElement('div');
        findRow.className = 'ink-note-search-row';
        const navigation = document.createElement('div');
        navigation.className = 'ink-note-search-navigation';
        this.count.className = 'ink-note-search-count';
        navigation.append(this.count, this.previous, this.next);
        findRow.append(this.searchField, navigation);
        this.replaceRow.className = 'ink-note-search-row';
        const actions = document.createElement('div');
        actions.className = 'ink-note-search-actions';
        this.replaceAllButton.classList.add('ink-note-search-primary');
        actions.append(this.replaceButton, this.replaceAllButton);
        this.replaceRow.append(this.replaceField, actions);
        this.options.className = 'ink-note-search-options';
        this.options.append(...[this.caseField, this.wordField, this.regexpField, this.escapesField, this.scopeField].map((field) => field.parentElement!));
        const status = document.createElement('div');
        status.className = 'ink-note-search-status';
        this.feedback.setAttribute('role', 'status');
        this.feedback.setAttribute('aria-live', 'polite');
        this.feedback.setAttribute('aria-atomic', 'true');
        this.undoButton.hidden = true;
        status.append(this.feedback, this.undoButton);
        this.results.className = 'ink-note-search-results';
        this.results.open = true;
        this.resultsList.className = 'ink-note-search-result-list';
        this.resultsList.setAttribute('role', 'group');
        this.resultsLimit.className = 'ink-note-search-result-limit';
        this.results.append(this.resultsTitle, this.resultsList, this.resultsLimit);
        const body = document.createElement('div');
        body.className = 'ink-note-search-body';
        body.append(header, findRow, this.replaceRow, this.options, status, this.results);
        this.resizeHandle.className = 'ink-note-search-resize';
        this.resizeHandle.addEventListener('pointerdown', (event) => this.startResize(event));
        this.resizeHandle.addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            const size = this.currentSize();
            const step = event.shiftKey ? 40 : 10;
            this.applySize(size.width + (event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0),
                size.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0));
        });
        this.dom.append(body, this.resizeHandle);
        this.replaceField.addEventListener('input', () => this.commit(false));
        this.searchField.addEventListener('compositionstart', () => { this.composing = true; });
        this.searchField.addEventListener('compositionend', () => { this.composing = false; this.commit(true); });
        this.searchField.addEventListener('input', () => { if (!this.composing) this.commit(true); });
        this.scopeField.addEventListener('change', () => {
            const options = view.state.field(searchOptions);
            const selection = view.state.selection.main;
            const candidate = selection.empty ? options.candidate : { from: selection.from, to: selection.to };
            view.dispatch({ effects: [
                setOptions.of({ scope: this.scopeField.checked ? options.candidate ?? candidate : null }),
                setSearchQuery.of(new SearchQuery({ ...this.query, test: withinScope })),
            ] });
            this.selectFirst();
        });
        this.syncFields();
        this.refresh(true);
    }

    mount() {
        this.syncSize();
        this.resizeObserver = new ResizeObserver(() => this.syncSize());
        this.resizeObserver.observe(this.view.dom);
        this.resizeObserver.observe(this.dom);
        this.searchField.focus();
        this.searchField.select();
        this.unsubscribe = subscribeLocale(() => {
            for (const node of this.dom.querySelectorAll<HTMLElement>('[data-message]')) {
                const label = t(node.dataset.message as MessageKey);
                if (node instanceof HTMLTextAreaElement) { node.placeholder = label; node.setAttribute('aria-label', label); }
                else if (node.dataset.icon) { node.title = label; node.setAttribute('aria-label', label); }
                else node.textContent = label;
            }
            this.dom.setAttribute('aria-label', t('command.find_and_replace_in_this_note'));
            this.refresh(true);
        });
        queueMicrotask(() => {
            if (this.dom.isConnected && this.query.valid) this.selectFirst();
        });
    }

    destroy() {
        this.resizeCleanup?.();
        this.syncSize();
        this.unsubscribe?.();
        this.resizeObserver?.disconnect();
        if (searchPanels.get(this.view) === this) searchPanels.delete(this.view);
    }

    private currentSize() {
        const bounds = this.dom.getBoundingClientRect();
        return {
            width: bounds.width || parseFloat(this.dom.style.width) || minimumPanelSize.width,
            height: bounds.height || parseFloat(this.dom.style.height) || minimumPanelSize.height,
        };
    }

    private applySize(width: number, height: number) {
        const target = this.view.dom.ownerDocument.defaultView ?? window;
        const maxWidth = Math.max(1, (this.view.dom.clientWidth || target.innerWidth) - 24);
        const maxHeight = Math.max(1, (this.view.dom.clientHeight || target.innerHeight) - 24);
        this.dom.style.width = `${Math.min(maxWidth, Math.max(Math.min(minimumPanelSize.width, maxWidth), width))}px`;
        this.dom.style.height = `${Math.min(maxHeight, Math.max(Math.min(minimumPanelSize.height, maxHeight), height))}px`;
        this.syncSize();
    }

    private startResize(event: PointerEvent) {
        if (event.button !== 0 || event.isPrimary === false) return;
        event.preventDefault();
        this.resizeCleanup?.();
        const size = this.currentSize();
        const startX = event.clientX, startY = event.clientY, pointerId = event.pointerId;
        const target = this.view.dom.ownerDocument.defaultView ?? window;
        const move = (next: PointerEvent) => {
            if (next.pointerId !== pointerId) return;
            this.applySize(size.width + startX - next.clientX, size.height + next.clientY - startY);
        };
        const finish = (next: PointerEvent) => { if (next.pointerId === pointerId) this.resizeCleanup?.(); };
        this.resizeCleanup = () => {
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', finish);
            target.removeEventListener('pointercancel', finish);
            this.resizeHandle.removeEventListener('lostpointercapture', finish);
            if (this.resizeHandle.hasPointerCapture?.(pointerId)) this.resizeHandle.releasePointerCapture(pointerId);
            this.dom.classList.remove('is-resizing');
            this.resizeCleanup = undefined;
            this.syncSize();
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', finish);
        target.addEventListener('pointercancel', finish);
        this.resizeHandle.addEventListener('lostpointercapture', finish);
        this.resizeHandle.setPointerCapture?.(pointerId);
        this.dom.classList.add('is-resizing');
    }

    private syncSize() {
        const height = this.view.dom.clientHeight;
        if (height > 24) this.dom.style.setProperty('--note-search-max-height', `${height - 24}px`);
        const { width, height: panelHeight } = this.dom.style;
        if (width || panelHeight) panelSizes.set(this.view, { width, height: panelHeight });
    }

    update(update: ViewUpdate) {
        const query = getSearchQuery(update.state);
        const optionsChanged = update.state.field(searchOptions) !== update.startState.field(searchOptions);
        const queryChanged = !query.eq(this.query) || query.literal !== this.query.literal;
        this.query = query;
        if (queryChanged) this.syncFields();
        if (update.docChanged && !update.transactions.some((tr) => tr.isUserEvent('input.replace'))) this.undoButton.hidden = true;
        if (queryChanged || optionsChanged || update.docChanged) this.refresh(true);
        else if (update.selectionSet) this.refresh(false);
    }

    private field(name: string, message: MessageKey): HTMLTextAreaElement {
        const field = document.createElement('textarea');
        field.name = name;
        field.rows = 1;
        field.spellcheck = false;
        field.autocomplete = 'off';
        field.placeholder = t(message);
        field.setAttribute('aria-label', t(message));
        field.dataset.message = message;
        if (name === 'search') field.setAttribute('main-field', 'true');
        return field;
    }

    private button(name: string, message: MessageKey, action: () => void, icon?: 'up' | 'down' | 'close' | 'resize'): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.name = name;
        button.dataset.message = message;
        button.addEventListener('click', action);
        if (icon) {
            button.dataset.icon = icon;
            button.title = t(message);
            button.setAttribute('aria-label', t(message));
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('aria-hidden', 'true');
            const path = document.createElementNS(svg.namespaceURI, 'path');
            path.setAttribute('d', icon === 'up' ? 'm6 15 6-6 6 6' : icon === 'down' ? 'm6 9 6 6 6-6'
                : icon === 'resize' ? 'M4 9 15 20M4 14l6 6M4 19l1 1' : 'm6 6 12 12M6 18 18 6');
            svg.append(path);
            button.append(svg);
        } else button.textContent = t(message);
        return button;
    }

    private checkbox(name: string, message: MessageKey): HTMLInputElement {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = name;
        input.addEventListener('change', () => { if (name !== 'selection') this.commit(true); });
        const text = document.createElement('span');
        text.dataset.message = message;
        text.textContent = t(message);
        label.append(input, text);
        return input;
    }

    private setMode(mode: SearchMode) {
        this.view.dispatch({ effects: setOptions.of({ mode }) });
        this.searchField.focus();
        this.searchField.select();
    }

    private syncFields() {
        if (this.searchField.value !== this.query.search) this.searchField.value = this.query.search;
        if (this.replaceField.value !== this.query.replace) this.replaceField.value = this.query.replace;
        this.caseField.checked = this.query.caseSensitive;
        this.wordField.checked = this.query.wholeWord;
        this.regexpField.checked = this.query.regexp;
        this.escapesField.checked = !this.query.literal;
    }

    private commit(navigate: boolean) {
        this.feedback.textContent = '';
        this.undoButton.hidden = true;
        this.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({
            search: this.searchField.value, replace: this.replaceField.value,
            caseSensitive: this.caseField.checked, wholeWord: this.wordField.checked,
            regexp: this.regexpField.checked, literal: !this.escapesField.checked, test: withinScope,
        })) });
        if (navigate) this.selectFirst();
    }

    private selectFirst() {
        if (!this.matches.length) return;
        const selection = this.view.state.selection.main;
        const match = this.matches.find((match) => match.from >= selection.from) ?? this.matches[0];
        this.selectMatch(match);
    }

    private selectMatch(match: SearchRange) {
        this.view.dispatch({
            selection: EditorSelection.single(match.from, match.to),
            effects: EditorView.scrollIntoView(match.from, { y: 'center' }), userEvent: 'select.search',
        });
    }

    navigate(direction: number) {
        if (!this.matches.length) return;
        const selection = this.view.state.selection.main;
        const current = this.matches.findIndex((match) => match.from === selection.from && match.to === selection.to);
        const wrapped = direction > 0 ? current === this.matches.length - 1 : current === 0;
        const next = current >= 0 ? (current + direction + this.matches.length) % this.matches.length
            : direction > 0 ? this.matches.findIndex((match) => match.from >= selection.to)
            : this.matches.findLastIndex((match) => match.to <= selection.from);
        this.selectMatch(this.matches[next < 0 ? direction > 0 ? 0 : this.matches.length - 1 : next]);
        this.feedback.textContent = wrapped ? t(direction > 0 ? 'editor.search.wrapped_start' : 'editor.search.wrapped_end') : '';
    }

    private replace(all: boolean) {
        if (!this.query.valid || this.view.state.readOnly || !this.matches.length) return;
        const selection = this.view.state.selection.main;
        const current = this.matches.find((match) => match.from === selection.from && match.to === selection.to);
        if (!all && !current) { this.selectFirst(); return; }
        const count = all ? this.matches.filter((match) => match.precise).length : current?.precise ? 1 : 0;
        if (!count) { this.feedback.textContent = t('editor.search.imprecise'); return; }
        const before = this.view.state.doc;
        this.view.dispatch({ annotations: isolateHistory.of('before') });
        (all ? replaceAll : replaceNext)(this.view);
        if (!all && current && current.from === current.to && this.matches.length) {
            const replacedEnd = current.from + this.view.state.doc.length - before.length;
            const next = this.matches.find((match) => match.from > replacedEnd) ?? this.matches[0];
            this.selectMatch(next);
        }
        this.view.dispatch({ annotations: isolateHistory.of('after') });
        if (this.view.state.doc !== before) {
            this.feedback.textContent = t('editor.search.replaced', { count });
            this.undoButton.hidden = false;
        }
    }

    private refresh(rebuild: boolean) {
        const options = this.view.state.field(searchOptions);
        const replacing = options.mode === 'replace';
        this.dom.dataset.mode = options.mode;
        this.replaceRow.hidden = !replacing;
        this.findTab.setAttribute('aria-pressed', String(!replacing));
        this.replaceTab.setAttribute('aria-pressed', String(replacing));
        this.context.textContent = t(options.scope ? 'editor.search.selection_scope' : 'editor.search.note_scope');
        this.scopeField.checked = options.scope !== null;
        this.scopeField.disabled = !options.scope && !options.candidate && this.view.state.selection.main.empty;
        this.scopeField.parentElement!.title = t('editor.search.selection_hint');
        this.escapesField.disabled = this.query.regexp;
        const invalid = !!this.query.search && !this.query.valid;
        this.searchField.setAttribute('aria-invalid', String(invalid));
        this.replaceField.disabled = this.view.state.readOnly;
        this.replaceTab.disabled = this.view.state.readOnly;
        if (rebuild) {
            this.matches = [];
            if (this.query.valid) {
                const cursor = this.query.getCursor(this.view.state);
                for (let item = cursor.next(); !item.done; item = cursor.next()) {
                    const value = item.value as SearchRange & { precise?: boolean };
                    this.matches.push({ from: value.from, to: value.to, precise: value.precise !== false });
                }
            }
            this.renderResults();
            this.feedback.textContent = invalid ? t('editor.search.invalid_regexp')
                : !this.query.search ? t('editor.search.start_hint')
                : !this.matches.length ? t('editor.search.no_matches') : '';
        }
        const selection = this.view.state.selection.main;
        const index = this.matches.findIndex((match) => match.from === selection.from && match.to === selection.to);
        this.count.textContent = this.matches.length ? t('editor.search.count', { current: index + 1, total: this.matches.length }) : '';
        this.count.setAttribute('aria-label', t('editor.search.match_count', { count: this.matches.length }));
        this.previous.disabled = this.next.disabled = !this.matches.length;
        this.replaceButton.disabled = this.replaceAllButton.disabled = this.view.state.readOnly || !this.matches.some((match) => match.precise);
        this.results.hidden = !this.matches.length;
        this.resultsTitle.textContent = t('editor.search.match_count', { count: this.matches.length });
        this.resultsList.setAttribute('aria-label', t('editor.search.results'));
        for (const [i, button] of this.resultButtons.entries()) button.setAttribute('aria-current', String(i === index));
        if (!rebuild && this.results.open && index >= 0 && index < this.resultButtons.length) {
            const button = this.resultButtons[index];
            if (typeof button.scrollIntoView === 'function') button.scrollIntoView({ block: 'nearest' });
        }
    }

    private renderResults() {
        const fragment = document.createDocumentFragment();
        this.resultButtons = this.matches.slice(0, 100).map((match) => {
            const line = this.view.state.doc.lineAt(match.from);
            const start = Math.max(line.from, match.from - 35);
            const end = Math.min(this.view.state.doc.length, Math.max(match.to, Math.min(line.to, match.to + 65)));
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ink-note-search-result';
            button.addEventListener('click', () => this.selectMatch(match));
            const lineNumber = document.createElement('span');
            lineNumber.className = 'ink-note-search-line';
            lineNumber.textContent = String(line.number);
            const snippet = document.createElement('span');
            snippet.className = 'ink-note-search-snippet';
            const marked = document.createElement('mark');
            marked.textContent = this.view.state.sliceDoc(match.from, Math.min(match.to, match.from + 120)) || t('editor.search.empty_match');
            snippet.append((start > line.from ? '…' : '') + this.view.state.sliceDoc(start, match.from), marked,
                this.view.state.sliceDoc(match.to, Math.min(end, match.to + 65)) + (end < line.to ? '…' : ''));
            button.setAttribute('aria-label', t('editor.search.result_line', { line: line.number }) + ': ' + snippet.textContent);
            button.append(lineNumber, snippet);
            fragment.append(button);
            return button;
        });
        this.resultsList.replaceChildren(fragment);
        this.resultsLimit.hidden = this.matches.length <= 100;
        this.resultsLimit.textContent = t('editor.search.results_limit', { count: 100 });
    }

    private keydown(event: KeyboardEvent) {
        if (event.isComposing || this.composing || event.keyCode === 229) return;
        const mod = IS_MAC ? event.metaKey : event.ctrlKey;
        const key = event.key.toLowerCase();
        let handled = true;
        if (mod && !event.altKey && (key === 'f' || key === 'h')) this.setMode(key === 'h' ? 'replace' : 'find');
        else if (key === 'escape') closeSearchPanel(this.view);
        else if (key === 'f3' || (mod && key === 'g')) this.navigate(event.shiftKey ? -1 : 1);
        else if (key === 'enter' && (event.target === this.searchField || event.target === this.replaceField)) {
            if (event.target === this.replaceField && !event.shiftKey) this.replace(false);
            else this.navigate(event.shiftKey ? -1 : 1);
        } else handled = false;
        if (handled) { event.preventDefault(); event.stopPropagation(); }
    }
}
