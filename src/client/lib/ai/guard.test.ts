import { describe, expect, it } from 'vitest'
import { SHORT_OUTPUT_MIN_INPUT, SHORT_OUTPUT_RATIO, detectLoss, splitForChunking } from './guard'

const longInput = 'x'.repeat(1000)

describe('detectLoss', () => {
  it('reports truncation when the model hit its output cap', () => {
    expect(detectLoss({ input: 'a', output: 'b', finishReason: 'length', isFirstTurn: true })).toEqual({
      kind: 'truncated',
    })
  })

  it('reports truncation even on a refine turn', () => {
    expect(detectLoss({ input: 'a', output: 'b', finishReason: 'length', isFirstTurn: false })?.kind).toBe('truncated')
  })

  it('catches input-side loss that finish_reason never reports', () => {
    const loss = detectLoss({ input: longInput, output: 'y'.repeat(100), finishReason: 'stop', isFirstTurn: true })
    expect(loss?.kind).toBe('short')
    expect(loss?.ratio).toBeCloseTo(0.1)
  })

  it('stays quiet when the output is proportionate', () => {
    expect(detectLoss({ input: longInput, output: 'y'.repeat(900), finishReason: 'stop', isFirstTurn: true })).toBeNull()
  })

  it('treats exactly the ratio boundary as acceptable', () => {
    const output = 'y'.repeat(longInput.length * SHORT_OUTPUT_RATIO)
    expect(detectLoss({ input: longInput, output, finishReason: 'stop', isFirstTurn: true })).toBeNull()
  })

  it('ignores short inputs, where a terse result is normal', () => {
    const input = 'x'.repeat(SHORT_OUTPUT_MIN_INPUT - 1)
    expect(detectLoss({ input, output: '', finishReason: 'stop', isFirstTurn: true })).toBeNull()
  })

  it('ignores refine turns, which legitimately shorten the text', () => {
    expect(detectLoss({ input: longInput, output: 'y', finishReason: 'stop', isFirstTurn: false })).toBeNull()
  })
})

describe('splitForChunking', () => {
  it('returns the text whole when it already fits', () => {
    expect(splitForChunking('hello', 10)).toEqual(['hello'])
  })

  it('treats a non-positive limit as chunking disabled', () => {
    const text = 'a'.repeat(50)
    expect(splitForChunking(text, 0)).toEqual([text])
    expect(splitForChunking(text, -5)).toEqual([text])
  })

  it('returns nothing for empty text', () => {
    expect(splitForChunking('', 10)).toEqual([])
  })

  it('keeps text of exactly the limit in one piece', () => {
    expect(splitForChunking('abcde', 5)).toEqual(['abcde'])
  })

  it('prefers paragraph boundaries and packs greedily', () => {
    const pieces = splitForChunking('aaa\n\nbbb\n\nccc', 8)
    expect(pieces).toEqual(['aaa\n\nbbb', 'ccc'])
  })

  it('falls back to line boundaries for an oversized paragraph', () => {
    const pieces = splitForChunking('aaaa\nbbbb\ncccc', 9)
    expect(pieces).toEqual(['aaaa\nbbbb', 'cccc'])
    expect(pieces.every((piece) => piece.length <= 9)).toBe(true)
  })

  it('hard-cuts a single unbroken run longer than the limit', () => {
    const pieces = splitForChunking('abcdefghij', 4)
    expect(pieces).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('never emits a piece longer than the limit', () => {
    const text = ['short', 'y'.repeat(30), 'tail'].join('\n\n')
    for (const piece of splitForChunking(text, 12)) {
      expect(piece.length).toBeLessThanOrEqual(12)
    }
  })

  it('drops blank-only pieces', () => {
    expect(splitForChunking('aaa\n\n   \n\nbbb', 4)).toEqual(['aaa', 'bbb'])
  })

  it('loses no characters other than the separators it splits on', () => {
    const text = Array.from({ length: 40 }, (_, index) => `paragraph ${index}`).join('\n\n')
    const rejoined = splitForChunking(text, 50).join('\n\n')
    expect(rejoined.replace(/\s/g, '')).toBe(text.replace(/\s/g, ''))
  })
})
