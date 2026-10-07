import type { Text } from '@codemirror/state';
import type { Tree } from '@lezer/common';

/**
 * Token-level live preview geometry.
 *
 * Live preview never rewrites the document: it only hides typographic markers so the
 * rendered look matches the preview pane while every character stays editable and the
 * caret stays visible. Markers on the line that holds the caret are revealed, so the
 * syntax you are touching is always available for editing.
 *
 * Everything here is pure so it can be unit tested without an editor.
 */

export interface LiveHide {
    from: number;
    to: number;
}

export interface LiveLine {
    /** 1-based document line. */
    line: number;
    classes: string;
}

export interface LiveMark {
    from: number;
    to: number;
    className: string;
}

export type LiveReplaceKind = 'bullet' | 'ordered' | 'checkbox' | 'rule' | 'image';

export interface LiveReplace {
    from: number;
    to: number;
    kind: LiveReplaceKind;
    /** Bullet or ordered marker text such as `-` or `3.`. */
    marker?: string;
    /** Nesting depth, used to indent rendered bullets. */
    depth?: number;
    checked?: boolean;
    src?: string;
    alt?: string;
}

/** Blocks that cannot be represented with hidden markers and keep the rendered-widget path. */
export interface LiveOpaque {
    from: number;
    to: number;
}

export interface LiveDecorations {
    hide: LiveHide[];
    lines: LiveLine[];
    marks: LiveMark[];
    replaces: LiveReplace[];
    opaque: LiveOpaque[];
    /** True when the document has token-level work worth rendering. */
    hasTokens: boolean;
}

