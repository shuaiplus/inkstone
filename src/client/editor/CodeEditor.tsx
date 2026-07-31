import { useEffect, useRef } from 'react';
import { Annotation, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, placeholder as placeholderExt, rectangularSelection, } from '@codemirror/view';
import { bracketMatching, foldGutter, indentOnInput, indentUnit, syntaxHighlighting, defaultHighlightStyle, } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab, standardKeymap, } from '@codemirror/commands';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { EditorSettings } from '@shared/types';
import { cn } from '../lib/cn';
import { codeLanguages } from './codeLanguages';
import { editorTheme } from './theme';
import { focusModePlugin, markdownDecorations, typewriterPlugin } from './decorations';
import { codeFenceSource, tagSource, wikiLinkSource, type CompletionSources } from './completion';
import { pasteExtension, type PasteHandlers } from './paste';
import { setHeading, smartEnter, tableTab, toggleBold, toggleBulletList, toggleHighlight, toggleInlineCode, toggleItalic, toggleOrderedList, toggleQuote, toggleStrikethrough, toggleTaskDone, toggleTaskList, } from './commands';
import { t } from "../lib/i18n";

const externalValueUpdate = Annotation.define<boolean>();
export interface CodeEditorProps {
    value: string;
    onChange: (value: string) => void;
    settings: EditorSettings;
    sources: CompletionSources;
    handlers: PasteHandlers;
    onReady?: (view: EditorView | null) => void;
    onScroll?: (view: EditorView) => void;
    onCursorLine?: (line: number) => void;
    onSelectionChange?: (view: EditorView) => void;
    placeholder?: string;
    className?: string;
}
export function CodeEditor({ value, onChange, settings, sources, handlers, onReady, onScroll, onCursorLine, onSelectionChange, placeholder = t("editor.start_writing"), className, }: CodeEditorProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);

    const cbRef = useRef({ onChange, onScroll, onCursorLine, onSelectionChange, sources, handlers });
    cbRef.current = { onChange, onScroll, onCursorLine, onSelectionChange, sources, handlers };
    useEffect(() => {
        const host = hostRef.current;
        if (!host)
            return;
        const extensions: Extension[] = [
            history(),
            drawSelection(),
            dropCursor(),
            rectangularSelection(),
            highlightSpecialChars(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            bracketMatching(),
            closeBrackets(),
            indentOnInput(),
            indentUnit.of(' '.repeat(settings.tabSize)),
            EditorState.allowMultipleSelections.of(true),
            EditorView.lineWrapping,
            placeholderExt(placeholder),
            search({ top: true }),
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
                codeLanguages,
                addKeymap: false,
            }),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            editorTheme(),
            markdownDecorations,
            focusModePlugin,
            typewriterPlugin,
            pasteExtension(cbRef.current.handlers),
            keymap.of([
                { key: 'Enter', run: smartEnter },
                { key: 'Tab', run: (view) => acceptCompletion(view) || tableTab(view) },
                { key: 'Mod-b', run: toggleBold, preventDefault: true },
                { key: 'Mod-i', run: toggleItalic, preventDefault: true },
                { key: 'Mod-e', run: toggleInlineCode, preventDefault: true },
                { key: 'Mod-Shift-x', run: toggleStrikethrough },
                { key: 'Mod-Shift-h', run: toggleHighlight },
                { key: 'Mod-Shift-.', run: toggleQuote },
                { key: 'Mod-Shift-8', run: toggleBulletList },
                { key: 'Mod-Shift-7', run: toggleOrderedList },
                { key: 'Mod-Shift-9', run: toggleTaskList },
                { key: 'Mod-Shift-Enter', run: toggleTaskDone },
                { key: 'Mod-1', run: setHeading(1) },
                { key: 'Mod-2', run: setHeading(2) },
                { key: 'Mod-3', run: setHeading(3) },
                { key: 'Mod-4', run: setHeading(4) },
                { key: 'Mod-5', run: setHeading(5) },
                { key: 'Mod-6', run: setHeading(6) },
            ]),
            keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap]),
            keymap.of(standardKeymap),
            keymap.of(defaultKeymap),
            keymap.of([indentWithTab]),
            EditorView.updateListener.of((update) => {
                const external = update.transactions.some((transaction) => transaction.annotation(externalValueUpdate));
                if (update.docChanged && !external) {
                    cbRef.current.onChange(update.state.doc.toString());
                }
                if (update.selectionSet && cbRef.current.onCursorLine) {
                    const line = update.state.doc.lineAt(update.state.selection.main.head).number;
                    cbRef.current.onCursorLine(line);
                }
                if (update.selectionSet && cbRef.current.onSelectionChange) {
                    cbRef.current.onSelectionChange(update.view);
                }
            }),
            EditorView.domEventHandlers({
                scroll(_event, view) {
                    cbRef.current.onScroll?.(view);
                },
            }),
        ];
        if (settings.lineNumbers) {
            extensions.push(lineNumbers(), highlightActiveLineGutter(), foldGutter());
        }
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


    }, [settings.lineNumbers, settings.tabSize, placeholder]);

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
    return (<div ref={hostRef} className={cn('ink-editor', className)} data-family={settings.fontFamily} data-focus-mode={settings.focusMode} data-typewriter={settings.typewriter}/>);
}