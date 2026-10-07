import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { parseWikiTarget, renderMarkdownBlocks, type Heading, type MarkdownBlock } from '../lib/markdown/renderer';
import { enhancePreview, renderPendingMermaid, toggleCodeBlockCollapse } from '../lib/markdown/enhance';
import { resolveNoteEmbeds } from '../lib/markdown/embeds';
import { useSession } from '../store/session';
import { t } from '../lib/i18n';
import { decodeDataValue } from '../lib/markdown/data-attr';
import { findNoteByTitle, useNotes } from '../store/notes';
import { useUi } from '../store/ui';
import { selectMarkdownTab, moveMarkdownTabFocus } from '../features/preview/markdown-tabs';
import { computeLiveDecorations, type LiveDecorations } from './live-markers';

const focusChanged = StateEffect.define<boolean>();
const refresh = StateEffect.define<boolean>();

class RenderedBlock extends WidgetType {
    constructor(readonly block: MarkdownBlock, readonly source: string, readonly revision: number, readonly title: string) { super(); }
    eq(other: RenderedBlock) {
        return this.block.html === other.block.html && this.block.startLine === other.block.startLine
            && this.block.endLine === other.block.endLine && this.revision === other.revision && this.title === other.title
            && (!this.block.html.includes('data-embed-target') || this.source === other.source);
    }
    toDOM(view: EditorView) {
        const host = document.createElement('div');
        host.className = 'ink-prose cm-live-block';
        host.dataset.font = useSession.getState().settings.appearance.proseFont;
        host.innerHTML = this.block.html;
        host.title = t('workspace.live_preview_hint');
        let alive = true;
        const observer = new ResizeObserver(() => view.requestMeasure());
        observer.observe(host);
        cleanup.set(host, () => { alive = false; observer.disconnect(); });
        const settings = useSession.getState().settings.preview;
        const dark = document.documentElement.dataset.theme === 'dark';
        const prepare = async () => {
            await resolveNoteEmbeds(host, { currentContent: this.source, currentTitle: this.title, isCurrent: () => alive });
            if (!alive) return;
            await enhancePreview(host, { math: settings.math, mermaid: settings.mermaid, dark, codeBlockCollapseLines: 0 });
            if (alive && settings.mermaid) await renderPendingMermaid(host, dark, { isCurrent: () => alive });
            if (alive) view.requestMeasure();
        };
        void prepare().catch(() => { if (alive) view.requestMeasure(); });
        host.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            const checkbox = target.closest<HTMLInputElement>('input[data-task-line]');
            if (checkbox) {
                if (checkbox.disabled || checkbox.closest('.note-embed-body')) return;
                const n = Number(checkbox.dataset.taskLine) + 1;
                if (n > 0 && n <= view.state.doc.lines) {
                    const line = view.state.doc.line(n);
                    const match = /^(?:\s*>\s*)*\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]/.exec(line.text);
                    if (match) {
                        const pos = line.from + match[0].length - 2;
                        view.dispatch({ changes: { from: pos, to: pos + 1, insert: match[1] === ' ' ? 'x' : ' ' }, userEvent: 'input' });
                    }
                }
                return;
            }
            const collapse = target.closest<HTMLButtonElement>('[data-code-collapse]');
            if (collapse) { toggleCodeBlockCollapse(collapse); return; }
            const tab = target.closest<HTMLButtonElement>('[data-tab-button]');
            if (tab) { event.preventDefault(); selectMarkdownTab(tab); return; }
            const copy = target.closest<HTMLButtonElement>('[data-copy]');
            if (copy) {
                event.preventDefault();
                const code = copy.closest('.code-block')?.querySelector('pre')?.textContent ?? '';
                void navigator.clipboard?.writeText(code).then(() => useUi.getState().toast({ title: t('common.copied') }))
                    .catch(() => useUi.getState().toast({ title: t('preview.could_not_copy'), tone: 'danger' }));
                return;
            }
            if (target.closest('summary')) return;
            const wiki = target.closest<HTMLElement>('[data-wikilink]');
            if (wiki && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                const parsed = parseWikiTarget(decodeDataValue(wiki.dataset.wikilink));
                const note = findNoteByTitle(parsed.noteTitle);
                if (note) void useNotes.getState().openNote(note.id);
                else if (parsed.noteTitle) void useNotes.getState().createNote({ title: parsed.noteTitle });
                return;
            }
            if ((event.metaKey || event.ctrlKey) && target.closest('a[href]')) return;
            event.preventDefault();
            // Preserve the source line under the pointer, including rows inside tables/lists.
            const mapped = target.closest<HTMLElement>('[data-line]');
            const n = Math.max(this.block.startLine + 1, Math.min(this.block.endLine, Number(mapped?.dataset.line ?? this.block.startLine) + 1));
            const line = view.state.doc.line(Math.min(n, view.state.doc.lines));
            view.dispatch({ selection: { anchor: line.from }, effects: focusChanged.of(true), userEvent: 'select.pointer' });
            view.focus();
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos !== null && pos >= line.from && pos <= view.state.doc.line(Math.min(this.block.endLine, view.state.doc.lines)).to)
                view.dispatch({ selection: { anchor: pos }, userEvent: 'select.pointer' });
        });
        host.addEventListener('keydown', (event) => {
            const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tab-button]');
            if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); moveMarkdownTabFocus(tab, event.key); }
        });
        return host;
    }
    destroy(dom: HTMLElement) { cleanup.get(dom)?.(); cleanup.delete(dom); }
    ignoreEvent() { return true; }
}
const cleanup = new WeakMap<HTMLElement, () => void>();

