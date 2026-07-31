import { ApiError } from './errors'
import { decryptAiKey } from './crypto'
import { getAiConfig, getAiKeyCipher } from './instance-settings'
import type { Env } from '../env'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
}

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini'

export interface ResolvedAiConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export async function resolveAiConfig(env: Env): Promise<ResolvedAiConfig> {
  const db = env.DB
  const config = await getAiConfig(db)
  const keyCipher = await getAiKeyCipher(db)
  if (!keyCipher) {
    throw new ApiError(503, 'server_misconfigured', 'AI is not configured. Set the OpenAI API key in Settings.')
  }
  const apiKey = await decryptAiKey(env, keyCipher)
  if (!apiKey) {
    throw new ApiError(503, 'server_misconfigured', 'The stored AI key could not be decrypted. Re-enter it in Settings.')
  }
  const baseUrl = (config.baseUrl.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '')
  const model = config.model.trim() || DEFAULT_OPENAI_MODEL
  return { apiKey, baseUrl, model }
}

export async function* streamChatCompletion(
  config: ResolvedAiConfig,
  messages: ChatMessage[],
  options: ChatOptions = {},
): AsyncGenerator<string> {
  const { apiKey, baseUrl, model } = config
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens

  let response: Response
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    throw new ApiError(502, 'server_misconfigured', `Failed to reach the OpenAI endpoint: ${(err as Error).message}`)
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    throw new ApiError(
      502,
      'server_misconfigured',
      `OpenAI request failed (HTTP ${response.status}): ${text.slice(0, 500)}`,
    )
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream') && !contentType.includes('application/json')) {
    const peek = await reader.read()
    const preview = peek.done ? '' : decoder.decode(peek.value).slice(0, 200)
    reader.releaseLock()
    throw new ApiError(
      502,
      'server_misconfigured',
      `The AI endpoint returned ${contentType || 'an unknown content type'} instead of an event stream. Check the Base URL (it usually must end with /v1). Preview: ${preview}`,
    )
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line || !line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return
        try {
          const json = JSON.parse(data) as {
            choices?: { delta?: { content?: string }; message?: { content?: string } }[]
          }
          const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content
          if (delta) yield delta
        } catch {
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function sseFromChunks(chunks: AsyncGenerator<string>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : (err as Error)?.name === 'AbortError'
              ? 'Request cancelled'
              : 'AI request failed'
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(message)}\n\n`))
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}