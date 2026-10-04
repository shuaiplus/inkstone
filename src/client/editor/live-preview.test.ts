import { describe, expect, it } from 'vitest';
import { renderMarkdownBlocks } from '../lib/markdown/renderer';
import { mergeSettings, mergeSettingsPatch } from '@shared/constants';

describe('live preview Markdown compatibility', () => {
    it('defaults to live rendering and preserves an explicit opt-out across settings updates', () => {
        expect(mergeSettings({}).editor.livePreview).toBe(true);
        expect(mergeSettings({ editor: { livePreview: 'false' } }).editor.livePreview).toBe(true);
        const settings = mergeSettings({ editor: { livePreview: false } });
        expect(settings.editor.livePreview).toBe(false);
        expect(mergeSettingsPatch(settings, { editor: { fontSize: 18 }, preview: { layout: 'split' } }).editor.livePreview).toBe(false);
    });
    it('migrates old layouts while preserving split and unrelated settings', () => {
        for (const layout of ['edit', 'live']) {
            const settings = mergeSettings({ preview: { layout, math: false }, editor: { tabSize: 4 } });
            expect(settings.preview.layout).toBe('live');
            expect(settings.preview.math).toBe(false);
            expect(settings.editor.tabSize).toBe(4);
        }
        for (const layout of ['split', 'preview']) expect(mergeSettings({ preview: { layout } }).preview.layout).toBe(layout);
    });
    it('retains document-wide references and source lines across nested blocks', () => {
        const source = '# Heading\n\n[Reference][ref]\n\n- [ ] one\n  - [x] two\n\n| A | B |\n| - | - |\n| C | D |\n\n[ref]: https://example.com';
        const { blocks, headings } = renderMarkdownBlocks(source);
        expect(blocks.map((block) => [block.startLine, block.endLine])).toEqual([[0, 1], [2, 3], [4, 7], [7, 10]]);
        expect(blocks[1]!.html).toContain('href="https://example.com"');
        expect(blocks[2]!.html).toContain('data-task-line="4"');
        expect(blocks[2]!.html).toContain('data-task-line="5"');
        expect(blocks[3]!.html).toContain('<table');
        expect(headings[0]?.line).toBe(0);
    });
    it('keeps sanitization and comments source mapping intact', () => {
        const { blocks } = renderMarkdownBlocks('%% SECRET_COMMENT %%\n\n# Visible\n\n<img src="x" onerror="alert(1)">\n\n<script>alert(1)</script>');
        const html = blocks.map((block) => block.html).join('');
        expect(html).not.toContain('onerror');
        expect(html).not.toContain('<script');
        expect(html).not.toContain('SECRET_COMMENT');
        expect(blocks.find((block) => block.html.includes('Visible'))?.startLine).toBe(2);
    });
});