class MarkerWidget extends WidgetType {
    constructor(readonly marker: string, readonly ordered: boolean) { super(); }
    eq(other: MarkerWidget) { return other.marker === this.marker && other.ordered === this.ordered; }
    toDOM() {
        const span = document.createElement('span');
        span.className = 'cm-live-marker';
        span.textContent = this.ordered ? `${this.marker} ` : '\u2022';
        span.setAttribute('aria-hidden', 'true');
        return span;
    }
}

class CheckboxWidget extends WidgetType {
    constructor(readonly checked: boolean) { super(); }
    eq(other: CheckboxWidget) { return other.checked === this.checked; }
    toDOM() {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'cm-live-checkbox';
        input.checked = this.checked;
        input.setAttribute('data-task-toggle', '');
        input.setAttribute('aria-label', this.checked ? t('markdown.mark_incomplete') : t('markdown.mark_complete'));
        return input;
    }
    ignoreEvent() { return false; }
}

class RuleWidget extends WidgetType {
    eq() { return true; }
    toDOM() {
        const rule = document.createElement('div');
        rule.className = 'cm-live-rule';
        rule.setAttribute('aria-hidden', 'true');
        return rule;
    }
}

class ImageWidget extends WidgetType {
    constructor(readonly src: string, readonly alt: string) { super(); }
    eq(other: ImageWidget) { return other.src === this.src && other.alt === this.alt; }
    toDOM() {
        const image = document.createElement('img');
        image.className = 'cm-live-image';
        image.src = this.src;
        image.alt = this.alt;
        image.loading = 'lazy';
        return image;
    }
    ignoreEvent() { return false; }
}

interface LiveState {
    blocks: MarkdownBlock[];
    headings: Heading[];
    source: string;
    title: string;
    revision: number;
    focused: boolean;
}

function widgetFor(decoration: LiveDecorations['replaces'][number]): WidgetType {
    switch (decoration.kind) {
        case 'ordered':
        case 'bullet': return new MarkerWidget(decoration.marker ?? '-', decoration.kind === 'ordered');
        case 'checkbox': return new CheckboxWidget(decoration.checked === true);
        case 'rule': return new RuleWidget();
        case 'image': return new ImageWidget(decoration.src ?? '', decoration.alt ?? '');
    }
}

interface Taken { from: number; to: number }

function overlapsTaken(taken: Taken[], from: number, to: number): boolean {
    return taken.some((range) => range.from < to && range.to > from);
}

function buildDecorations(state: EditorState, live: LiveState, viewport: { from: number; to: number }, caretLines: Set<number>): DecorationSet {
    const doc = state.doc;
    const geometry = computeLiveDecorations(doc, syntaxTree(state), caretLines, viewport);
    const builder: RangeSetBuilder<Decoration> = new RangeSetBuilder<Decoration>();
    const contributions: { from: number; to: number; decoration: Decoration }[] = [];
    const taken: Taken[] = [];

    const blocksByLine = new Map(live.blocks.map((block) => [block.startLine, block]));

    for (const opaque of geometry.opaque) {
        const firstLine = doc.lineAt(opaque.from).number;
        const lastLine = doc.lineAt(Math.min(opaque.to, doc.length)).number;
        let active = false;
        for (let line = firstLine; line <= lastLine; line += 1) if (caretLines.has(line)) { active = true; break; }
        if (active) continue;
        const block = blocksByLine.get(firstLine - 1);
        if (!block) continue;
        const from = doc.line(firstLine).from;
        const to = doc.line(Math.min(block.endLine, doc.lines)).to;
        if (overlapsTaken(taken, from, to)) continue;
        taken.push({ from, to });
        contributions.push({ from, to, decoration: Decoration.replace({ block: true, widget: new RenderedBlock(block, live.source, live.revision, live.title) }) });
    }

    for (const range of geometry.hide) {
        if (range.to <= range.from || overlapsTaken(taken, range.from, range.to)) continue;
        taken.push({ from: range.from, to: range.to });
        contributions.push({ from: range.from, to: range.to, decoration: Decoration.replace({}) });
    }
    for (const replace of geometry.replaces) {
        if (replace.to <= replace.from || overlapsTaken(taken, replace.from, replace.to)) continue;
        taken.push({ from: replace.from, to: replace.to });
        contributions.push({
            from: replace.from,
            to: replace.to,
            decoration: Decoration.replace({ widget: widgetFor(replace) }),
        });
    }
    for (const mark of geometry.marks) {
        if (mark.to <= mark.from) continue;
        contributions.push({ from: mark.from, to: mark.to, decoration: Decoration.mark({ class: mark.className }) });
    }
    const lineSeen = new Set<number>();
    for (const line of geometry.lines) {
        if (lineSeen.has(line.line) || line.line > doc.lines) continue;
        lineSeen.add(line.line);
        contributions.push({ from: doc.line(line.line).from, to: doc.line(line.line).from, decoration: Decoration.line({ class: line.classes }) });
    }

    contributions.sort((a, b) => a.from - b.from || a.to - b.to);
    for (const contribution of contributions) builder.add(contribution.from, contribution.to, contribution.decoration);
    return builder.finish();
}

