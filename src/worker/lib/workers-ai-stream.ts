export function extractDelta(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>

  const choices = record.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown> | null
    const delta = first?.delta as Record<string, unknown> | undefined
    if (delta && typeof delta.content === 'string' && delta.content) return delta.content
  }

  if (typeof record.response === 'string' && record.response) return record.response

  return null
}

export function parseUpstreamLine(rawLine: string): { done: boolean; delta: string | null } | null {
  if (!rawLine.startsWith('data:')) return null
  const data = rawLine.slice(5).trim()
  if (!data) return null
  if (data === '[DONE]') return { done: true, delta: null }
  try {
    return { done: false, delta: extractDelta(JSON.parse(data)) }
  } catch {
    return null
  }
}

export function openAiChunk(delta: string, model: string): string {
  const payload = {
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

export function openAiFinalChunk(model: string): string {
  const payload = {
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }
  return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`
}

export function transformWorkersAiStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, rawLine: string) => {
    const parsed = parseUpstreamLine(rawLine)
    if (!parsed || parsed.done || parsed.delta === null) return
    controller.enqueue(encoder.encode(openAiChunk(parsed.delta, model)))
  }

  const transformer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        emit(controller, buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    },
    flush(controller) {
      if (buffer) emit(controller, buffer)
      controller.enqueue(encoder.encode(openAiFinalChunk(model)))
    },
  })

  return upstream.pipeThrough(transformer)
}
