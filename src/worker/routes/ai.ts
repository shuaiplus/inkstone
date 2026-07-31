import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { encryptAiKey } from '../lib/crypto'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { sseFromChunks, streamChatCompletion, resolveAiConfig, generateImage, generateImageViaResponses, type ChatMessage } from '../lib/openai'
import {
  clearAiKeyCipher,
  getAiConfig,
  setAiConfig,
  setAiKeyCipher,
} from '../lib/instance-settings'

export const aiRoutes = new Hono<AppBindings>()

aiRoutes.use('*', requireAuth)

const AI_BODY_LIMIT = Math.min(LIMITS.contentMaxBytes * 2, 4 * 1024 * 1024)

interface AiBaseBody {
  locale?: 'zh-CN' | 'en-US'
}

interface AiContentBody extends AiBaseBody {
  content: string
  selection?: string
}

interface AiDraftBody extends AiBaseBody {
  topic: string
}

interface AiContinueBody extends AiBaseBody {
  content: string
}

interface AiEditBody extends AiBaseBody {
  instruction: string
  content: string
  selection?: string
}

interface AiImageBody extends AiBaseBody {
  prompt: string
  size?: '1024x1024' | '1792x1024' | '1024x1792'
}

interface AiConfigPatchBody {
  baseUrl?: string
  model?: string
  imageModel?: string
  imageMethod?: 'generations' | 'responses'
  apiKey?: string | null
}

function languageName(locale: string | undefined): string {
  return locale === 'en-US' ? 'English' : 'Simplified Chinese'
}

function buildSystem(task: 'summarize' | 'polish' | 'draft' | 'edit' | 'continue', locale: string | undefined): string {
  const lang = languageName(locale)
  if (task === 'summarize') {
    return `You are a meticulous editorial assistant. Summarize the user-supplied Markdown content as a concise bullet list of key points. Extract the core ideas and key information without inventing content. Output only the summary, in ${lang}.`
  }
  if (task === 'polish') {
    return `You are a writing polish assistant. Refine the Markdown text while preserving its meaning and structure: improve phrasing, fix grammar and punctuation, and make it read more naturally. Output only the polished Markdown, in ${lang}.`
  }
  if (task === 'edit') {
    return `You are a Markdown editing assistant. Apply the user's instructions to edit the supplied Markdown text. Preserve the meaning unless asked otherwise. Output only the edited Markdown, in ${lang}.`
  }
  if (task === 'continue') {
    return `You are a Markdown writing assistant. Continue writing the user-supplied Markdown document naturally, picking up from where it ends. Preserve the existing tone, style and structure. Do not repeat existing content. Output only the continuation, in ${lang}.`
  }
  return `You are a Markdown writing assistant. Based on the user's topic or instructions, write a well-structured Markdown document using appropriate headings and lists. Output only the document, in ${lang}.`
}

function validateContent(content: unknown): string {
  if (typeof content !== 'string' || content.trim() === '') {
    throw ApiError.badRequest('Content must not be empty')
  }
  if (new TextEncoder().encode(content).byteLength > AI_BODY_LIMIT) {
    throw ApiError.tooLarge('Content is too large for AI processing')
  }
  return content
}

function validateTopic(topic: unknown): string {
  if (typeof topic !== 'string' || topic.trim() === '') {
    throw ApiError.badRequest('Topic must not be empty')
  }
  if (topic.length > 2000) {
    throw ApiError.badRequest('Topic is too long')
  }
  return topic
}

function requireOwner(c: { get: (key: 'user') => { role: 'owner' | 'member' } }): void {
  if (c.get('user').role !== 'owner') {
    throw ApiError.forbidden('Only the owner can configure AI')
  }
}

aiRoutes.get('/config', async (c) => {
  requireOwner(c)
  const config = await getAiConfig(c.env.DB)
  return c.json(config)
})

