import { describe, expect, it } from 'vitest'
import { deriveExcerpt } from '@shared/markdown-utils'
import { insertSummary, normalizeTitle, summaryInsertLine } from './summary'

const SUMMARY = 'Release moved from manual steps to a script, and two silent failures were fixed.'

describe('summaryInsertLine', () => {
  it('puts the summary first when there is neither frontmatter nor a heading', () => {
    expect(summaryInsertLine('Body starts here.\n\nMore body.')).toBe(0)
  })

  it('skips past frontmatter', () => {
    expect(summaryInsertLine('---\ntitle: X\n---\n\nBody.')).toBe(3)
  })

  it('skips past a top-level heading', () => {
    expect(summaryInsertLine('# Title\n\nBody.')).toBe(1)
  })

  it('skips past both frontmatter and heading', () => {
    expect(summaryInsertLine('---\ntitle: X\n---\n\n# Title\n\nBody.')).toBe(5)
  })

  it('does not treat an unclosed fence as frontmatter', () => {
    expect(summaryInsertLine('---\ntitle: X\n\nBody without a closing fence.')).toBe(0)
  })

  it('handles a note that is only frontmatter', () => {
    expect(summaryInsertLine('---\ntitle: X\n---')).toBe(3)
  })

  it('handles empty content', () => {
    expect(summaryInsertLine('')).toBe(0)
  })

  it('only skips a level-one heading, not a level-two one', () => {
    expect(summaryInsertLine('## Section\n\nBody.')).toBe(0)
  })
})

describe('insertSummary', () => {
  it('places the summary above the body as a plain block quote', () => {
    expect(insertSummary('Body.', SUMMARY)).toBe(`> ${SUMMARY}\n\nBody.`)
  })

  it('keeps the summary below frontmatter and heading', () => {
    const note = '---\ntitle: X\n---\n\n# Title\n\nBody.'
    expect(insertSummary(note, SUMMARY)).toBe(
      `---\ntitle: X\n---\n\n# Title\n\n> ${SUMMARY}\n\nBody.`,
    )
  })

  it('loses none of the original text', () => {
    const note = '---\ntitle: X\n---\n\n# Title\n\nAlpha.\n\nBravo.'
    const result = insertSummary(note, SUMMARY)
    for (const piece of ['title: X', '# Title', 'Alpha.', 'Bravo.']) {
      expect(result).toContain(piece)
    }
  })

  it('does not use callout syntax, which leaks into the note list preview', () => {
    expect(insertSummary('Body.', SUMMARY)).not.toContain('[!')
  })

  it('adds a second block when called twice, rather than silently deduplicating', () => {
    const once = insertSummary('Body.', SUMMARY)
    const twice = insertSummary(once, 'Another summary.')
    expect(twice.split('\n').filter((line) => line.startsWith('> '))).toHaveLength(2)
  })

  it('returns the content untouched for an empty summary', () => {
    expect(insertSummary('Body.', '   ')).toBe('Body.')
  })

  it('quotes every line of a multi-line summary', () => {
    const result = insertSummary('Body.', 'First line.\nSecond line.')
    expect(result.startsWith('> First line.\n> Second line.\n\nBody.')).toBe(true)
  })
})

describe('the excerpt a summarised note produces', () => {
  it('starts with the summary itself, with no markup left in it', () => {
    const note = '---\ntitle: Weekly\ntags: [work]\n---\n\n# Weekly\n\n## Background\n\nThe old release took six manual commands.'
    const excerpt = deriveExcerpt(insertSummary(note, SUMMARY))
    expect(excerpt.startsWith(SUMMARY)).toBe(true)
    expect(excerpt).not.toContain('>')
    expect(excerpt).not.toContain('[!')
  })

  it('changes the excerpt compared with the same note before summarising', () => {
    const note = '# Weekly\n\n## Background\n\nThe old release took six manual commands.'
    expect(deriveExcerpt(insertSummary(note, SUMMARY))).not.toBe(deriveExcerpt(note))
  })
})

describe('normalizeTitle', () => {
  it('takes the first non-empty line', () => {
    expect(normalizeTitle('\n\nWeekly release notes\nignored second line')).toBe('Weekly release notes')
  })

  it('strips a heading marker', () => {
    expect(normalizeTitle('# Weekly release notes')).toBe('Weekly release notes')
  })

  it('strips paired quotes of several kinds', () => {
    expect(normalizeTitle('"Weekly notes"')).toBe('Weekly notes')
    expect(normalizeTitle("'Weekly notes'")).toBe('Weekly notes')
    expect(normalizeTitle('\u300c\u6bcf\u5468\u8bb0\u5f55\u300d')).toBe('\u6bcf\u5468\u8bb0\u5f55')
    expect(normalizeTitle('\u300a\u6bcf\u5468\u8bb0\u5f55\u300b')).toBe('\u6bcf\u5468\u8bb0\u5f55')
  })

  it('leaves an unpaired quote alone', () => {
    expect(normalizeTitle('"Weekly notes')).toBe('"Weekly notes')
  })

  it('strips emphasis markers', () => {
    expect(normalizeTitle('**Weekly notes**')).toBe('Weekly notes')
  })

  it('drops a trailing full stop in either script', () => {
    expect(normalizeTitle('Weekly notes.')).toBe('Weekly notes')
    expect(normalizeTitle('\u6bcf\u5468\u8bb0\u5f55\u3002')).toBe('\u6bcf\u5468\u8bb0\u5f55')
  })

  it('truncates to the title limit', () => {
    expect(normalizeTitle('x'.repeat(600))).toHaveLength(512)
  })

  it('returns an empty string for blank input, so the caller can refuse it', () => {
    expect(normalizeTitle('   \n  ')).toBe('')
    expect(normalizeTitle('')).toBe('')
  })
})
