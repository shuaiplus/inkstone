import { EditorSelection, type ChangeSpec, type EditorState, type SelectionRange, type StateCommand } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { t } from "../lib/i18n";


export function toggleWrap(open: string, close = open): StateCommand {
    return ({ state, dispatch }) => {
        const changes = state.changeByRange((range) => {
            const surrounding = surroundingMarkers(state, range, open, close);

            if (surrounding) {
                return {
                    changes: [
                        { from: range.from - surrounding.open, to: range.from },
                        { from: range.to, to: range.to + surrounding.close },
                    ],
                    range: EditorSelection.range(range.from - surrounding.open, range.to - surrounding.open),
                };
            }

            let { from, to } = range;
            if (from === to) {
                const line = state.doc.lineAt(from);
                const offset = from - line.from;
                const wordStart = /[\p{L}\p{N}_]+$/u.exec(line.text.slice(0, offset));
                const wordEnd = /^[\p{L}\p{N}_]+/u.exec(line.text.slice(offset));
                if (wordStart || wordEnd) {
                    from = line.from + offset - (wordStart?.[0].length ?? 0);
                    to = line.from + offset + (wordEnd?.[0].length ?? 0);
                }
            }
            const text = state.sliceDoc(from, to);

            const contained = containedMarkers(text, open, close);
            if (contained) {
                return {
                    changes: { from, to, insert: text.slice(contained.open, text.length - contained.close) },
                    range: EditorSelection.range(from, to - contained.open - contained.close),
                };
            }
            return {
                changes: { from, to, insert: `${open}${text}${close}` },
                range: text
                    ? EditorSelection.range(from + open.length, to + open.length)
                    : EditorSelection.cursor(from + open.length),
            };
        });
        dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.format' }));
        return true;
    };
}
export function toggleLinePrefix(
    prefix: string | ((index: number) => string),
    pattern: RegExp,
    replacementPattern?: RegExp,
): StateCommand {
    return ({ state, dispatch }) => {
        const changes: ChangeSpec[] = [];
        const seen = new Set<number>();
        let index = 0;
        for (const range of state.selection.ranges) {
            const { startLine, endLine } = selectedLineBounds(state, range);
            let allPrefixed = true;
            for (let n = startLine; n <= endLine; n++) {
                if (!linePrefixMatch(state.doc.line(n).text, pattern)) {
                    allPrefixed = false;
                    break;
                }
            }
            for (let n = startLine; n <= endLine; n++) {
                if (seen.has(n))
                    continue;
                seen.add(n);
                const line = state.doc.line(n);
                const indent = lineIndent(line.text);
                const match = linePrefixMatch(line.text, pattern);
                const replacement = replacementPattern
                    ? linePrefixMatch(line.text, replacementPattern)
                    : null;
                if (allPrefixed && match) {
                    changes.push({
                        from: line.from + indent.length,
                        to: line.from + indent.length + match[0].length,
                    });
                }
                else if (!match) {
                    const value = typeof prefix === 'function' ? prefix(index) : prefix;
                    changes.push({
                        from: line.from + indent.length,
                        to: replacement
                            ? line.from + indent.length + replacement[0].length
                            : line.from + indent.length,
                        insert: value,
                    });
                }
                index++;
            }
        }
        if (!changes.length)
            return false;
        const changeSet = state.changes(changes);
        dispatch(state.update({
            changes: changeSet,
            selection: state.selection.map(changeSet, 1),
            scrollIntoView: true,
            userEvent: 'input.format',
        }));
        return true;
    };
}
export const toggleBold = toggleWrap('**');
export const toggleItalic = toggleWrap('*');
export const toggleInlineCode: StateCommand = ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => {
        let { from, to } = range;
        if (from === to) {
            const line = state.doc.lineAt(from);
            const offset = from - line.from;
            const wordStart = /[\p{L}\p{N}_]+$/u.exec(line.text.slice(0, offset));
            const wordEnd = /^[\p{L}\p{N}_]+/u.exec(line.text.slice(offset));
            if (wordStart || wordEnd) {
                from -= wordStart?.[0].length ?? 0;
                to += wordEnd?.[0].length ?? 0;
            }
        }
        const selected = state.sliceDoc(from, to);
        const contained = codeSpanMarkers(selected);
        if (contained) {
            let content = selected.slice(contained, selected.length - contained);
            if (content.startsWith(' ') && content.endsWith(' ') && /\S/.test(content))
                content = content.slice(1, -1);
            return {
                changes: { from, to, insert: content },
                range: EditorSelection.range(from, from + content.length),
            };
        }
        const before = countRunBefore(state, from, '`');
        const after = countRunAfter(state, to, '`');
        if (before > 0 && before === after) {
            return {
                changes: [
                    { from: from - before, to: from },
                    { from: to, to: to + after },
                ],
                range: EditorSelection.range(from - before, to - before),
            };
        }
        const fence = '`'.repeat(Math.max(1, longestCharacterRun(selected, '`') + 1));
        const pad = selected && /^(?:\s|`)|(?:\s|`)$/.test(selected) ? ' ' : '';
        const insert = `${fence}${pad}${selected}${pad}${fence}`;
        const selectionFrom = from + fence.length + pad.length;
        return {
            changes: { from, to, insert },
            range: selected
                ? EditorSelection.range(selectionFrom, selectionFrom + selected.length)
                : EditorSelection.cursor(from + fence.length),
        };
    });
    dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.format' }));
    return true;
};
export const toggleStrikethrough = toggleWrap('~~');
export const toggleHighlight = toggleWrap('==');
export const toggleComment = toggleWrap('%%');
export const toggleInlineMath = toggleWrap('$');
export const toggleWikiLink = toggleWrap('[[', ']]');
export const toggleNoteEmbed = toggleWrap('![[', ']]');
export const toggleBlockReference = toggleWrap('[[#^', ']]');
export const toggleQuote = toggleLinePrefix('> ', /^>\s?/);
const ANY_LIST_PREFIX = /^(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
export const toggleBulletList = toggleLinePrefix(
    '- ',
    /^[-*+][ \t]+(?!\[[ xX]\][ \t]+)/,
    ANY_LIST_PREFIX,
);
export const toggleTaskList = toggleLinePrefix(
    '- [ ] ',
    /^(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\][ \t]+/,
    ANY_LIST_PREFIX,
);
export const toggleOrderedList = toggleLinePrefix(
    (i) => `${i + 1}. `,
    /^\d+[.)][ \t]+(?!\[[ xX]\][ \t]+)/,
    ANY_LIST_PREFIX,
);
export function setHeading(level: number): StateCommand {
    return ({ state, dispatch }) => {
        const changes: ChangeSpec[] = [];
        const seen = new Set<number>();
        for (const range of state.selection.ranges) {
            const { startLine, endLine } = selectedLineBounds(state, range);
            for (let n = startLine; n <= endLine; n++) {
                if (seen.has(n))
                    continue;
                seen.add(n);
                const line = state.doc.line(n);
                const match = /^(#{1,6})\s+/.exec(line.text);
                const marker = '#'.repeat(level);
                if (level === 0) {
                    if (match)
                        changes.push({ from: line.from, to: line.from + match[0].length });
                }
                else if (match && match[1]!.length === level) {
                    changes.push({ from: line.from, to: line.from + match[0].length });
                }
                else if (match) {
                    changes.push({ from: line.from, to: line.from + match[0].length, insert: `${marker} ` });
                }
                else {
                    changes.push({ from: line.from, insert: `${marker} ` });
                }
            }
        }
        if (!changes.length)
            return false;
        const changeSet = state.changes(changes);
        dispatch(state.update({
            changes: changeSet,
            selection: state.selection.map(changeSet, 1),
            scrollIntoView: true,
            userEvent: 'input.format',
        }));
        return true;
    };
}
export function insertLink(url = ''): StateCommand {
    return ({ state, dispatch }) => {
        const changes = state.changeByRange((range) => {
            const text = state.sliceDoc(range.from, range.to);
            const label = text.replace(/\\/g, '\\\\').replace(/[\[\]]/g, '\\$&');
            const destination = url
                ? `<${url.replace(/[\u0000-\u0020<>]/g, (value) => encodeURIComponent(value))}>`
                : '';
            const insert = `[${label}](${destination})`;
            const cursor = text
                ? range.from + insert.length - 1
                : range.from + 1;
            return {
                changes: { from: range.from, to: range.to, insert },
                range: EditorSelection.cursor(cursor),
            };
        });
        dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.format' }));
        return true;
    };
}
export function insertImage(url = ''): StateCommand {
    return ({ state, dispatch }) => {
        const changes = state.changeByRange((range) => {
            const alt = state.sliceDoc(range.from, range.to).replace(/\\/g, '\\\\').replace(/[\[\]]/g, '\\$&');
            const destination = url
                ? `<${url.replace(/[\u0000-\u0020<>]/g, (value) => encodeURIComponent(value))}>`
                : '';
            const insert = `![${alt}](${destination})`;
            return {
                changes: { from: range.from, to: range.to, insert },
                range: EditorSelection.cursor(alt ? range.from + insert.length - 1 : range.from + 2),
            };
        });
        dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.format' }));
        return true;
    };
}
export function insertText(text: string, cursorOffset?: number): StateCommand {
    return ({ state, dispatch }) => {
        const changes = state.changeByRange((range) => ({
            changes: { from: range.from, to: range.to, insert: text },
            range: EditorSelection.cursor(range.from + (cursorOffset ?? text.length)),
        }));
        dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.insert' }));
        return true;
    };
}

export function insertPrefix(prefix: string): StateCommand {
    return ({ state, dispatch }) => {
        const changes = state.changeByRange((range) => ({
            changes: { from: range.from, insert: prefix },
            range: range.empty
                ? EditorSelection.cursor(range.from + prefix.length)
                : EditorSelection.range(range.from + prefix.length, range.to + prefix.length),
        }));
        dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.insert' }));
        return true;
    };
}

export const insertTag = insertPrefix('#');

export const insertBlockId: StateCommand = ({ state, dispatch }) => {
    const range = state.selection.main;
    const position = range.to;
    const prefix = position > 0 && !/\s/.test(state.sliceDoc(position - 1, position)) ? ' ' : '';
    const insert = `${prefix}^`;
    dispatch(state.update({
        changes: { from: position, insert },
        selection: EditorSelection.cursor(position + insert.length),
        scrollIntoView: true,
        userEvent: 'input.insert',
    }));
    return true;
};

export const insertFootnote: StateCommand = ({ state, dispatch }) => {
    const source = state.doc.toString();
    let number = 1;
    while (source.includes(`[^${number}]`))
        number++;
    const reference = `[^${number}]`;
    const separator = source.length === 0 ? '\n\n' : source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
    const definition = `${separator}[^${number}]: `;
    const position = state.selection.main.to;
    const changes: ChangeSpec[] = [
        { from: position, insert: reference },
        { from: state.doc.length, insert: definition },
    ];
    const definitionStart = state.doc.length + definition.length + (position === state.doc.length ? reference.length : 0);
    dispatch(state.update({
        changes,
        selection: EditorSelection.cursor(definitionStart),
        scrollIntoView: true,
        userEvent: 'input.insert',
    }));
    return true;
};

export const insertMermaid: StateCommand = (target) => insertWrappedBlock(
    '```mermaid',
    '```',
    'flowchart LR\n  A --> B',
)(target);

export const insertMathBlock: StateCommand = ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => {
        const selected = state.sliceDoc(range.from, range.to);
        const before = state.sliceDoc(0, range.from);
        const after = state.sliceDoc(range.to);
        const prefix = before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
        const suffix = after.length === 0 || after.startsWith('\n') ? '\n' : '\n\n';
        const insert = `${prefix}$$\n${selected}\n$$${suffix}`;
        const contentStart = range.from + prefix.length + 3;
        return {
            changes: { from: range.from, to: range.to, insert },
            range: selected
                ? EditorSelection.range(contentStart, contentStart + selected.length)
                : EditorSelection.cursor(contentStart),
        };
    });
    dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.insert' }));
    return true;
};

