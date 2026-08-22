import { beforeEach, describe, expect, it } from 'vitest'
import {
  WHOLE_NOTE_RANGE,
  applyToTarget,
  isTargetUnchanged,
  isWholeNote,
  setAiPanelRequest,
  takeAiPanelRequest,
  type AiPanelTarget,
} from './request'

const NOTE = 'alpha\nbravo\ncharlie'

function selectionTarget(from: number, to: number, originalText = NOTE.slice(from, to)): AiPanelTarget {
  return { noteId: 'n1', from, to, originalText }
}

function wholeTarget(originalText = NOTE): AiPanelTarget {
  return { noteId: 'n1', from: WHOLE_NOTE_RANGE, to: WHOLE_NOTE_RANGE, originalText }
}

describe('AI panel request handoff', () => {
  beforeEach(() => {
    takeAiPanelRequest()
  })

  it('has nothing pending to begin with', () => {
    expect(takeAiPanelRequest()).toBeNull()
  })

  it('hands the request over exactly once', () => {
    setAiPanelRequest({ mode: 'convert', input: '', target: null })
    expect(takeAiPanelRequest()).toEqual({ mode: 'convert', input: '', target: null })
    expect(takeAiPanelRequest()).toBeNull()
  })

  it('replaces an unconsumed request rather than queueing', () => {
    setAiPanelRequest({ mode: 'convert', input: 'first', target: null })
    setAiPanelRequest({ mode: 'tidy', input: 'second', target: selectionTarget(0, 5) })
    const taken = takeAiPanelRequest()
    expect(taken?.mode).toBe('tidy')
    expect(taken?.input).toBe('second')
    expect(takeAiPanelRequest()).toBeNull()
  })
})

describe('isWholeNote', () => {
  it('recognizes the whole-note sentinel', () => {
    expect(isWholeNote(wholeTarget())).toBe(true)
  })

  it('treats a real range as a partial selection', () => {
    expect(isWholeNote(selectionTarget(0, 0))).toBe(false)
    expect(isWholeNote(selectionTarget(3, 9))).toBe(false)
    expect(isWholeNote({ noteId: 'n1', from: WHOLE_NOTE_RANGE, to: 9, originalText: '' })).toBe(false)
    expect(isWholeNote({ noteId: 'n1', from: 3, to: WHOLE_NOTE_RANGE, originalText: '' })).toBe(false)
  })
})

describe('isTargetUnchanged', () => {
  it('accepts a selection whose text is still exactly where it was', () => {
    expect(isTargetUnchanged(NOTE, selectionTarget(6, 11))).toBe(true)
  })

  it('rejects a selection whose text was edited in place', () => {
    expect(isTargetUnchanged('alpha\nBRAVO\ncharlie', selectionTarget(6, 11))).toBe(false)
  })

  it('rejects a selection that shifted because text was inserted before it', () => {
    expect(isTargetUnchanged(`prefix\n${NOTE}`, selectionTarget(6, 11))).toBe(false)
  })

  it('rejects a selection whose range no longer exists', () => {
    expect(isTargetUnchanged('tiny', selectionTarget(6, 11))).toBe(false)
  })

  it('accepts a whole-note target when the body is byte-identical', () => {
    expect(isTargetUnchanged(NOTE, wholeTarget())).toBe(true)
  })

  it('rejects a whole-note target when anything at all changed', () => {
    expect(isTargetUnchanged(`${NOTE}\ndelta`, wholeTarget())).toBe(false)
    expect(isTargetUnchanged(NOTE.slice(0, -1), wholeTarget())).toBe(false)
  })
})

describe('applyToTarget', () => {
  it('splices a selection back into place', () => {
    expect(applyToTarget(NOTE, selectionTarget(6, 11), 'BRAVO!')).toBe('alpha\nBRAVO!\ncharlie')
  })

  it('replaces the whole body for a whole-note target', () => {
    expect(applyToTarget(NOTE, wholeTarget(), 'fresh')).toBe('fresh')
  })

  it('keeps everything outside the selection untouched', () => {
    const result = applyToTarget(NOTE, selectionTarget(0, 5), 'ALPHA')
    expect(result).toBe('ALPHA\nbravo\ncharlie')
    expect(result.endsWith('\nbravo\ncharlie')).toBe(true)
  })
})
