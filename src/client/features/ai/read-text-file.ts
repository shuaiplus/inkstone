export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024

const TEXT_EXTENSIONS = ['.md', '.markdown', '.txt', '.csv', '.tsv', '.log', '.json', '.yaml', '.yml']

export interface ReadTextSuccess {
  ok: true
  text: string
  name: string
}

export interface ReadTextRejected {
  ok: false
  reason: 'not-text' | 'too-large' | 'read-failed'
}

export type ReadTextResult = ReadTextSuccess | ReadTextRejected

export function looksLikeText(name: string, type: string): boolean {
  if (type.startsWith('text/')) return true
  const lowered = name.toLowerCase()
  return TEXT_EXTENSIONS.some((extension) => lowered.endsWith(extension))
}

export async function readTextFile(file: File): Promise<ReadTextResult> {
  if (!looksLikeText(file.name, file.type)) return { ok: false, reason: 'not-text' }
  if (file.size > MAX_TEXT_FILE_BYTES) return { ok: false, reason: 'too-large' }
  try {
    return { ok: true, text: await file.text(), name: file.name }
  } catch {
    return { ok: false, reason: 'read-failed' }
  }
}