export const insertCallout: StateCommand = ({ state, dispatch }) => {
    const range = state.selection.main;
    const selected = state.sliceDoc(range.from, range.to);
    const body = selected ? selected.split('\n').map((line) => `> ${line}`).join('\n') : '> ';
    const insert = `> [!NOTE]\n${body}`;
    dispatch(state.update({
        changes: { from: range.from, to: range.to, insert },
        selection: EditorSelection.cursor(range.from + insert.length),
        scrollIntoView: true,
        userEvent: 'input.insert',
    }));
    return true;
};

export const insertDetails: StateCommand = (target) => insertWrappedBlock(
    '::: details []',
    ':::',
    '',
    '::: details ['.length,
)(target);

export const insertTabs: StateCommand = ({ state, dispatch }) => {
    const range = state.selection.main;
    const selected = state.sliceDoc(range.from, range.to);
    const firstContent = selected ? `\n${selected}` : '';
    const insert = `:::: tabs\n::: tab-item ${t("editor.tab_1")}${firstContent}\n\n:::\n::: tab-item ${t("editor.tab_2")}\n\n:::\n::::\n`;
    const cursor = selected
        ? range.from + insert.indexOf(selected) + selected.length
        : range.from + insert.indexOf(t("editor.tab_1"));
    dispatch(state.update({
        changes: { from: range.from, to: range.to, insert },
        selection: selected
            ? EditorSelection.cursor(cursor)
            : EditorSelection.range(cursor, cursor + t("editor.tab_1").length),
        scrollIntoView: true,
        userEvent: 'input.insert',
    }));
    return true;
};

