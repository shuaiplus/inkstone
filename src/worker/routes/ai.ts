import { Hono } from 'hono'
import { isAllowedCloudflareModel, supportsThinkingToggle } from '@shared/ai-models'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { transformWorkersAiStream } from '../lib/workers-ai-stream'
import { requireAuth } from '../middleware/auth'

export const aiRoutes = new Hono<AppBindings>()

aiRoutes.use('*', requireAuth)

const MAX_OUTPUT_TOKENS = 16384

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatBody {
  model?: unknown
  messages?: unknown
  max_tokens?: unknown
}

function readMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw ApiError.badRequest('messages must be a non-empty array')
  }
  return value.map((entry) => {
    const message = entry as Record<string, unknown>
    const role = message?.role
    const content = message?.content
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw ApiError.badRequest('each message needs a role of system, user or assistant')
    }
    if (typeof content !== 'string') {
      throw ApiError.badRequest('each message needs string content')
    }
    return { role, content }
  })
}

function readMaxTokens(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw ApiError.badRequest('max_tokens must be a positive number')
  }
  return Math.min(Math.floor(value), MAX_OUTPUT_TOKENS)
}

function upstreamFailure(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : String(error)
  if (/\b429\b|rate limit|quota|capacity|exceeded/i.test(message)) {
    return new ApiError(429, 'too_many_attempts', message)
  }
  return new ApiError(502, 'internal', message)
}

aiRoutes.post('/chat', async (c) => {
  const ai = c.env.AI
  if (!ai) {
    throw new ApiError(503, 'server_misconfigured', 'Workers AI is not bound to this deployment')
  }

  const body = await readJson<ChatBody>(c, JSON_BODY_LIMITS.note)
  if (!isAllowedCloudflareModel(body.model)) {
    throw ApiError.badRequest('That model is not available on this server')
  }
  const messages = readMessages(body.messages)
  const maxTokens = readMaxTokens(body.max_tokens)

  let upstream: ReadableStream<Uint8Array>
  try {
    upstream = await ai.run<ReadableStream<Uint8Array>>(body.model, {
      messages,
      stream: true,
      reasoning_effort: 'low',
      ...(supportsThinkingToggle(body.model) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    })
  } catch (error) {
    throw upstreamFailure(error)
  }

  return new Response(transformWorkersAiStream(upstream, body.model), {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    },
  })
})
