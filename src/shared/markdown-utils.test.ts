import { describe, expect, it } from 'vitest'
import { extractAttachmentIds, extractTags, firstImageSrc, extractImageSrcs } from './markdown-utils'

describe('extractTags', () => {
  it('handles an unterminated inline-code marker with a mismatched trailing marker', () => {
    expect(extractTags('` #visible ``')).toEqual(['visible'])
  })

  it('does not treat tags in complete inline code or fenced blocks as tags', () => {
    expect(extractTags('`#inline`\n```\n#fenced\n```\n#visible')).toEqual(['visible'])
  })
})

describe('extractAttachmentIds', () => {
  const idA = '01m1r8923zajxnw9y0dhs6sy8j'
  const idB = '01m1r9qq6zb99ef3cqkjrzrn89'

  it('collects plain and angle-bracket references outside code regions', () => {
    expect(extractAttachmentIds(
      `![a](/api/files/${idA})\n\n![b](</api/files/${idB} "t">)`,
    )).toEqual([idA, idB])
  })

  it('ignores references inside ordinary fenced code', () => {
    expect(extractAttachmentIds(
      '```\n![a](/api/files/' + idA + ')\n```\n![b](/api/files/' + idB + ')',
    )).toEqual([idB])
  })

  it('collects references inside md-example fences, which render as live markdown', () => {
    expect(extractAttachmentIds(
      `~~~~md-example title="Image"\n![a](</api/files/${idA} "a">)\n~~~~`,
    )).toEqual([idA])
  })

  it('keeps stripping nested ordinary code inside an md-example fence', () => {
    expect(extractAttachmentIds(
      `~~~~md-example\n\`\`\`\n![a](/api/files/${idA})\n\`\`\`\n![b](/api/files/${idB})\n~~~~`,
    )).toEqual([idB])
  })

  it('accepts the markdown-example alias', () => {
    expect(extractAttachmentIds(
      `~~~markdown-example\n![a](/api/files/${idA})\n~~~`,
    )).toEqual([idA])
  })

  it('does not close an md-example fence on a marker followed by text', () => {
    expect(extractAttachmentIds(
      `~~~~md-example\n![a](/api/files/${idA})\n~~~~ trailing\n![b](/api/files/${idB})`,
    )).toEqual([idB, idA])
  })
})

describe('firstImageSrc', () => {
  it('returns null for empty or imageless markdown', () => {
    expect(firstImageSrc('')).toBeNull()
    expect(firstImageSrc('just some text\n\nno image here')).toBeNull()
  })

  it('returns the first inline image, ignoring front matter', () => {
    const content = `---
title: Hello
---
Intro text.

![cover](/api/files/abc)

![later](/api/files/def)`
    expect(firstImageSrc(content)).toBe('/api/files/abc')
  })

  it('supports an angle-bracketed URL and an optional title', () => {
    expect(firstImageSrc('![x](</api/files/ghi> "title")')).toBe('/api/files/ghi')
  })

  it('ignores images inside code blocks', () => {
    expect(firstImageSrc('```\n![nope](/api/files/xyz)\n```\n![yes](/api/files/ok)')).toBe('/api/files/ok')
  })

  it('resolves reference-style images', () => {
    const content = '![alt][ref]\n\n[ref]: /api/files/refd "Ref title"'
    expect(firstImageSrc(content)).toBe('/api/files/refd')
  })

  it('resolves remote images as-is', () => {
    expect(firstImageSrc('![a](https://example.com/a.png)')).toBe('https://example.com/a.png')
  })
})

describe('extractImageSrcs', () => {
  it('returns empty array for empty or imageless markdown', () => {
    expect(extractImageSrcs('')).toEqual([])
    expect(extractImageSrcs('just text')).toEqual([])
  })

  it('collects all inline images in order, ignoring front matter', () => {
    const content = `---
title: Hello
---
![a](/api/files/abc)

![b](/api/files/def)`
    expect(extractImageSrcs(content)).toEqual(['/api/files/abc', '/api/files/def'])
  })

  it('de-duplicates by URL', () => {
    expect(extractImageSrcs('![a](/api/files/abc)\n![a2](/api/files/abc)')).toEqual(['/api/files/abc'])
  })

  it('ignores images inside code blocks', () => {
    expect(extractImageSrcs('```\n![nope](/api/files/xyz)\n```\n![yes](/api/files/ok)')).toEqual(['/api/files/ok'])
  })

  it('resolves reference-style images', () => {
    const content = '![alt][ref]\n\n[ref]: /api/files/refd "Ref Title"'
    expect(extractImageSrcs(content)).toEqual(['/api/files/refd'])
  })

  it('handles a mix of inline and reference-style images', () => {
    const content = '![a](/api/files/abc)\n![b][ref]\n\n[ref]: /api/files/def'
    expect(extractImageSrcs(content)).toEqual(['/api/files/abc', '/api/files/def'])
  })
})