export const insertFrontMatter: StateCommand = ({ state, dispatch }) => {
    const source = state.doc.toString();
    if (/^---[ \t]*\r?\n/.test(source)) {
        const firstLineEnd = source.indexOf('\n') + 1;
        dispatch(state.update({
            selection: EditorSelection.cursor(firstLineEnd),
            scrollIntoView: true,
        }));
        return true;
    }
    const insert = '---\ntitle: \ntags: []\n---\n\n';
    dispatch(state.update({
        changes: { from: 0, insert },
        selection: EditorSelection.cursor('---\ntitle: '.length),
        scrollIntoView: true,
        userEvent: 'input.insert',
    }));
    return true;
};
export const insertTable: StateCommand = (target) => {
    const template = [t("editor.column_1_column_2_column_3"), '| --- | --- | --- |', '|  |  |  |', ''].join('\n');
    return insertPrefixedBlock(template, 2)(target);
};
export const insertCodeBlock: StateCommand = ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => {
        const selected = state.sliceDoc(range.from, range.to);
        const fence = '`'.repeat(Math.max(3, longestCharacterRun(selected, '`') + 1));
        const insert = `${fence}\n${selected}\n${fence}\n`;
        return {
            changes: { from: range.from, to: range.to, insert },
            range: EditorSelection.cursor(range.from + fence.length),
        };
    });
    dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.insert' }));
    return true;
};
export const insertAdvancedCodeBlock: StateCommand = ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => {
        const selected = state.sliceDoc(range.from, range.to);
        const fence = '`'.repeat(Math.max(3, longestCharacterRun(selected, '`') + 1));
        const info = 'text title="" line-numbers {1}';
        const insert = `${fence}${info}\n${selected}\n${fence}\n`;
        return {
            changes: { from: range.from, to: range.to, insert },
            range: selected
                ? EditorSelection.range(range.from + fence.length + info.length + 1, range.from + fence.length + info.length + 1 + selected.length)
                : EditorSelection.cursor(range.from + fence.length),
        };
    });
    dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.insert' }));
    return true;
};
export const insertHorizontalRule: StateCommand = (target) => insertPrefixedBlock('---\n\n', 5)(target);

