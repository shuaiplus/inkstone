import { describe, expect, it } from 'vitest'
import { extractDelta, openAiChunk, parseUpstreamLine, transformWorkersAiStream } from './workers-ai-stream'

const MODEL = '@cf/qwen/qwen3-30b-a3b-fp8'
const encoder = new TextEncoder()

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(chunks: string[]): Promise<string> {
  const reader = transformWorkersAiStream(streamOf(chunks), MODEL).getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out
}

function contentsOf(sse: string): unknown[] {
  return sse
    .split('\n')
    .filter((line) => line.startsWith('data:') && !line.includes('[DONE]'))
    .map((line) => JSON.parse(line.slice(5).trim()) as { choices: Array<{ delta: { content?: unknown } }> })
    .map((payload) => payload.choices[0].delta.content)
    .filter((content) => content !== undefined)
}

describe('extractDelta', () => {
  it('reads the native Workers AI shape', () => {
    expect(extractDelta({ response: 'hello' })).toBe('hello')
  })

  it('reads the OpenAI chunk shape', () => {
    expect(extractDelta({ choices: [{ delta: { content: 'hello' } }] })).toBe('hello')
  })

  it('takes the first non-empty field, since the two shapes coexist on real chunks', () => {
    expect(extractDelta({ response: 'a', choices: [{ delta: { content: 'b' } }] })).toBe('b')
    expect(extractDelta({ response: 'a', choices: [{ delta: { content: '' } }] })).toBe('a')
    expect(extractDelta({ response: '', choices: [{ delta: { content: 'b' } }] })).toBe('b')
  })

  it('returns null for shapes it cannot read, instead of throwing', () => {
    expect(extractDelta(null)).toBeNull()
    expect(extractDelta('text')).toBeNull()
    expect(extractDelta({})).toBeNull()
    expect(extractDelta({ choices: [] })).toBeNull()
    expect(extractDelta({ choices: [{ delta: {} }] })).toBeNull()
    expect(extractDelta({ choices: [{}] })).toBeNull()
    expect(extractDelta({ response: 42 })).toBeNull()
  })

  it('treats an empty delta as nothing to emit', () => {
    expect(extractDelta({ response: '' })).toBeNull()
    expect(extractDelta({ choices: [{ delta: { content: '' } }] })).toBeNull()
  })

  it('ignores reasoning tokens, which real models emit far more of than content', () => {
    expect(extractDelta({ choices: [{ delta: { reasoning: 'thinking...', reasoning_content: 'thinking...' } }] })).toBeNull()
    expect(extractDelta({ choices: [{ delta: { content: 'real', reasoning: 'thinking...' } }] })).toBe('real')
  })
})

describe('parseUpstreamLine', () => {
  it('ignores lines that are not data fields', () => {
    expect(parseUpstreamLine('event: message')).toBeNull()
    expect(parseUpstreamLine('')).toBeNull()
    expect(parseUpstreamLine('data:')).toBeNull()
    expect(parseUpstreamLine('evt: {"response":"leak"}')).toBeNull()
    expect(parseUpstreamLine('xdata: {"response":"leak"}')).toBeNull()
  })

  it('recognizes the upstream terminator', () => {
    expect(parseUpstreamLine('data: [DONE]')).toEqual({ done: true, delta: null })
  })

  it('returns null on unparsable JSON rather than throwing', () => {
    expect(parseUpstreamLine('data: {half')).toBeNull()
  })
})

describe('transformWorkersAiStream', () => {
  it('translates the native shape into OpenAI deltas', async () => {
    const sse = await collect([
      'data: {"response":"# Title"}\n\n',
      'data: {"response":"\\nbody"}\n\n',
      'data: [DONE]\n\n',
    ])
    expect(contentsOf(sse)).toEqual(['# Title', '\nbody'])
  })

  it('passes through content that already arrives in the OpenAI shape', async () => {
    const sse = await collect(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'])
    expect(contentsOf(sse)).toEqual(['hi'])
  })

  it('reassembles a data line split across two upstream chunks', async () => {
    const sse = await collect(['data: {"resp', 'onse":"split"}\n\n'])
    expect(contentsOf(sse)).toEqual(['split'])
  })

  it('flushes a final line that has no trailing newline', async () => {
    const sse = await collect(['data: {"response":"tail"}'])
    expect(contentsOf(sse)).toEqual(['tail'])
  })

  it('always terminates with a stop chunk and [DONE]', async () => {
    const sse = await collect(['data: {"response":"x"}\n\n'])
    expect(sse.trimEnd().endsWith('data: [DONE]')).toBe(true)
    expect(sse).toContain('"finish_reason":"stop"')
  })

  it('skips chunks it cannot read instead of aborting the stream', async () => {
    const sse = await collect([
      'data: {"response":"before"}\n\n',
      'data: {"unexpected":"shape"}\n\n',
      'data: not-json\n\n',
      'data: {"response":"after"}\n\n',
    ])
    expect(contentsOf(sse)).toEqual(['before', 'after'])
  })

  it('does not emit a chunk for an empty delta', async () => {
    const sse = await collect(['data: {"response":""}\n\n', 'data: {"response":"real"}\n\n'])
    expect(contentsOf(sse)).toEqual(['real'])
  })

  it('labels every content chunk with the model that was asked for', async () => {
    const sse = await collect(['data: {"response":"x"}\n\n', 'data: {"response":"y"}\n\n'])
    const payloads = sse
      .split('\n')
      .filter((line) => line.startsWith('data:') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice(5).trim()) as { model?: string })
    expect(payloads.length).toBeGreaterThan(1)
    for (const payload of payloads) expect(payload.model).toBe(MODEL)
  })
})

describe('openAiChunk', () => {
  it('emits a single SSE event terminated by a blank line', () => {
    const chunk = openAiChunk('hi', MODEL)
    expect(chunk.startsWith('data: ')).toBe(true)
    expect(chunk.endsWith('\n\n')).toBe(true)
  })

  it('escapes content so newlines cannot break the SSE framing', () => {
    const chunk = openAiChunk('line1\nline2', MODEL)
    expect(chunk.split('\n\n')).toHaveLength(2)
    const payload = JSON.parse(chunk.slice(5).trim()) as { choices: Array<{ delta: { content: string } }> }
    expect(payload.choices[0].delta.content).toBe('line1\nline2')
  })
})
