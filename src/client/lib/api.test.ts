import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('API request deadlines', () => {
  it('turns a hung note save into a retryable offline error', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_path: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })))

    const request = api.notes.patch('timeout-note', { rev: 1, content: '# Still local' })
    const rejected = expect(request).rejects.toMatchObject({
      status: 0,
      code: 'request_timeout',
    } satisfies Partial<ApiError>)

    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
  })
})

describe('API response decoding', () => {
  it('preserves a valid JSON null response instead of reading the body twice', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('null', {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }))))

    await expect(api.session()).resolves.toBeNull()
  })

  it('reports malformed successful JSON as a server response error, not an offline error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{', {
      headers: { 'Content-Type': 'Application/JSON' },
    }))))

    await expect(api.session()).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response',
      isOffline: false,
    } satisfies Partial<ApiError>)
  })
})

describe('AI stream decoding', () => {
  it('decodes fragmented SSE chunks including a final event without a newline', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: "smooth'))
        controller.enqueue(encoder.encode('"\n\ndata: " output"'))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(body, {
      headers: { 'Content-Type': 'text/event-stream' },
    }))))
    const chunks: string[] = []

    await api.ai.stream('draft', { topic: 'test' }, (chunk) => chunks.push(chunk))

    expect(chunks).toEqual(['smooth', ' output'])
  })

  it('surfaces an SSE error event even when it is the final event', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      'event: error\ndata: "proxy unavailable"',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ))))

    await expect(api.ai.stream('draft', { topic: 'test' }, vi.fn())).rejects.toMatchObject({
      code: 'server_misconfigured',
      message: 'proxy unavailable',
    } satisfies Partial<ApiError>)
  })
})
