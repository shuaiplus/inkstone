import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_CONFIG_STORAGE_KEY, DEFAULT_AI_CONFIG } from './config'
import { CLIENT_HEADER } from '@shared/constants'
import {
  buildMessages,
  chatHeaders,
  resolveChatEndpoint,
  chunkNotice,
  classifyAiError,
  isSafariLikeBrowser,
  listModels,
  normalizeUsage,
  parseSseLine,
  readSseStream,
  streamMarkdown,
  type SseEvent,
} from './ollama'

const encoder = new TextEncoder()

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(chunks: string[]): Promise<SseEvent[]> {
  const events: SseEvent[] = []
  await readSseStream(streamOf(chunks), (event) => events.push(event))
  return events
}

function deltaFrame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

describe('parseSseLine', () => {
  it('ignores keep-alive comments, blank lines and non-data fields', () => {
    expect(parseSseLine('')).toBeNull()
    expect(parseSseLine(': keep-alive')).toBeNull()
    expect(parseSseLine('event: message')).toBeNull()
    expect(parseSseLine('id: 7')).toBeNull()
    expect(parseSseLine('evt: 123')).toBeNull()
    expect(parseSseLine('xdata: {"a":1}')).toBeNull()
    expect(parseSseLine('data:')).toBeNull()
    expect(parseSseLine('data:   ')).toBeNull()
  })

  it('recognizes the terminator', () => {
    expect(parseSseLine('data: [DONE]')).toEqual({ done: true })
  })

  it('tolerates a trailing carriage return', () => {
    expect(parseSseLine('data: {"a":1}\r')).toEqual({ payload: { a: 1 } })
  })

  it('drops payloads that are not valid JSON instead of throwing', () => {
    expect(parseSseLine('data: {half')).toBeNull()
  })
})

describe('readSseStream', () => {
  it('reassembles a data line split across two network chunks', async () => {
    const events = await collect(['data: {"choices":[{"del', 'ta":{"content":"hi"}}]}\n'])
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ choices: [{ delta: { content: 'hi' } }] })
  })

  it('handles a chunk boundary that lands exactly on the newline', async () => {
    const events = await collect(['data: {"a":1}', '\ndata: {"a":2}\n'])
    expect(events.map((event) => event.payload)).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('flushes a final line that has no trailing newline', async () => {
    const events = await collect(['data: {"a":1}'])
    expect(events).toHaveLength(1)
  })

  it('emits the terminator and skips comment lines', async () => {
    const events = await collect([': ping\n', 'data: {"a":1}\n', 'data: [DONE]\n'])
    expect(events).toEqual([{ payload: { a: 1 } }, { done: true }])
  })
})

describe('normalizeUsage', () => {
  it('reads the OpenAI-compatible field names', () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    })
  })

  it('reads the native Ollama field names', () => {
    expect(normalizeUsage({ prompt_eval_count: 7, eval_count: 3 })).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    })
  })

  it('returns null when there is nothing usable', () => {
    expect(normalizeUsage(null)).toBeNull()
    expect(normalizeUsage({})).toBeNull()
  })
})

describe('classifyAiError', () => {
  const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36'
  const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15'

  it('recognizes an abort', () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    expect(classifyAiError(error, chrome).kind).toBe('aborted')
  })

  it('reports an HTTP failure with its status', () => {
    const error = Object.assign(new Error('HTTP 404'), { httpStatus: 404, httpBody: 'model not found' })
    const classified = classifyAiError(error, chrome)
    expect(classified.kind).toBe('http')
    expect(classified.status).toBe(404)
    expect(classified.detail).toContain('model not found')
  })

  it('treats a failed fetch on a supported browser as unreachable', () => {
    expect(classifyAiError(new TypeError('Failed to fetch'), chrome).kind).toBe('unreachable')
  })

  it('blames the browser when a failed fetch happens on Safari', () => {
    expect(classifyAiError(new TypeError('Failed to fetch'), safari).kind).toBe('unsupported-browser')
  })

  it('falls back to unknown for anything else', () => {
    expect(classifyAiError('boom', chrome).kind).toBe('unknown')
  })
})

describe('isSafariLikeBrowser', () => {
  it('does not mistake Chrome or Firefox for Safari', () => {
    expect(isSafariLikeBrowser('AppleWebKit Chrome/140 Safari/537.36')).toBe(false)
    expect(isSafariLikeBrowser('Gecko Firefox/130')).toBe(false)
    expect(isSafariLikeBrowser('CriOS/140 Safari/605')).toBe(false)
  })

  it('recognizes desktop Safari', () => {
    expect(isSafariLikeBrowser('AppleWebKit/605.1.15 Version/17 Safari/605.1.15')).toBe(true)
  })
})

describe('buildMessages', () => {
  it('drops empty instruction slots instead of leaving blank lines', () => {
    const messages = buildMessages('SYSTEM', '', '', '', [], 'body')
    expect(messages[0].content).toBe('SYSTEM')
    expect(messages).toHaveLength(2)
    expect(messages[1]).toEqual({ role: 'user', content: 'body' })
  })

  it('keeps history between the system prompt and the new input', () => {
    const messages = buildMessages('SYSTEM', 'STRICT', 'EXTRA', 'CHUNK', [{ role: 'assistant', content: 'prev' }], 'body')
    expect(messages[0].content).toBe('SYSTEM\nSTRICT\nEXTRA\nCHUNK')
    expect(messages[1]).toEqual({ role: 'assistant', content: 'prev' })
    expect(messages[2]).toEqual({ role: 'user', content: 'body' })
  })
})