aiRoutes.put('/config', async (c) => {
  requireOwner(c)
  const body = await readJson<AiConfigPatchBody>(c, 8 * 1024)

  if (body.baseUrl !== undefined) {
    const baseUrl = body.baseUrl.trim()
    if (baseUrl.length > 1024) throw ApiError.badRequest('Base URL is too long')
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      throw ApiError.badRequest('Base URL must start with http:// or https://')
    }
    await setAiConfig(c.env.DB, { baseUrl })
  }

  if (body.model !== undefined) {
    const model = body.model.trim()
    if (model.length > 128) throw ApiError.badRequest('Model name is too long')
    await setAiConfig(c.env.DB, { model })
  }

  if (body.imageModel !== undefined) {
    const imageModel = body.imageModel.trim()
    if (imageModel.length > 128) throw ApiError.badRequest('Image model name is too long')
    await setAiConfig(c.env.DB, { imageModel })
  }

  if (body.imageMethod !== undefined) {
    if (body.imageMethod !== 'generations' && body.imageMethod !== 'responses') {
      throw ApiError.badRequest('Invalid image method')
    }
    await setAiConfig(c.env.DB, { imageMethod: body.imageMethod })
  }

  if (body.apiKey !== undefined) {
    if (body.apiKey === null || body.apiKey.trim() === '') {
      await clearAiKeyCipher(c.env.DB)
    } else {
      const key = body.apiKey.trim()
      if (key.length > 512) throw ApiError.badRequest('API key is too long')
      const cipher = await encryptAiKey(c.env, key)
      await setAiKeyCipher(c.env.DB, cipher)
    }
  }

  const config = await getAiConfig(c.env.DB)
  return c.json(config)
})

aiRoutes.post('/summarize', async (c) => {
  const body = await readJson<AiContentBody>(c, AI_BODY_LIMIT)
  const content = validateContent(body.selection ?? body.content)
  const config = await resolveAiConfig(c.env)
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystem('summarize', body.locale) },
    { role: 'user', content },
  ]
  const stream = streamChatCompletion(config, messages, {
    signal: c.req.raw.signal,
    temperature: 0.3,
  })
  return sseFromChunks(stream)
})

aiRoutes.post('/polish', async (c) => {
  const body = await readJson<AiContentBody>(c, AI_BODY_LIMIT)
  const content = validateContent(body.selection ?? body.content)
  const config = await resolveAiConfig(c.env)
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystem('polish', body.locale) },
    { role: 'user', content },
  ]
  const stream = streamChatCompletion(config, messages, {
    signal: c.req.raw.signal,
    temperature: 0.5,
  })
  return sseFromChunks(stream)
})

aiRoutes.post('/draft', async (c) => {
  const body = await readJson<AiDraftBody>(c, AI_BODY_LIMIT)
  const topic = validateTopic(body.topic)
  const config = await resolveAiConfig(c.env)
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystem('draft', body.locale) },
    { role: 'user', content: topic },
  ]
  const stream = streamChatCompletion(config, messages, {
    signal: c.req.raw.signal,
    temperature: 0.7,
  })
  return sseFromChunks(stream)
})

aiRoutes.post('/continue', async (c) => {
  const body = await readJson<AiContinueBody>(c, AI_BODY_LIMIT)
  const content = validateContent(body.content)
  const config = await resolveAiConfig(c.env)
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystem('continue', body.locale) },
    { role: 'user', content },
  ]
  const stream = streamChatCompletion(config, messages, {
    signal: c.req.raw.signal,
    temperature: 0.7,
  })
  return sseFromChunks(stream)
})

aiRoutes.post('/edit', async (c) => {
  const body = await readJson<AiEditBody>(c, AI_BODY_LIMIT)
  const instruction = validateTopic(body.instruction)
  const content = validateContent(body.selection ?? body.content)
  const config = await resolveAiConfig(c.env)
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystem('edit', body.locale) },
    { role: 'user', content: `Instruction: ${instruction}\n\nText to edit:\n\n${content}` },
  ]
  const stream = streamChatCompletion(config, messages, {
    signal: c.req.raw.signal,
    temperature: 0.5,
  })
  return sseFromChunks(stream)
})

aiRoutes.post('/image', async (c) => {
  const body = await readJson<AiImageBody>(c, AI_BODY_LIMIT)
  const prompt = validateTopic(body.prompt)
  if (body.size && !['1024x1024', '1792x1024', '1024x1792'].includes(body.size)) {
    throw ApiError.badRequest('Invalid image size')
  }
  const config = await resolveAiConfig(c.env)
  const genOptions = { size: body.size, signal: c.req.raw.signal }
  const result = config.imageMethod === 'responses'
    ? await generateImageViaResponses(config, prompt, genOptions)
    : await generateImage(config, prompt, genOptions)
  return c.json(result)
})