/** Decorations change presentation only; all editing, undo, search and saving use Markdown. */
export function livePreview(onHeadings: (headings: Heading[]) => void, getTitle: () => string = () => ''): Extension {
    const field = StateField.define<LiveState>({
        create(state) {
            const result = renderMarkdownBlocks(state.doc.toString());
            return { ...result, source: state.doc.toString(), title: getTitle(), revision: 0, focused: false };
        },
        update(value, transaction) {
            const focused = transaction.effects.find((effect) => effect.is(focusChanged));
            const refreshed = transaction.effects.find((effect) => effect.is(refresh));
            if (!transaction.docChanged && !focused && !refreshed) return value;
            return {
                ...value,
                ...(refreshed ? renderMarkdownBlocks(transaction.state.doc.toString()) : {}),
                source: transaction.state.doc.toString(),
                title: getTitle(),
                revision: value.revision + (refreshed?.value ? 1 : 0),
                focused: focused ? focused.value : value.focused,
            };
        },
    });
    return [field, ViewPlugin.fromClass(class {
        decorations: DecorationSet = Decoration.none;
        timer = 0;
        parseTimer = 0;
        observer: MutationObserver;
        unsubscribe: () => void;
        constructor(readonly view: EditorView) {
            const refreshView = () => {
                window.clearTimeout(this.timer);
                this.timer = window.setTimeout(() => view.dispatch({ effects: refresh.of(true) }), 0);
            };
            this.observer = new MutationObserver(refreshView);
            this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'lang'] });
            this.unsubscribe = useSession.subscribe((state, previous) => {
                if (state.settings.preview !== previous.settings.preview || state.settings.appearance !== previous.settings.appearance) refreshView();
            });
            this.build(view);
            queueMicrotask(() => { const value = view.state.field(field, false); if (value) onHeadings(value.headings); });
        }
        build(view: EditorView) {
            const state = view.state;
            const caretLines = new Set<number>();
            for (const range of state.selection.ranges) {
                caretLines.add(state.doc.lineAt(range.from).number);
                caretLines.add(state.doc.lineAt(range.to).number);
            }
            const visible = view.visibleRanges;
            const from = visible.length ? visible[0]!.from : 0;
            const to = visible.length ? visible[visible.length - 1]!.to : state.doc.length;
            this.decorations = buildDecorations(state, state.field(field), { from, to }, caretLines);
        }
        update(update: { docChanged: boolean; selectionSet: boolean; viewportChanged: boolean; state: EditorState; startState: EditorState; view: EditorView }) {
            if (update.docChanged) {
                clearTimeout(this.parseTimer);
                this.parseTimer = window.setTimeout(() => this.view.dispatch({ effects: refresh.of(false) }), 90);
            }
            const markersChanged = update.startState.field(field) !== update.state.field(field);
            if (update.docChanged || update.selectionSet || update.viewportChanged || markersChanged) this.build(update.view);
            const headings = update.state.field(field).headings;
            queueMicrotask(() => { if (this.view.state.field(field, false)) onHeadings(headings); });
        }
        destroy() { clearTimeout(this.timer); clearTimeout(this.parseTimer); this.observer.disconnect(); this.unsubscribe(); }
    }, { decorations: (plugin) => plugin.decorations }), EditorView.domEventHandlers({
        focus(_event, view) { view.dispatch({ effects: focusChanged.of(true) }); },
        blur(_event, view) { view.dispatch({ effects: focusChanged.of(false) }); },
        mousedown(event, view) {
            const box = (event.target as HTMLElement).closest<HTMLInputElement>('[data-task-toggle]');
            if (!box) return false;
            event.preventDefault();
            const pos = view.posAtDOM(box);
            const line = view.state.doc.lineAt(pos);
            const match = /\[([ xX])\]/.exec(line.text.slice(Math.max(0, pos - line.from - 1)));
            if (!match) return true;
            const at = line.from + Math.max(0, pos - line.from - 1) + match.index + 1;
            view.dispatch({ changes: { from: at, to: at + 1, insert: match[1] === ' ' ? 'x' : ' ' }, userEvent: 'input' });
            return true;
        },
    }), EditorView.baseTheme({
        '.cm-live-strong': { fontWeight: '700' },
        '.cm-live-em': { fontStyle: 'italic' },
        '.cm-live-strike': { textDecoration: 'line-through' },
    })];
}
