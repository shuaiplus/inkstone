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
export const DEFAULT_IMAGE_MODEL = 'dall-e-3'

export interface ResolvedAiConfig {
  apiKey: string
  baseUrl: string
  model: string
  imageModel: string
  imageMethod: 'generations' | 'responses'
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
  const imageModel = config.imageModel.trim() || DEFAULT_IMAGE_MODEL
  return { apiKey, baseUrl, model, imageModel, imageMethod: config.imageMethod }
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

export interface GeneratedImage {
  url: string
  revisedPrompt?: string
}

export async function generateImage(
  config: ResolvedAiConfig,
  prompt: string,
  options: { size?: '1024x1024' | '1792x1024' | '1024x1792'; signal?: AbortSignal } = {},
): Promise<GeneratedImage> {
  const { apiKey, baseUrl, imageModel } = config
  const body: Record<string, unknown> = {
    model: imageModel,
    prompt,
    n: 1,
    size: options.size ?? '1024x1024',
  }
  let response: Response
  try {
    response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    throw new ApiError(502, 'server_misconfigured', `Failed to reach the image endpoint: ${(err as Error).message}`)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    // Try to parse OpenAI-style error response {"error":{"message":"..."}}
    let detail = text.slice(0, 500)
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; type?: string } }
      if (parsed.error?.message) detail = parsed.error.message
    } catch { /* not JSON, keep raw text */ }
    throw new ApiError(
      502,
      'server_misconfigured',
      `Image generation failed (HTTP ${response.status}): ${detail}`,
    )
  }
  const data: unknown = await response.json().catch(() => null)
  const item = (
    data as {
      data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>
    }
  )?.data?.[0]
  if (!item) throw new ApiError(502, 'invalid_response', 'The image endpoint returned no data')
  // Support both url and b64_json response formats
  if (item.url) {
    return { url: item.url, revisedPrompt: item.revised_prompt }
  }
  if (item.b64_json) {
    return { url: `data:image/png;base64,${item.b64_json}`, revisedPrompt: item.revised_prompt }
  }
  throw new ApiError(502, 'invalid_response', 'The image endpoint returned no image URL or b64_json')
}

/**
 * Generate an image via the Responses API with the built-in image_generation tool.
 * Used by proxies (e.g. sub2api) that only expose image generation through /responses.
 *
 * We intentionally do NOT send `tools`/`tool_choice` in the request body: proxies like
 * sub2api auto-inject the image_generation tool on their side, and sending it from the
 * client triggers a different permission path ("client provided tool") that is often
 * disabled for the account group. Sending a plain text input lets the proxy inject the
 * tool and route the request through the enabled path.
 */
export async function generateImageViaResponses(
  config: ResolvedAiConfig,
  prompt: string,
  options: { size?: '1024x1024' | '1792x1024' | '1024x1792'; signal?: AbortSignal } = {},
): Promise<GeneratedImage> {
  const { apiKey, baseUrl, model } = config
  const sizeHint = options.size ? ` (target size: ${options.size})` : ''
  const body: Record<string, unknown> = {
    model,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: `Generate an image: ${prompt}${sizeHint}` },
        ],
      },
    ],
    // Force the model to call the image_generation tool (auto-injected by the proxy).
    // We don't send `tools` to avoid triggering the "client provided tool" permission path.
    tool_choice: { type: 'image_generation' },
  }
  let response: Response
  try {
    response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    throw new ApiError(502, 'server_misconfigured', `Failed to reach the responses endpoint: ${(err as Error).message}`)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    console.error('[inkstone] AI image responses request failed:', {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: text.slice(0, 1000),
    })
    let detail = text.slice(0, 500)
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; detail?: string; message?: string }
      if (parsed.error?.message) detail = parsed.error.message
      else if (parsed.detail) detail = parsed.detail
      else if (parsed.message) detail = parsed.message
    } catch { /* not JSON, keep raw text */ }
    throw new ApiError(
      502,
      'server_misconfigured',
      `Image generation failed (HTTP ${response.status}): ${detail}`,
    )
  }
  const contentType = response.headers.get('content-type') ?? ''

  // Stream the SSE response and capture image_generation_call output items
  if (contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson')) {
    const reader = response.body?.getReader()
    if (!reader) {
      throw new ApiError(502, 'server_misconfigured', 'The responses endpoint returned no readable body')
    }
    const decoder = new TextDecoder()
    let buffer = ''
    let imageResult: GeneratedImage | null = null
    let lastError: string | null = null
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const raw of lines) {
          const line = raw.trim()
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const evt = JSON.parse(payload) as {
              type?: string
              response?: {
                output?: Array<{
                  type?: string
                  result?: string
                  revised_prompt?: string
                }>
                status?: string
                error?: { message?: string } | null
              }
              item?: {
                type?: string
                result?: string
                revised_prompt?: string
              }
            }
            // Log every event type for debugging
            if (evt.type) {
              const outputSummary = evt.response?.output?.map((o) => `${o.type}:${o.result ? 'has_result' : 'no_result'}`).join(',')
              console.error(`[inkstone] SSE event: ${evt.type}${outputSummary ? ` output=[${outputSummary}]` : ''}${evt.item ? ` item.type=${evt.item.type}` : ''}`)
            }
            // Completed response carries the full output array
            if (evt.type?.endsWith('.completed') && Array.isArray(evt.response?.output)) {
              const call = evt.response!.output!.find(
                (o) => o.type === 'image_generation_call' && o.result,
              )
              if (call) {
                imageResult = {
                  url: `data:image/png;base64,${call.result}`,
                  revisedPrompt: call.revised_prompt,
                }
              }
              if (evt.response?.error) {
                lastError = evt.response.error.message ?? 'Unknown error'
              }
            }
            // Some proxies stream output items individually
            if (evt.item?.type === 'image_generation_call' && evt.item.result) {
              imageResult = {
                url: `data:image/png;base64,${evt.item.result}`,
                revisedPrompt: evt.item.revised_prompt,
              }
            }
            if (evt.type === 'error' || evt.type === 'response.failed') {
              lastError = (evt.response?.error as { message?: string })?.message ?? 'Response failed'
            }
          } catch { /* ignore parse errors for individual events */ }
        }
      }
    } finally {
      reader.releaseLock()
    }
    if (imageResult) return imageResult
    throw new ApiError(
      502,
      'server_misconfigured',
      lastError
        ? `The responses endpoint failed: ${lastError}`
        : 'The responses endpoint completed without producing an image_generation_call',
    )
  }

  // Non-streaming JSON response
  const responseText = await response.text().catch(() => '')
  let data: unknown = null
  try {
    data = responseText ? JSON.parse(responseText) : null
  } catch { /* not JSON */ }
  const output = (
    data as {
      output?: Array<{
        type?: string
        result?: string
        revised_prompt?: string
      }>
    }
  )?.output
  if (!Array.isArray(output)) {
    throw new ApiError(
      502,
      'server_misconfigured',
      `The responses endpoint returned no output array. Content-Type: ${contentType}. Body: ${responseText.slice(0, 500)}`,
    )
  }
  const imageCall = output.find((item) => item.type === 'image_generation_call' && item.result)
  if (imageCall) {
    return {
      url: `data:image/png;base64,${imageCall.result}`,
      revisedPrompt: imageCall.revised_prompt,
    }
  }
  const types = output.map((item) => item.type).filter(Boolean).join(', ')
  throw new ApiError(
    502,
    'server_misconfigured',
    `The responses endpoint did not produce an image_generation_call. Output types: [${types}]. Raw: ${JSON.stringify(output).slice(0, 500)}`,
  )
}