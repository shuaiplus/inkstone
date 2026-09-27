export interface BlogPostSummary {
  id: string
  title: string
  excerpt: string
  created_at: number
  updated_at: number
  tags: string[]
  slug: string
}

export interface BlogPostDetail extends BlogPostSummary {
  content: string
}

export interface TimelineItem {
  id: string
  title: string
  created_at: number
  year: string
  slug: string
}

export interface BlogTag {
  name: string
  count: number
}

export interface MomentItem {
  id: string
  content: string
  created_at: number
  tags: string[]
  slug: string
}

export interface BlogPostsResponse {
  posts: BlogPostSummary[]
  page: number
  hasMore: boolean
}

