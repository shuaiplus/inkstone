// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { normalizeRepeatedOAuthResource } from '../src/worker/lib/oauth-request'
import { FORM_BODY_LIMITS } from '../src/worker/lib/request'

function tokenRequest(body: string, headers = {}) {
  return new Request('https://inkstone.test/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body,
  })
}

it('rejects an oversized token form without Content-Length', async () => {
  await expect(normalizeRepeatedOAuthResource(tokenRequest('x'.repeat(FORM_BODY_LIMITS.oauthToken + 1))))
    .rejects.toMatchObject({ status: 413 })
})

it('cancels a streamed oversized token form', async () => {
  const cancel = vi.fn()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(FORM_BODY_LIMITS.oauthToken + 1))
    },
    cancel,
  })
  const request = new Request('https://inkstone.test/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    duplex: 'half',
  } as RequestInit)
  await expect(normalizeRepeatedOAuthResource(request)).rejects.toMatchObject({ status: 413 })
  expect(cancel).toHaveBeenCalledOnce()
})

it('keeps normal token forms readable and collapses identical resources', async () => {
  const request = await normalizeRepeatedOAuthResource(tokenRequest('grant_type=refresh_token&resource=a&resource=a'))
  const form = new URLSearchParams(await request.text())
  expect(form.get('grant_type')).toBe('refresh_token')
  expect(form.getAll('resource')).toEqual(['a'])
  const single = await normalizeRepeatedOAuthResource(tokenRequest('resource=a&refresh_token=abc'))
  expect(new URLSearchParams(await single.text()).get('refresh_token')).toBe('abc')
})

it('preserves different resource values for the provider to validate', async () => {
  const request = await normalizeRepeatedOAuthResource(tokenRequest('resource=a&resource=b'))
  expect(new URLSearchParams(await request.text()).getAll('resource')).toEqual(['a', 'b'])
})
