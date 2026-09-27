import type {
  BlogPostsResponse, BlogPostDetail, BlogMomentsResponse, BlogTag,
  BlogPostSummary, BlogTimelineResponse,
} from '@shared/blog/types'
import { CLIENT_HEADER } from '@shared/constants'

const BLOG_API = '/api/blog'

export class BlogAuthError extends Error {
  constructor() { super('Blog authentication required') }
}

async function blogFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BLOG_API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', [CLIENT_HEADER]: '1', ...init?.headers },
  })
  if (res.status === 401) throw new BlogAuthError()
  if (!res.ok) throw new Error(`Blog API error: ${res.status}`)
  return res.json() as Promise<T>
}

export async function blogLogin(username: string, password: string): Promise<boolean> {
  const res = await fetch(`${BLOG_API}/${encodeURIComponent(username)}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [CLIENT_HEADER]: '1' },
    body: JSON.stringify({ password }),
  })
  return res.ok
}

export const blogApi = {
  auth: blogLogin,
  session: (username: string) =>
    blogFetch<{ authed: boolean }>(`/${encodeURIComponent(username)}/session`),
  logout: (username: string) =>
    blogFetch<{ ok: true }>(`/${encodeURIComponent(username)}/logout`, { method: 'POST' }),
  meta: (username: string) =>
    blogFetch<{ username: string; title: string | null; description: string | null }>(`/${encodeURIComponent(username)}/meta`),
  posts: (username: string, page = 1, limit = 10) =>
    blogFetch<BlogPostsResponse>(`/${encodeURIComponent(username)}/posts?page=${page}&limit=${limit}`),
  post: (username: string, slug: string) =>
    blogFetch<BlogPostDetail>(`/${encodeURIComponent(username)}/posts/${encodeURIComponent(slug)}`),
  moments: (username: string, page = 1, limit = 20) =>
    blogFetch<BlogMomentsResponse>(`/${encodeURIComponent(username)}/moments?page=${page}&limit=${limit}`),
  timeline: (username: string, page = 1, limit = 20) =>
    blogFetch<BlogTimelineResponse>(`/${encodeURIComponent(username)}/timeline?page=${page}&limit=${limit}`),
  tags: (username: string) =>
    blogFetch<{ tags: BlogTag[] }>(`/${encodeURIComponent(username)}/tags`),
  tag: (username: string, name: string) =>
    blogFetch<{ name: string; posts: BlogPostSummary[] }>(`/${encodeURIComponent(username)}/tags/${encodeURIComponent(name)}`),
  settings: () =>
    blogFetch<{ hasCustomPassword: boolean; title: string | null; description: string | null }>('/settings'),
  updateSettings: (body: { password?: string | null; title?: string; description?: string | null }) =>
    blogFetch<{ ok: true }>('/settings', { method: 'PUT', body: JSON.stringify(body) }),
}