describe('chunkNotice', () => {
  it('tells the model which slice it is looking at', () => {
    expect(chunkNotice(2, 5)).toContain('part 2 of 5')
  })
})

describe('resolveChatEndpoint and chatHeaders', () => {
  const ollama = { ...DEFAULT_AI_CONFIG }
  const cloud = { ...DEFAULT_AI_CONFIG, provider: 'cloudflare' as const }

  it('points at the local Ollama endpoint by default', () => {
    expect(resolveChatEndpoint(ollama)).toBe('http://127.0.0.1:11434/v1/chat/completions')
  })

  it('points at the same-origin route when the cloud provider is chosen', () => {
    expect(resolveChatEndpoint(cloud)).toBe('/api/ai/chat')
  })

  it('sends the client header only to our own API, since Ollama does not allow it through CORS', () => {
    expect(chatHeaders(cloud)[CLIENT_HEADER]).toBe('1')
    expect(chatHeaders(ollama)[CLIENT_HEADER]).toBeUndefined()
    expect(chatHeaders(ollama)['Content-Type']).toBe('application/json')
  })
})

describe('streamMarkdown', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  function mockStreamingFetch(bodies: string[][]): ReturnType<typeof vi.fn> {
    let call = 0
    const fetchMock = vi.fn(async () => {
      const chunks = bodies[Math.min(call, bodies.length - 1)]
      call += 1
      return new Response(streamOf(chunks), { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
  }

  it('streams tokens and reports usage and finish reason', async () => {
    mockStreamingFetch([
      [
        deltaFrame('# Title'),
        deltaFrame('\nbody'),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\n`,
        'data: [DONE]\n',
      ],
    ])
    const tokens: string[] = []
    const result = await streamMarkdown({ input: 'raw text', onToken: (delta) => tokens.push(delta) })
    expect(result.markdown).toBe('# Title\nbody')
    expect(tokens).toEqual(['# Title', '\nbody'])
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toEqual({ promptTokens: 4, completionTokens: 2, totalTokens: 6 })
    expect(result.chunks).toBe(1)
    expect(result.loss).toBeNull()
  })

  it('does not let an early clean stop mask a later chunk being truncated', async () => {
    localStorage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify({ chunkChars: 10 }))
    let call = 0
    globalThis.fetch = vi.fn(async () => {
      const reason = call === 0 ? 'stop' : 'length'
      call += 1
      return new Response(
        streamOf([deltaFrame('out'), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`]),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const result = await streamMarkdown({ input: 'aaaaaaaaaa\n\nbbbbbbbbbb' })
    expect(result.chunks).toBe(2)
    expect(result.finishReason).toBe('length')
    expect(result.loss).toEqual({ kind: 'truncated' })
  })

  it('reports truncation when the model hit its output cap', async () => {
    mockStreamingFetch([
      [deltaFrame('partial'), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`],
    ])
    const result = await streamMarkdown({ input: 'raw text' })
    expect(result.loss).toEqual({ kind: 'truncated' })
  })

  it('splits long first-turn input and reports chunk progress', async () => {
    localStorage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify({ chunkChars: 10 }))
    const fetchMock = mockStreamingFetch([[deltaFrame('out'), 'data: [DONE]\n']])
    const progress: Array<[number, number]> = []
    const result = await streamMarkdown({
      input: 'aaaaaaaaaa\n\nbbbbbbbbbb\n\ncccccccccc',
      onChunk: (index, total) => progress.push([index, total]),
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ])
    expect(result.chunks).toBe(3)
    expect(result.markdown).toBe('out\n\nout\n\nout')
  })

  it('does not split a refine turn, whose input is an instruction', async () => {
    localStorage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify({ chunkChars: 10 }))
    const fetchMock = mockStreamingFetch([[deltaFrame('out'), 'data: [DONE]\n']])
    await streamMarkdown({
      input: 'aaaaaaaaaa\n\nbbbbbbbbbb\n\ncccccccccc',
      history: [{ role: 'assistant', content: 'previous' }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('posts to the configured endpoint with streaming enabled', async () => {
    const fetchMock = mockStreamingFetch([['data: [DONE]\n']])
    await streamMarkdown({ input: 'x' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body)) as { stream: boolean; model: string }
    expect(body.stream).toBe(true)
    expect(body.model).toBe('gemma4:12b-it-qat')
  })

  it('surfaces an HTTP failure with its status', async () => {
    globalThis.fetch = vi.fn(async () => new Response('no such model', { status: 404 })) as unknown as typeof fetch
    await expect(streamMarkdown({ input: 'x' })).rejects.toThrow('HTTP 404')
  })

  it('stops immediately when the caller aborts', async () => {
    const controller = new AbortController()
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
      return new Response(streamOf(['data: [DONE]\n']), { status: 200 })
    }) as unknown as typeof fetch
    controller.abort()
    await expect(streamMarkdown({ input: 'x', signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})

describe('listModels', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns sorted model ids and drops malformed entries', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ id: 'zeta' }, { id: '' }, {}, { id: 'alpha' }] }), { status: 200 }),
    ) as unknown as typeof fetch
    expect(await listModels('http://127.0.0.1:11434/v1/')).toEqual(['alpha', 'zeta'])
  })

  it('throws an HTTP failure on a non-ok response', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    await expect(listModels('http://127.0.0.1:11434/v1')).rejects.toThrow('HTTP 500')
  })
})