function insertWrappedBlock(open: string, close: string, fallback: string, emptyCursorOffset?: number): StateCommand {
    return ({ state, dispatch }) => {
        const range = state.selection.main;
        const selected = state.sliceDoc(range.from, range.to);
        const content = selected || fallback;
        const insert = `${open}\n${content}\n${close}\n`;
        const cursor = selected
            ? range.from + open.length + 1 + selected.length
            : range.from + (emptyCursorOffset ?? open.length + 1);
        dispatch(state.update({
            changes: { from: range.from, to: range.to, insert },
            selection: EditorSelection.cursor(cursor),
            scrollIntoView: true,
            userEvent: 'input.insert',
        }));
        return true;
    };
}
function insertPrefixedBlock(text: string, cursorOffset: number): StateCommand {
    return ({ state, dispatch }) => {
        const range = state.selection.main;
        const line = state.doc.lineAt(range.head);
        const needsBreak = line.text.trim().length > 0;
        const insert = (needsBreak ? '\n' : '') + text;
        dispatch(state.update({
            changes: { from: line.to, insert },
            selection: EditorSelection.cursor(line.to + (needsBreak ? 1 : 0) + cursorOffset),
            scrollIntoView: true,
            userEvent: 'input.insert',
        }));
        return true;
    };
}
const LIST_RE = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/;
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;

