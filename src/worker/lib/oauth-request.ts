import { FORM_BODY_LIMITS, readUrlEncodedFormWithinLimit } from './request'

export async function normalizeRepeatedOAuthResource(request: Request): Promise<Request> {
  const url = new URL(request.url)
  if (url.pathname === '/authorize') {
    const resources = url.searchParams.getAll('resource')
    if (resources.length > 1 && resources.every((resource) => resource === resources[0])) {
      url.searchParams.delete('resource')
      url.searchParams.set('resource', resources[0]!)
      return new Request(url, request)
    }
    return request
  }
  if (url.pathname !== '/oauth/token' || request.method !== 'POST' ||
      !request.headers.get('Content-Type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return request
  }

  const form = await readUrlEncodedFormWithinLimit({
    raw: request,
    header: (name) => request.headers.get(name) ?? undefined,
  }, FORM_BODY_LIMITS.oauthToken)
  const resources = form.getAll('resource')
  if (resources.length > 1 && resources.every((resource) => resource === resources[0])) {
    form.delete('resource')
    form.set('resource', resources[0]!)
  }
  // Rebuild after consuming the bounded body so the provider can read it once.
  const headers = new Headers(request.headers)
  headers.delete('Content-Length')
  return new Request(request, { body: form.toString(), headers })
}
