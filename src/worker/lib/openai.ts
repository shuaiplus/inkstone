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

export interface AiConfigOverrides {
  apiKey?: string
  baseUrl?: string
  model?: string
}

export async function resolveAiConfig(
  env: Env,
  overrides: AiConfigOverrides = {},
): Promise<ResolvedAiConfig> {
  const db = env.DB
  const config = await getAiConfig(db)
  let apiKey = overrides.apiKey?.trim() ?? ''
  if (!apiKey) {
    const keyCipher = await getAiKeyCipher(db)
    if (!keyCipher) {
      throw new ApiError(503, 'server_misconfigured', 'AI is not configured. Set the OpenAI API key in Settings.')
    }
    const decrypted = await decryptAiKey(env, keyCipher)
    if (!decrypted) {
      throw new ApiError(503, 'server_misconfigured', 'The stored AI key could not be decrypted. Re-enter it in Settings.')
    }
    apiKey = decrypted
  }
  const baseUrl = ((overrides.baseUrl ?? config.baseUrl).trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '')
  const model = (overrides.model ?? config.model).trim() || DEFAULT_OPENAI_MODEL
  const imageModel = config.imageModel.trim() || DEFAULT_IMAGE_MODEL
  return { apiKey, baseUrl, model, imageModel, imageMethod: config.imageMethod }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    const value = part as { text?: unknown; content?: unknown }
    if (typeof value.text === 'string') return value.text
    if (value.text && typeof value.text === 'object') {
      const nested = value.text as { value?: unknown }
      if (typeof nested.value === 'string') return nested.value
    }
    return typeof value.content === 'string' ? value.content : ''
  }).join('')
}

function chatPayloadText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const data = payload as {
    error?: { message?: unknown }
    choices?: Array<{
      delta?: { content?: unknown }
      message?: { content?: unknown }
      text?: unknown
    }>
  }
  if (data.error?.message) {
    throw new ApiError(502, 'server_misconfigured', String(data.error.message))
  }
  const choice = data.choices?.[0]
  return contentText(choice?.delta?.content)
    || contentText(choice?.message?.content)
    || contentText(choice?.text)
}

function parseChatDataLine(raw: string): { done: boolean; text: string } | null {
  const line = raw.trim()
  if (!line || line.startsWith(':') || !line.startsWith('data:')) return null
  const data = line.slice(5).trim()
  if (data === '[DONE]') return { done: true, text: '' }
  try {
    return { done: false, text: chatPayloadText(JSON.parse(data)) }
  } catch (err) {
    if (err instanceof ApiError) throw err
    return null
  }
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

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let detail = text.slice(0, 500)
    try {
      const data = JSON.parse(text) as { error?: { message?: unknown } }
      if (data.error?.message) detail = String(data.error.message)
    } catch {
    }
    throw new ApiError(
      502,
      'server_misconfigured',
      `OpenAI request failed (HTTP ${response.status}): ${detail}`,
    )
  }
  if (!response.body) {
    throw new ApiError(502, 'invalid_response', 'The AI endpoint returned an empty response body')
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (contentType.includes('application/json')) {
    const raw = await response.text()
    try {
      const text = chatPayloadText(JSON.parse(raw))
      if (text) yield text
      return
    } catch (err) {
      if (err instanceof ApiError) throw err
      for (const line of raw.split(/\r?\n/)) {
        const parsed = parseChatDataLine(line)
        if (parsed?.done) return
        if (parsed?.text) yield parsed.text
      }
      return
    }
  }

  const supportedStream = !contentType
    || contentType.includes('text/event-stream')
    || contentType.includes('text/plain')
    || contentType.includes('application/x-ndjson')
    || contentType.includes('application/octet-stream')
  if (!supportedStream) {
    throw new ApiError(
      502,
      'server_misconfigured',
      `The AI endpoint returned ${contentType} instead of an OpenAI-compatible stream. Check the Base URL (it usually must end with /v1).`,
    )
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const parsed = parseChatDataLine(raw)
        if (parsed?.done) return
        if (parsed?.text) yield parsed.text
      }
    }
    buffer += decoder.decode()
    for (const raw of buffer.split(/\r?\n/)) {
      const parsed = parseChatDataLine(raw)
      if (parsed?.done) return
      if (parsed?.text) yield parsed.text
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
 * Strategy:
 * - We do NOT send `tools` from the client. Proxies like sub2api auto-inject the
 *   image_generation tool on their side for Codex-style /responses requests (signaled
 *   by the `x-openai-actor-authorization: local-image-extension` header). Sending
 *   `tools` from the client triggers a different permission path ("client provided
 *   tool") that is often disabled for the account group.
 * - We DO send `tool_choice: { type: "image_generation" }` to force the model to
 *   actually call the auto-injected tool. Without this, the model may simply respond
 *   with text describing how it would generate the image, resulting in a completed
 *   response with no `image_generation_call` output item.
 *
 * If `tool_choice` is rejected by the proxy (e.g. older versions that don't recognize
 * it without a matching `tools` entry), we fall back to a plain request and rely on
 * the proxy's auto-injection plus the prompt to trigger the tool call.
 */
export async function generateImageViaResponses(
  config: ResolvedAiConfig,
  prompt: string,
  options: { size?: '1024x1024' | '1792x1024' | '1024x1792'; signal?: AbortSignal } = {},
): Promise<GeneratedImage> {
  const { model } = config
  const sizeHint = options.size ? ` (target size: ${options.size})` : ''
  const inputText = `Generate an image: ${prompt}${sizeHint}`
  const buildBody = (withToolChoice: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: inputText }],
        },
      ],
    }
    if (withToolChoice) {
      body.tool_choice = { type: 'image_generation' }
    }
    return body
  }

  // First attempt: force the model to call image_generation via tool_choice.
  // This works with sub2api's auto-injected tool and standard OpenAI Responses API.
  let response = await sendResponsesRequest(config, buildBody(true), options.signal)
  // If the proxy rejects tool_choice (e.g. 400 "tool_choice requires tools" or
  // 403 "Image generation is not enabled"), retry without it as a fallback.
  if (shouldRetryWithoutToolChoice(response)) {
    response = await sendResponsesRequest(config, buildBody(false), options.signal)
  }
  return parseResponsesResult(response)
}

function shouldRetryWithoutToolChoice(response: Response): boolean {
  if (response.status === 200) return false
  // 4xx errors that suggest tool_choice wasn't accepted
  return response.status >= 400 && response.status < 500
}

async function sendResponsesRequest(
  config: ResolvedAiConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const { apiKey, baseUrl } = config
  try {
    return await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'x-openai-actor-authorization': 'local-image-extension',
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    throw new ApiError(
      502,
      'server_misconfigured',
      `Failed to reach the responses endpoint: ${(err as Error).message}`,
    )
  }
}

async function parseResponsesResult(response: Response): Promise<GeneratedImage> {
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
