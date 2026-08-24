import { LIMITS } from '@shared/constants'

const QUOTE_PAIRS: Array<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['\u201c', '\u201d'],
  ['\u2018', '\u2019'],
  ['\u300c', '\u300d'],
  ['\u300e', '\u300f'],
  ['\u300a', '\u300b'],
]

function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return 0
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') return index + 1
  }
  return 0
}

function headingEnd(lines: string[], from: number): number {
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    return /^#\s+\S/.test(line) ? index + 1 : from
  }
  return from
}

export function summaryInsertLine(content: string): number {
  const lines = content.split('\n')
  return headingEnd(lines, frontmatterEnd(lines))
}

export function insertSummary(content: string, summary: string): string {
  const text = summary.trim()
  if (!text) return content
  const block = text
    .split('\n')
    .map((line) => `> ${line.trim()}`.trimEnd())
    .join('\n')
  const lines = content.split('\n')
  const at = summaryInsertLine(content)
  const before = lines.slice(0, at)
  const after = lines.slice(at)
  while (before.length && !before[before.length - 1].trim()) before.pop()
  while (after.length && !after[0].trim()) after.shift()
  const head = before.length ? [...before, ''] : []
  const tail = after.length ? ['', ...after] : []
  return [...head, block, ...tail].join('\n')
}

export function normalizeTitle(raw: string): string {
  let text = (raw ?? '').split('\n').find((line) => line.trim()) ?? ''
  text = text.trim()
  text = text.replace(/^#{1,6}\s+/, '')
  for (;;) {
    const pair = QUOTE_PAIRS.find(([open, close]) =>
      text.length > 1 && text.startsWith(open) && text.endsWith(close))
    if (!pair) break
    text = text.slice(pair[0].length, text.length - pair[1].length).trim()
  }
  text = text.replace(/^(\*\*|__|\*|_)+/, '').replace(/(\*\*|__|\*|_)+$/, '').trim()
  text = text.replace(/[.!?\u3002\uff01\uff1f]+$/, '').trim()
  return text.slice(0, LIMITS.titleMaxLength)
}