const HEADING_RE = /^ATXHeading([1-6])$/;
const CALLOUT_RE = /^(\s*)>\s*\[!([A-Za-z][A-Za-z0-9_-]{0,31})\]([+-])?(?:[ \t]+(.*?))?[ \t]*$/;
const WIKI_RE = /\[\[[^[\]\n]{1,200}\]\]/g;
const FRONT_MATTER_RE = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const BLOCK_MATH_RE = /\$\$[\s\S]*?\$\$/g;
const INLINE_SPECIAL_RE = /\$[^$\n]+\$|!\[\[/;

/** Marker node names that are hidden (replaced by nothing) when the caret is elsewhere. */
const INLINE_HIDE: Record<string, string> = {
    StrongEmphasis: 'cm-live-strong',
    Emphasis: 'cm-live-em',
    Strikethrough: 'cm-live-strike',
    InlineCode: 'cm-live-code',
};

interface Collected {
    headings: { level: string; mark?: { from: number; to: number } }[];
    quoteMarks: LiveHide[];
    listMarks: { from: number; to: number; ordered: boolean; depth: number; marker: string }[];
    tasks: { from: number; to: number; checked: boolean }[];
    constructs: { from: number; to: number; className: string; marks: LiveHide[] }[];
    links: { from: number; to: number; marks: LiveHide[]; url?: { from: number; to: number } }[];
    images: { from: number; to: number; src: string; alt: string }[];
    rules: LiveHide[];
    quotes: LiveHide[];
    opaque: LiveHide[];
    paragraphs: LiveHide[];
}

function emptyCollected(): Collected {
    return {
        headings: [], quoteMarks: [], listMarks: [], tasks: [], constructs: [],
        links: [], images: [], rules: [], quotes: [], opaque: [], paragraphs: [],
    };
}

function collect(tree: Tree, viewport: { from: number; to: number }, doc: Text): Collected {
    const result = emptyCollected();
    tree.iterate({
        from: viewport.from,
        to: viewport.to,
        enter(node) {
            const name = node.name;
            const heading = HEADING_RE.exec(name);
            if (heading) {
                const mark = node.node.getChild('HeaderMark');
                result.headings.push({ level: heading[1]!, mark: mark ? { from: mark.from, to: mark.to } : undefined });
                return;
            }
            switch (name) {
                case 'Blockquote':
                    result.quotes.push({ from: node.from, to: node.to });
                    return;
                case 'QuoteMark':
                    result.quoteMarks.push({ from: node.from, to: node.to });
                    return;
                case 'ListMark': {
                    // ListMark lives inside ListItem; the enclosing list is its ancestor.
                    let list = node.node.parent;
                    while (list && list.name !== 'BulletList' && list.name !== 'OrderedList') list = list.parent;
                    const ordered = list?.name === 'OrderedList';
                    let depth = 0;
                    for (let cursor = list?.parent; cursor; cursor = cursor.parent) {
                        if (cursor.name === 'BulletList' || cursor.name === 'OrderedList') depth += 1;
                    }
                    result.listMarks.push({ from: node.from, to: node.to, ordered, depth, marker: doc.sliceString(node.from, node.to) });
                    return;
                }
                case 'TaskMarker':
                    result.tasks.push({ from: node.from, to: node.to, checked: /\[[xX]\]/.test(doc.sliceString(node.from, node.to)) });
                    return;
                case 'HorizontalRule':
                    result.rules.push({ from: node.from, to: node.to });
                    return;
                case 'Table':
                case 'FencedCode':
                case 'CodeBlock':
                    result.opaque.push({ from: node.from, to: node.to });
                    return;
                case 'Paragraph':
                    result.paragraphs.push({ from: node.from, to: node.to });
                    return;
                case 'Image': {
                    const url = node.node.getChild('URL');
                    result.images.push({
                        from: node.from,
                        to: node.to,
                        src: url ? doc.sliceString(url.from, url.to) : '',
                        alt: doc.sliceString(node.from, node.to).replace(/^!\[/, '').replace(/\].*$/, ''),
                    });
                    return;
                }
                case 'Link': {
                    const marks: LiveHide[] = [];
                    for (const mark of node.node.getChildren('LinkMark')) marks.push({ from: mark.from, to: mark.to });
                    const url = node.node.getChild('URL');
                    result.links.push({ from: node.from, to: node.to, marks, url: url ? { from: url.from, to: url.to } : undefined });
                    return;
                }
                default: {
                    const className = INLINE_HIDE[name];
                    if (!className) return;
                    const marks: LiveHide[] = [];
                    const delimiter = name === 'StrongEmphasis' || name === 'Emphasis' ? ['EmphasisMark']
                        : name === 'Strikethrough' ? ['StrikethroughMark'] : ['CodeMark'];
                    for (const kind of delimiter) {
                        for (const mark of node.node.getChildren(kind)) marks.push({ from: mark.from, to: mark.to });
                    }
                    result.constructs.push({ from: node.from, to: node.to, className, marks });
                }
            }
        },
    });
    return result;
}

function linesOfRange(doc: Text, from: number, to: number): number[] {
    const start = doc.lineAt(Math.max(0, Math.min(from, doc.length))).number;
    const end = doc.lineAt(Math.max(0, Math.min(to, doc.length))).number;
    const lines: number[] = [];
    for (let line = start; line <= end; line += 1) lines.push(line);
    return lines;
}

/** Ranges the app renders through markdown-it because markers alone cannot express them. */
function patternOpaque(doc: Text, viewport: { from: number; to: number }, collected: Collected): LiveHide[] {
    const ranges: LiveHide[] = [];
    const source = doc.sliceString(viewport.from, viewport.to);

    if (viewport.from === 0) {
        const frontMatter = FRONT_MATTER_RE.exec(source);
        if (frontMatter) ranges.push({ from: 0, to: frontMatter[0].length });
    }

    for (const match of source.matchAll(BLOCK_MATH_RE)) {
        const from = viewport.from + (match.index ?? 0);
        ranges.push({ from, to: from + match[0].length });
    }

    for (const paragraph of collected.paragraphs) {
        if (paragraph.from < viewport.from || paragraph.to > viewport.to) continue;
        const text = doc.sliceString(paragraph.from, paragraph.to);
        if (INLINE_SPECIAL_RE.test(text)) ranges.push({ from: paragraph.from, to: paragraph.to });
    }
    return ranges;
}

function overlaps(ranges: LiveHide[], from: number, to: number): boolean {
    return ranges.some((range) => range.from < to && range.to > from);
}

/**
 * Obsidian-style `[[Note]]` ranges. The Markdown tree only covers the inner `[Note]`,
 * so the outer brackets are located line-wise to avoid leaving stray `[` characters.
 */
function wikiRanges(doc: Text, viewport: { from: number; to: number }): LiveHide[] {
    const ranges: LiveHide[] = [];
    const first = doc.lineAt(viewport.from).number;
    const last = doc.lineAt(viewport.to).number;
    for (let number = first; number <= last; number += 1) {
        const line = doc.line(number);
        WIKI_RE.lastIndex = 0;
        for (const match of line.text.matchAll(WIKI_RE)) {
            const from = line.from + (match.index ?? 0);
            ranges.push({ from, to: from + match[0].length });
        }
    }
    return ranges;
}

/**
 * Compute live-preview decorations for a viewport.
 *
 * `caretLines` holds the 1-based lines touched by the selection; markers on those lines are
 * left visible so the caret line always shows its Markdown.
 */
export function computeLiveDecorations(
    doc: Text,
    tree: Tree,
    caretLines: Set<number>,
    viewport: { from: number; to: number },
): LiveDecorations {
    const collected = collect(tree, viewport, doc);
    const hide: LiveHide[] = [];
    const lines: LiveLine[] = [];
    const marks: LiveMark[] = [];
    const replaces: LiveReplace[] = [];
    const opaque: LiveHide[] = [...collected.opaque, ...patternOpaque(doc, viewport, collected)];

    const revealed = (pos: number) => caretLines.has(doc.lineAt(Math.max(0, Math.min(pos, doc.length))).number);

    // Headings: hide the `#` run and align the line with the preview heading scale.
    for (const heading of collected.headings) {
        const level = Number(heading.level);
        for (const line of linesOfRange(doc, heading.mark?.from ?? 0, heading.mark?.to ?? 0)) {
            if (caretLines.has(line)) continue;
            const text = doc.line(line).text;
            const width = /^#{1,6}\s+/.exec(text)?.[0].length ?? 0;
            if (heading.mark && doc.line(line).from === heading.mark.from) {
                hide.push({ from: heading.mark.from, to: heading.mark.from + width });
            }
        }
        const line = doc.lineAt(heading.mark?.from ?? 0).number;
        lines.push({ line, classes: `cm-live-heading cm-live-h${level}` });
    }

    // Callouts and plain quotes: the card chrome lives on the line decorations.
    for (const quote of collected.quotes) {
        if (overlaps(opaque, quote.from, quote.to)) continue;
        const rangeLines = linesOfRange(doc, quote.from, quote.to);
        const firstLine = doc.line(rangeLines[0]!);
        const callout = CALLOUT_RE.exec(firstLine.text);
        const type = callout ? callout[2]!.toLowerCase() : '';
        let titleText: { from: number; to: number } | undefined;
        for (const line of rangeLines) {
            const classes = ['cm-live-quote'];
            if (callout) classes.push('cm-live-callout', `cm-live-callout-${type}`);
            if (line === rangeLines[0]) classes.push('cm-live-quote-first');
            if (line === rangeLines[rangeLines.length - 1]) classes.push('cm-live-quote-last');
            lines.push({ line, classes: classes.join(' ') });
        }
        if (callout) {
            // `> [!type] Title` -> keep only `Title`, rendered as the callout title.
            const line = doc.line(rangeLines[0]!);
            const markerStart = line.from + (callout[1]?.length ?? 0);
            const bracket = line.text.indexOf('[!', callout[1]?.length ?? 0);
            if (bracket >= 0) {
                const close = line.text.indexOf(']', bracket);
                if (close >= 0) {
                    let end = close + 1;
                    while (end < line.text.length && (line.text[end] === ' ' || line.text[end] === '\t')) end += 1;
                    if (!caretLines.has(line.number)) hide.push({ from: markerStart, to: line.from + end });
                    titleText = { from: line.from + end, to: line.to };
                }
            }
        }
        if (titleText && titleText.to > titleText.from) {
            marks.push({ from: titleText.from, to: titleText.to, className: 'cm-live-quote-title' });
        }
    }

    // Quote marks that are not part of a callout title: hide `> ` in place.
    for (const quoteMark of collected.quoteMarks) {
        if (revealed(quoteMark.from)) continue;
        if (overlaps(opaque, quoteMark.from, quoteMark.to)) continue;
        const line = doc.lineAt(quoteMark.from);
        const rest = line.text.slice(quoteMark.from - line.from + (quoteMark.to - quoteMark.from));
        const trailing = rest.startsWith(' ') ? 1 : 0;
        // Skip the callout title line, which was hidden as one range above.
        if (CALLOUT_RE.test(line.text)) continue;
        hide.push({ from: quoteMark.from, to: quoteMark.to + trailing });
    }

    // Inline constructs: hide delimiters, style the inner text.
    for (const construct of collected.constructs) {
        const line = doc.lineAt(construct.from).number;
        const prefix = construct.marks.filter((mark) => mark.from === construct.from);
        const suffix = construct.marks.filter((mark) => mark.to === construct.to);
        const innerFrom = prefix.length ? prefix[prefix.length - 1]!.to : construct.from;
        const innerTo = suffix.length ? suffix[0]!.from : construct.to;
        if (innerTo > innerFrom) marks.push({ from: innerFrom, to: innerTo, className: construct.className });
        if (caretLines.has(line) || overlaps(opaque, construct.from, construct.to)) continue;
        for (const mark of construct.marks) hide.push(mark);
    }

    // Wiki links: hide the double brackets, style the target. The tree only covers `[Note]`.
    const wikis = wikiRanges(doc, viewport).filter((range) => !overlaps(opaque, range.from, range.to));
    for (const wiki of wikis) {
        const line = doc.lineAt(wiki.from).number;
        if (!caretLines.has(line)) {
            hide.push({ from: wiki.from, to: Math.min(wiki.from + 2, wiki.to) });
            hide.push({ from: Math.max(wiki.to - 2, wiki.from), to: wiki.to });
        }
        if (wiki.to - 2 > wiki.from + 2) marks.push({ from: wiki.from + 2, to: wiki.to - 2, className: 'cm-md-wikilink' });
    }

    // Links: hide brackets and destination, style the label.
    for (const link of collected.links) {
        if (overlaps(wikis, link.from, link.to)) continue;
        const line = doc.lineAt(link.from);
        const label = doc.sliceString(link.from, link.to).replace(/^\[/, '').replace(/\]$/, '');
        const labelFrom = link.marks.find((mark) => mark.from === link.from)?.to ?? link.from;
        const labelTo = link.marks.filter((mark) => mark.to === link.to).pop()?.from ?? link.to;
        if (labelTo > labelFrom && /\S/.test(label)) marks.push({ from: labelFrom, to: labelTo, className: 'cm-live-link' });
        if (caretLines.has(line.number) || overlaps(opaque, link.from, link.to)) continue;
        for (const mark of link.marks) hide.push(mark);
        if (link.url) hide.push(link.url);
    }

    // Images become real images, keeping the source untouched behind the widget.
    for (const image of collected.images) {
        if (caretLines.has(doc.lineAt(image.from).number) || overlaps(opaque, image.from, image.to)) continue;
        replaces.push({ from: image.from, to: image.to, kind: 'image', src: image.src, alt: image.alt });
    }

    // Lists: replace the marker with a rendered bullet or number.
    for (const list of collected.listMarks) {
        if (revealed(list.from) || overlaps(opaque, list.from, list.to)) continue;
        const line = doc.lineAt(list.from);
        const trailing = line.text[list.to - line.from] === ' ' ? 1 : 0;
        replaces.push({ from: list.from, to: list.to + trailing, kind: list.ordered ? 'ordered' : 'bullet', marker: list.marker, depth: list.depth });
    }

    // Task markers: replace `[ ]` with a checkbox once the caret is elsewhere.
    for (const task of collected.tasks) {
        if (revealed(task.from) || overlaps(opaque, task.from, task.to)) continue;
        replaces.push({ from: task.from, to: task.to, kind: 'checkbox', checked: task.checked });
    }

    // Horizontal rules: replace the dashes with a rule line.
    for (const rule of collected.rules) {
        if (revealed(rule.from) || overlaps(opaque, rule.from, rule.to)) continue;
        replaces.push({ from: rule.from, to: rule.to, kind: 'rule' });
    }

    return {
        hide,
        lines,
        marks,
        replaces,
        opaque,
        hasTokens: hide.length + lines.length + marks.length + replaces.length > 0,
    };
}
