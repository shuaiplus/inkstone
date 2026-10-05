import { BLOG_PRIVATE_TAG, BLOG_PUBLIC_TAG, MOMENTS_FOLDER_NAME } from '@shared/blog/tags'
import { getMeta } from '../db/metadata'

export interface BlogSettings {
  title: string
  description: string
  publicTag: string
  privateTag: string
  momentsFolder: string
}

const BLOG_TITLE_KEY = (userId: string): string => `blog_title:${userId}`
const BLOG_DESCRIPTION_KEY = (userId: string): string => `blog_description:${userId}`
const BLOG_PUBLIC_TAG_KEY = (userId: string): string => `blog_public_tag:${userId}`
const BLOG_PRIVATE_TAG_KEY = (userId: string): string => `blog_private_tag:${userId}`

interface BlogSettingsRow {
  title: string
  description: string
  public_tag: string
  private_tag: string
  moments_folder: string
}

/**
 * Reads blog_settings, falling back to the app_meta era keys while writers
 * still target app_meta. Writers move in a later phase; the table is the
 * source of truth whenever its row exists.
 */
export async function getBlogSettings(db: D1Database, userId: string): Promise<BlogSettings> {
  const row = await db
    .prepare(
      `SELECT title, description, public_tag, private_tag, moments_folder
         FROM blog_settings WHERE user_id = ?1`,
    )
    .bind(userId)
    .first<BlogSettingsRow>()
  if (row) {
    return {
      title: row.title,
      description: row.description,
      publicTag: row.public_tag,
      privateTag: row.private_tag,
      momentsFolder: row.moments_folder,
    }
  }
  const [title, description, publicTag, privateTag] = await Promise.all([
    getMeta(db, BLOG_TITLE_KEY(userId)),
    getMeta(db, BLOG_DESCRIPTION_KEY(userId)),
    getMeta(db, BLOG_PUBLIC_TAG_KEY(userId)),
    getMeta(db, BLOG_PRIVATE_TAG_KEY(userId)),
  ])
  return {
    title: title ?? '',
    description: description ?? '',
    publicTag: publicTag || BLOG_PUBLIC_TAG,
    privateTag: privateTag || BLOG_PRIVATE_TAG,
    momentsFolder: MOMENTS_FOLDER_NAME,
  }
}