export const completeCodeFenceOnEnter: StateCommand = ({ state, dispatch }) => {
    const range = state.selection.main;
    if (!range.empty)
        return false;
    const line = state.doc.lineAt(range.head);
    if (range.head !== line.to || openFenceBeforeLine(state, line.number))
        return false;
    const match = FENCE_RE.exec(line.text);
    if (!match)
        return false;
    const fence = match[1]!;
    const insert = `\n\n${fence}`;
    dispatch(state.update({
        changes: { from: range.head, insert },
        selection: EditorSelection.cursor(range.head + 1),
        scrollIntoView: true,
        userEvent: 'input.complete',
    }));
    return true;
};

function openFenceBeforeLine(state: EditorState, lineNumber: number): boolean {
    let opening: { char: string; length: number } | null = null;
    for (let number = 1; number < lineNumber; number++) {
        const match = FENCE_RE.exec(state.doc.line(number).text);
        if (!match)
            continue;
        const marker = match[1]!;
        if (!opening) {
            opening = { char: marker[0]!, length: marker.length };
            continue;
        }
        if (marker[0] === opening.char && marker.length >= opening.length && /^[ \t]*$/.test(match[2]!))
            opening = null;
    }
    return opening !== null;
}

export const smartEnter: StateCommand = ({ state, dispatch }) => {
    const range = state.selection.main;
    if (!range.empty)
        return false;
    const line = state.doc.lineAt(range.head);
    const match = LIST_RE.exec(line.text);
    if (!match)
        return false;
    const [, indent, marker, space, task, content] = match;
    const markerEnd = line.from + (indent?.length ?? 0) + (marker?.length ?? 0) + (space?.length ?? 0) + (task?.length ?? 0);
    if (range.head < markerEnd)
        return false;
    if (!content?.trim()) {
        dispatch(state.update({
            changes: { from: line.from, to: line.to, insert: '' },
            selection: EditorSelection.cursor(line.from),
            userEvent: 'input',
        }));
        return true;
    }
    const nextMarker = /^\d+[.)]$/.test(marker ?? '')
        ? `${parseInt(marker!, 10) + 1}${marker!.slice(-1)}`
        : marker;
    const nextTask = task ? '[ ] ' : '';
    const insert = `\n${indent}${nextMarker}${space}${nextTask}`;
    dispatch(state.update({
        changes: { from: range.head, insert },
        selection: EditorSelection.cursor(range.head + insert.length),
        scrollIntoView: true,
        userEvent: 'input',
    }));
    return true;
};
export const tableTab: StateCommand = ({ state, dispatch }) => {
    const range = state.selection.main;
    const line = state.doc.lineAt(range.head);
    if (!/^\s*\|/.test(line.text))
        return false;
    const rest = line.text.slice(range.head - line.from);
    const next = rest.indexOf('|');
    if (next < 0)
        return false;
    const target = range.head + next + 1;
    const after = /^\s*/.exec(state.doc.sliceString(target, Math.min(target + 4, state.doc.length)));
    dispatch(state.update({
        selection: EditorSelection.cursor(target + (after?.[0].length ?? 0)),
        scrollIntoView: true,
    }));
    return true;
};
export const toggleTaskDone: StateCommand = ({ state, dispatch }) => {
    const changes: ChangeSpec[] = [];
    const seen = new Set<number>();
    for (const range of state.selection.ranges) {
        const { startLine, endLine } = selectedLineBounds(state, range);
        for (let n = startLine; n <= endLine; n++) {
            if (seen.has(n))
                continue;
            seen.add(n);
            const line = state.doc.line(n);
            const match = taskMarker(line.text);
            if (!match)
                continue;
            const from = line.from + match[1]!.length;
            changes.push({ from, to: from + 1, insert: match[2] === ' ' ? 'x' : ' ' });
        }
    }
    if (!changes.length)
        return false;
    dispatch(state.update({ changes, userEvent: 'input.format' }));
    return true;
};
export function setTaskAtLine(view: EditorView, lineNumber: number, checked: boolean): boolean {
    const doc = view.state.doc;
    if (lineNumber < 1 || lineNumber > doc.lines)
        return false;
    const line = doc.line(lineNumber);
    const match = taskMarker(line.text);
    if (!match)
        return false;
    const from = line.from + match[1]!.length;
    view.dispatch({
        changes: { from, to: from + 1, insert: checked ? 'x' : ' ' },
        userEvent: 'input.format',
    });
    return true;
}

