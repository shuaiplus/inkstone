import { LIMITS } from '@shared/constants'
import { ApiError } from './errors'


export const JSON_BODY_LIMITS = {
  small: 8 * 1024,
  settings: 16 * 1024,
  backup: 32 * 1024,
  profile: 256 * 1024,
  note: LIMITS.contentMaxBytes * 6 + 64 * 1024,
} as const

export const FORM_BODY_LIMITS = {
  authorization: 16 * 1024,
  oauthToken: 16 * 1024,
  attachment: LIMITS.attachmentMaxBytes + 512 * 1024,
  import: LIMITS.importUploadMaxBytes + 1024 * 1024,
} as const


export async function readJson<T>(
  c: {
    req: {
      json: () => Promise<unknown>
      text: () => Promise<string>
      raw?: Request
      header?: (name: string) => string | undefined
    }
  },
  maxBytes?: number,
): Promise<T> {
  if (maxBytes) assertDeclaredBodySize(c.req, maxBytes)
  let value: unknown
  try {
    if (maxBytes) {
      const text = await readTextWithinLimit(c.req, maxBytes)
      value = JSON.parse(text) as unknown
    } else {
      value = await c.req.json()
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest('The request body is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('The request body must be a JSON object')
  }
  return value as T
}


export async function readFormDataWithinLimit(
  req: {
    raw?: Request
    header?: (name: string) => string | undefined
  },
  maxBytes: number,
): Promise<FormData> {
  assertDeclaredBodySize(req, maxBytes)
  const contentType = req.header?.('Content-Type') ?? req.raw?.headers.get('Content-Type') ?? ''
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    throw ApiError.badRequest('The request body must use multipart/form-data')
  }

  const bytes = await readBytesWithinLimit(req.raw?.body, maxBytes)
  try {
    return await new Request('https://inkstone.invalid/upload', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: bytes as BodyInit,
    }).formData()
  } catch {
    throw ApiError.badRequest('The upload form is invalid')
  }
}

export async function readUrlEncodedFormWithinLimit(
  req: {
    raw?: Request
    header?: (name: string) => string | undefined
  },
  maxBytes: number,
): Promise<URLSearchParams> {
  assertDeclaredBodySize(req, maxBytes)
  const contentType = req.header?.('Content-Type') ?? req.raw?.headers.get('Content-Type') ?? ''
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) {
    throw ApiError.badRequest('The request body must use application/x-www-form-urlencoded')
  }
  const bytes = await readBytesWithinLimit(req.raw?.body, maxBytes)
  return new URLSearchParams(new TextDecoder().decode(bytes))
}


export function readOptionalJson<T extends object>(
  c: Parameters<typeof readJson<T>>[0],
  maxBytes: number,
  fallback: T,
): Promise<T> {
  const declared = c.req.header?.('Content-Length')
  if (c.req.raw?.body == null || declared === '0') return Promise.resolve(fallback)
  return readJson<T>(c, maxBytes)
}


export function assertDeclaredBodySize(
  req: { header?: (name: string) => string | undefined },
  maxBytes: number,
): void {
  if (!req.header) return
  const raw = req.header('Content-Length')
  if (raw === undefined) return
  const declared = Number(raw)
  if (Number.isFinite(declared) && declared >= 0 && declared > maxBytes) {
    throw ApiError.tooLarge('The request body is too large')
  }
}

async function readTextWithinLimit(
  req: { raw?: Request; text: () => Promise<string> },
  maxBytes: number,
): Promise<string> {
  const stream = req.raw?.body
  if (!stream) {
    const text = await req.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw ApiError.tooLarge('The request body is too large')
    return text
  }

  return new TextDecoder().decode(await readBytesWithinLimit(stream, maxBytes))
}

async function readBytesWithinLimit(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array()

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel('payload_too_large')
        throw ApiError.tooLarge('The request body is too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}


export function requestClientIp(c: {
  req: { header: (name: string) => string | undefined; raw?: Request }
}): string {
  const value = c.req.header('CF-Connecting-IP')?.trim().toLowerCase()
  if (!value) return 'local'
  // CF-Connecting-IP is injected by the Cloudflare edge and cannot be
  // spoofed there. On any other runtime the header is client-controlled,
  // so ignore it rather than trusting it for throttling.
  if (!c.req.raw || !(c.req.raw as Request & { cf?: unknown }).cf) return 'local'
  return value.replace(/[^a-f0-9:.%-]/g, '').slice(0, 64) || 'unknown'
}

export function clampInt(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}


export function assertContentSize(content: string): void {
  if (new TextEncoder().encode(content).byteLength > LIMITS.contentMaxBytes) {
    throw ApiError.tooLarge(`Note content exceeds the ${LIMITS.contentMaxBytes / 1_000_000} MB limit`)
  }
}
