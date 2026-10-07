import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { computeLiveDecorations } from './live-markers';

function run(source: string, caretLines: number[] = []) {
    const doc = Text.of(source.split('\n'));
    const tree = markdownLanguage.parser.parse(source);
    return computeLiveDecorations(doc, tree, new Set(caretLines), { from: 0, to: doc.length });
}

/** Slice helper: the visible text once hidden and replaced ranges are removed. */
function visible(source: string, result: ReturnType<typeof run>): string {
    const hidden = [...result.hide, ...result.replaces].sort((a, b) => a.from - b.from);
    let output = '';
    let cursor = 0;
    for (const range of hidden) {
        output += source.slice(cursor, range.from);
        cursor = Math.max(cursor, range.to);
    }
    return output + source.slice(cursor);
}

describe('live markers: headings', () => {
    it('hides the hash run and tags the line with its level', () => {
        const source = '## Title';
        const result = run(source);
        expect(visible(source, result)).toBe('Title');
        expect(result.lines).toEqual([{ line: 1, classes: 'cm-live-heading cm-live-h2' }]);
    });

    it('reveals the hash run on the caret line', () => {
        const source = '# One\n\n## Two';
        const result = run(source, [3]);
        expect(visible(source, result)).toContain('## Two');
        expect(visible(source, result).startsWith('# One')).toBe(false);
    });
});

describe('live markers: callouts', () => {
    const source = ['> [!danger] 账号 · 密钥 · 资产', '> - item a', '> - item b'].join('\n');

    it('hides the marker and the quote prefixes while keeping the title', () => {
        const result = run(source);
        const text = visible(source, result);
        expect(text).toContain('账号 · 密钥 · 资产');
        expect(text).not.toContain('[!danger]');
        expect(text).not.toContain('>');
    });

    it('marks the title and colours every line of the block', () => {
        const result = run(source);
        expect(result.marks.some((mark) => mark.className === 'cm-live-quote-title')).toBe(true);
        expect(result.lines.map((line) => line.line)).toEqual([1, 2, 3]);
        expect(result.lines[0]!.classes).toContain('cm-live-callout-danger');
        expect(result.lines[0]!.classes).toContain('cm-live-quote-first');
        expect(result.lines[2]!.classes).toContain('cm-live-quote-last');
    });

    it('turns nested list markers into bullets', () => {
        const result = run(source);
        const bullets = result.replaces.filter((replace) => replace.kind === 'bullet');
        expect(bullets).toHaveLength(2);
        expect(bullets[0]).toMatchObject({ from: source.indexOf('- item a'), to: source.indexOf('- item a') + 2 });
    });

    it('keeps the card chrome but reveals the caret line', () => {
        const result = run(source, [2]);
        expect(result.lines).toHaveLength(3);
        expect(visible(source, result)).toContain('> - item a');
        expect(visible(source, result)).toContain('item b');
    });

    it('never marks a callout as an opaque widget', () => {
        expect(run(source).opaque).toHaveLength(0);
    });
});

describe('live markers: plain quotes', () => {
    it('styles the quote without callout classes', () => {
        const result = run('> quoted text');
        expect(result.lines[0]!.classes).toContain('cm-live-quote');
        expect(result.lines[0]!.classes).not.toContain('cm-live-callout');
    });
});

describe('live markers: inline constructs', () => {
    it('hides bold, italic, strike and code delimiters and styles the inner text', () => {
        const source = 'text **bold** and *it* and ~~gone~~ and `code`';
        const result = run(source);
        const text = visible(source, result);
        expect(text).toBe('text bold and it and gone and code');
        const classes = result.marks.map((mark) => mark.className);
        expect(classes).toEqual(expect.arrayContaining(['cm-live-strong', 'cm-live-em', 'cm-live-strike', 'cm-live-code']));
    });

    it('reveals delimiters on the caret line', () => {
        const source = '**bold**';
        expect(visible(source, run(source, [1]))).toBe('**bold**');
    });
});

describe('live markers: links and wiki links', () => {
    it('hides brackets and destination but keeps the label', () => {
        const source = 'see [label](https://example.com/x) now';
        const result = run(source);
        expect(visible(source, result)).toBe('see label now');
        expect(result.marks.some((mark) => mark.className === 'cm-live-link')).toBe(true);
    });

    it('renders wiki links without stray brackets', () => {
        const source = 'go [[Wiki Note]] now';
        const result = run(source);
        expect(visible(source, result)).toBe('go Wiki Note now');
        expect(result.marks.some((mark) => mark.className === 'cm-md-wikilink')).toBe(true);
    });
});

describe('live markers: lists, tasks and rules', () => {
    it('replaces bullet and ordered markers with rendered markers', () => {
        const source = '- one\n\n1. first\n2. second';
        const result = run(source);
        const kinds = result.replaces.map((replace) => replace.kind);
        expect(kinds.filter((kind) => kind === 'bullet')).toHaveLength(1);
        expect(kinds.filter((kind) => kind === 'ordered')).toHaveLength(2);
    });

    it('tracks nesting depth for indented bullets', () => {
        const source = '- outer\n  - inner';
        const result = run(source);
        const bullets = result.replaces.filter((replace) => replace.kind === 'bullet');
        expect(bullets.map((bullet) => bullet.depth)).toEqual([0, 1]);
    });

    it('replaces task markers with checkboxes carrying their state', () => {
        const source = '- [ ] todo\n- [x] done';
        const result = run(source);
        const boxes = result.replaces.filter((replace) => replace.kind === 'checkbox');
        expect(boxes.map((box) => box.checked)).toEqual([false, true]);
        expect(visible(source, result)).not.toContain('[ ]');
        expect(visible(source, result)).not.toContain('[x]');
    });

    it('replaces horizontal rules', () => {
        const source = 'above\n\n---\n\nbelow';
        const result = run(source);
        expect(result.replaces.some((replace) => replace.kind === 'rule')).toBe(true);
        expect(visible(source, result)).not.toContain('---');
    });
});

describe('live markers: opaque blocks keep the widget path', () => {
    it('flags tables and fenced code', () => {
        const source = '| A | B |\n| - | - |\n| C | D |\n\n```js\nconst x = 1\n```';
        const result = run(source);
        expect(result.opaque).toHaveLength(2);
        expect(visible(source, result)).toContain('| A | B |');
    });

    it('flags front matter, block math and note embeds', () => {
        const frontMatter = run('---\ntitle: x\n---\n\nbody');
        expect(frontMatter.opaque.some((range) => range.from === 0)).toBe(true);

        const math = run('intro\n\n$$\na = b\n$$\n\nend');
        expect(math.opaque.length).toBeGreaterThanOrEqual(1);

        const embed = run('before\n\n![[Some Note]]\n\nafter');
        expect(embed.opaque.length).toBeGreaterThanOrEqual(1);
    });

    it('leaves opaque content untouched by marker hiding', () => {
        const source = '| A | B |\n| - | - |\n| C | D |';
        const result = run(source);
        expect(result.hide).toHaveLength(0);
        expect(result.replaces).toHaveLength(0);
    });
});