export function updateTaskAtSourceLine(source: string, lineIndex: number, checked: boolean): string | null {
    if (!Number.isInteger(lineIndex) || lineIndex < 0)
        return null;
    let from = 0;
    for (let index = 0; index < lineIndex; index++) {
        const newline = source.indexOf('\n', from);
        if (newline < 0)
            return null;
        from = newline + 1;
    }
    const newline = source.indexOf('\n', from);
    let to = newline < 0 ? source.length : newline;
    if (to > from && source[to - 1] === '\r')
        to--;
    const match = taskMarker(source.slice(from, to));
    if (!match)
        return null;
    const marker = from + match[1]!.length;
    const value = checked ? 'x' : ' ';
    if (source[marker]?.toLowerCase() === value)
        return source;
    return `${source.slice(0, marker)}${value}${source.slice(marker + 1)}`;
}

function taskMarker(line: string): RegExpExecArray | null {
    return /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/.exec(line);
}

function selectedLineBounds(state: EditorState, range: SelectionRange): {
    startLine: number;
    endLine: number;
} {
    const startLine = state.doc.lineAt(range.from).number;
    let endLine = state.doc.lineAt(range.to).number;
    if (!range.empty && range.to === state.doc.line(endLine).from)
        endLine--;
    return { startLine, endLine };
}

function lineIndent(line: string): string {
    return /^[ \t]*/.exec(line)?.[0] ?? '';
}

function linePrefixMatch(line: string, pattern: RegExp): RegExpExecArray | null {
    pattern.lastIndex = 0;
    return pattern.exec(line.slice(lineIndent(line).length));
}

function surroundingMarkers(
    state: EditorState,
    range: SelectionRange,
    open: string,
    close: string,
): { open: number; close: number } | null {
    if (open === '*' && close === '*') {
        const before = countRunBefore(state, range.from, '*');
        const after = countRunAfter(state, range.to, '*');
        return before % 2 === 1 && after % 2 === 1 ? { open: 1, close: 1 } : null;
    }
    return state.sliceDoc(Math.max(0, range.from - open.length), range.from) === open &&
        state.sliceDoc(range.to, Math.min(state.doc.length, range.to + close.length)) === close
        ? { open: open.length, close: close.length }
        : null;
}

function containedMarkers(text: string, open: string, close: string): { open: number; close: number } | null {
    if (open === '*' && close === '*') {
        const before = countStringRun(text, 0, 1, '*');
        const after = countStringRun(text, text.length - 1, -1, '*');
        return before % 2 === 1 && after % 2 === 1 && text.length > 2
            ? { open: 1, close: 1 }
            : null;
    }
    return text.startsWith(open) && text.endsWith(close) && text.length > open.length + close.length
        ? { open: open.length, close: close.length }
        : null;
}

function codeSpanMarkers(text: string): number {
    const before = countStringRun(text, 0, 1, '`');
    const after = countStringRun(text, text.length - 1, -1, '`');
    return before > 0 && before === after && text.length > before * 2 ? before : 0;
}

function countRunBefore(state: EditorState, position: number, character: string): number {
    let count = 0;
    while (position - count - 1 >= 0 && state.sliceDoc(position - count - 1, position - count) === character)
        count++;
    return count;
}

function countRunAfter(state: EditorState, position: number, character: string): number {
    let count = 0;
    while (position + count < state.doc.length && state.sliceDoc(position + count, position + count + 1) === character)
        count++;
    return count;
}

function countStringRun(value: string, start: number, step: 1 | -1, character: string): number {
    let count = 0;
    for (let index = start; index >= 0 && index < value.length && value[index] === character; index += step)
        count++;
    return count;
}

function longestCharacterRun(value: string, character: string): number {
    let longest = 0;
    let current = 0;
    for (const valueCharacter of value) {
        current = valueCharacter === character ? current + 1 : 0;
        longest = Math.max(longest, current);
    }
    return longest;
}
