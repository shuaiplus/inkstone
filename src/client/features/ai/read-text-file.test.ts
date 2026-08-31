import { describe, expect, it } from 'vitest'
import { MAX_TEXT_FILE_BYTES, looksLikeText, readTextFile } from './read-text-file'

function fileOf(name: string, type: string, contents = 'hello'): File {
  return new File([contents], name, { type })
}

function oversizedFile(name: string, type: string): File {
  const file = fileOf(name, type)
  Object.defineProperty(file, 'size', { value: MAX_TEXT_FILE_BYTES + 1 })
  return file
}

describe('looksLikeText', () => {
  it('accepts anything the platform already labels as text', () => {
    expect(looksLikeText('notes.weird', 'text/plain')).toBe(true)
  })

  it('accepts known text extensions even when the platform reports no MIME type', () => {
    expect(looksLikeText('README.md', '')).toBe(true)
    expect(looksLikeText('rows.CSV', '')).toBe(true)
    expect(looksLikeText('config.yaml', '')).toBe(true)
  })

  it('rejects binary types', () => {
    expect(looksLikeText('photo.png', 'image/png')).toBe(false)
    expect(looksLikeText('report.pdf', 'application/pdf')).toBe(false)
    expect(looksLikeText('archive.zip', '')).toBe(false)
  })
})

describe('readTextFile', () => {
  it('reads a plain text file', async () => {
    const result = await readTextFile(fileOf('note.txt', 'text/plain', 'body text'))
    expect(result).toEqual({ ok: true, text: 'body text', name: 'note.txt' })
  })

  it('reads a Markdown file the platform gave no MIME type for', async () => {
    const result = await readTextFile(fileOf('README.md', '', '# Title'))
    expect(result.ok).toBe(true)
  })

  it('rejects a binary file instead of silently ignoring it', async () => {
    expect(await readTextFile(fileOf('photo.png', 'image/png'))).toEqual({ ok: false, reason: 'not-text' })
  })

  it('rejects an oversized file rather than truncating it', async () => {
    expect(await readTextFile(oversizedFile('huge.txt', 'text/plain'))).toEqual({ ok: false, reason: 'too-large' })
  })

  it('checks the type before the size, so a huge image is reported as not-text', async () => {
    expect(await readTextFile(oversizedFile('huge.png', 'image/png'))).toEqual({ ok: false, reason: 'not-text' })
  })

  it('reports a read failure instead of throwing', async () => {
    const broken = fileOf('note.txt', 'text/plain')
    Object.defineProperty(broken, 'text', {
      value: () => Promise.reject(new Error('disk gone')),
    })
    expect(await readTextFile(broken)).toEqual({ ok: false, reason: 'read-failed' })
  })
})
