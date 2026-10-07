import { useEffect, useRef, useState } from 'react';
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, keymap, lineNumbers, placeholder as placeholderExt, rectangularSelection, } from '@codemirror/view';
import { foldGutter, indentOnInput, indentUnit, } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { EditorSettings } from '@shared/types';
import { cn } from '../lib/cn';
import { editorTheme } from './theme';
import { focusModePlugin, markdownDecorations, setFocusMode, typewriterPlugin } from './decorations';
import { codeFenceSource, tagSource, wikiLinkSource, type CompletionSources } from './completion';
import { pasteExtension, type PasteHandlers } from './paste';
import { completeCodeFenceOnEnter, smartEnter, tableTab } from './commands';
import { editorKeymap } from './shortcuts';
import { livePreview } from './live-preview';
import { noteSearch } from './search';
import type { Heading } from '../lib/markdown/renderer';
import { t } from "../lib/i18n";

const externalValueUpdate = Annotation.define<boolean>();
export interface CodeEditorProps {
    value: string;
    live?: boolean;
    noteTitle?: string;
    onHeadings?: (headings: Heading[]) => void;
    onChange: (value: string) => void;
    settings: EditorSettings;
    sources: CompletionSources;
    handlers: PasteHandlers;
    onReady?: (view: EditorView | null) => void;
    onScroll?: (view: EditorView) => void;
    onCursorLine?: (line: number) => void;
    placeholder?: string;
    className?: string;
}
export function DeferredCodeEditor({ visible, ...props }: CodeEditorProps & { visible: boolean }) {
    const [initialized, setInitialized] = useState(visible);
    useEffect(() => {
        if (visible) setInitialized(true);
    }, [visible]);
    // Preserve undo history across mode changes once editing has started.
    return visible || initialized ? <CodeEditor {...props}/> : null;
}
export function CodeEditor({ value, live = false, noteTitle = '', onHeadings, onChange, settings, sources, handlers, onReady, onScroll, onCursorLine, placeholder = t("editor.start_writing"), className, }: CodeEditorProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);

    const cbRef = useRef({ onChange, onScroll, onCursorLine, sources, handlers, onHeadings, noteTitle });
    cbRef.current = { onChange, onScroll, onCursorLine, sources, handlers, onHeadings, noteTitle };

    const liveCompartment = useRef(new Compartment());
    const lineNumbersCompartment = useRef(new Compartment());
    const tabSizeCompartment = useRef(new Compartment());
    const placeholderCompartment = useRef(new Compartment());
    const configuredDisplay = useRef({ live, lineNumbers: settings.lineNumbers });

    useEffect(() => {
        const host = hostRef.current;
        if (!host)
            return;
        const extensions: Extension[] = [
            history(),
            drawSelection(),
            dropCursor(),
            rectangularSelection(),
            closeBrackets(),
            indentOnInput(),
            tabSizeCompartment.current.of(indentUnit.of(' '.repeat(settings.tabSize))),
            EditorState.allowMultipleSelections.of(true),
            EditorView.lineWrapping,
            placeholderCompartment.current.of([
                placeholderExt(placeholder),
                EditorView.contentAttributes.of({ 'aria-label': placeholder }),
            ]),
            noteSearch(),
            autocompletion({
                override: [

                    wikiLinkSource(() => cbRef.current.sources),
                    tagSource(() => cbRef.current.sources),
                    codeFenceSource,
                ],
                activateOnTyping: true,
                closeOnBlur: true,
                maxRenderedOptions: 24,
                icons: false,
            }),
            markdown({
                base: markdownLanguage,
                addKeymap: false,
            }),
            editorTheme(),
            markdownDecorations,
            liveCompartment.current.of(live ? livePreview((headings) => cbRef.current.onHeadings?.(headings), () => cbRef.current.noteTitle) : []),
            focusModePlugin,
            typewriterPlugin,
            pasteExtension(cbRef.current.handlers),
            keymap.of([
                { key: 'Enter', run: (view) => completeCodeFenceOnEnter(view) || smartEnter(view) },
                { key: 'Tab', run: (view) => acceptCompletion(view) || tableTab(view) },
                ...editorKeymap,
            ]),
            keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap]),
            keymap.of(defaultKeymap),
            keymap.of([indentWithTab]),
            lineNumbersCompartment.current.of(
                settings.lineNumbers && !live
                    ? [lineNumbers(), foldGutter()]
                    : [],
            ),
            EditorView.updateListener.of((update) => {
                const external = update.transactions.some((transaction) => transaction.annotation(externalValueUpdate));
                if (update.docChanged && !external) {
                    cbRef.current.onChange(update.state.doc.toString());
                }
                if (update.selectionSet && cbRef.current.onCursorLine) {
                    const line = update.state.doc.lineAt(update.state.selection.main.head).number;
                    cbRef.current.onCursorLine(line);
                }
            }),
            EditorView.domEventHandlers({
                scroll(_event, view) {
                    cbRef.current.onScroll?.(view);
                },
            }),
        ];
        const view = new EditorView({
            state: EditorState.create({ doc: value, extensions }),
            parent: host,
        });
        view.contentDOM.spellcheck = settings.spellcheck;
        viewRef.current = view;
        onReady?.(view);
        return () => {
            onReady?.(null);
            view.destroy();
            viewRef.current = null;
        };
    }, []);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        if (configuredDisplay.current.live === live && configuredDisplay.current.lineNumbers === settings.lineNumbers)
            return;
        configuredDisplay.current = { live, lineNumbers: settings.lineNumbers };
        view.dispatch({
            effects: lineNumbersCompartment.current.reconfigure(
                settings.lineNumbers && !live
                    ? [lineNumbers(), foldGutter()]
                    : [],
            ),
        });
        view.dispatch({ effects: liveCompartment.current.reconfigure(live ? livePreview((headings) => cbRef.current.onHeadings?.(headings), () => cbRef.current.noteTitle) : []) });
    }, [settings.lineNumbers, live]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
            effects: tabSizeCompartment.current.reconfigure(
                indentUnit.of(' '.repeat(settings.tabSize)),
            ),
        });
    }, [settings.tabSize]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
            effects: placeholderCompartment.current.reconfigure([
                placeholderExt(placeholder),
                EditorView.contentAttributes.of({ 'aria-label': placeholder }),
            ]),
        });
    }, [placeholder]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view)
            return;
        const current = view.state.doc.toString();
        if (current === value)
            return;
        view.dispatch({
            changes: { from: 0, to: current.length, insert: value },
            selection: { anchor: Math.min(view.state.selection.main.anchor, value.length) },
            annotations: externalValueUpdate.of(true),
        });
    }, [value]);

    useEffect(() => {
        const content = viewRef.current?.contentDOM;
        if (content)
            content.spellcheck = settings.spellcheck;
    }, [settings.spellcheck]);

    useEffect(() => {
        viewRef.current?.dispatch({ effects: setFocusMode.of(settings.focusMode) });
    }, [settings.focusMode]);
    return (<div ref={hostRef} className={cn('ink-editor', className)} data-live={live} data-family={settings.fontFamily} data-focus-mode={settings.focusMode} data-typewriter={settings.typewriter}/>);
}
