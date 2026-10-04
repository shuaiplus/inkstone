import { extractAttachmentIds } from '@shared/markdown-utils'

const REFERENCE_SCAN_PAGE_SIZE = 10

export async function collectAttachmentReferences(
  db: D1Database,
  userId: string,
  wantedIds?: ReadonlySet<string>,
): Promise<Map<string, number>> {
  const references = new Map<string, number>()
  if (wantedIds?.size === 0) return references

  // Retained versions must remain restorable after unused attachments are pruned.
  for (const table of ['notes', 'note_versions'] as const) {
    let afterId = ''
    while (true) {
      const { results } = await db.prepare(
        `SELECT id, content FROM ${table}
          WHERE user_id = ?1 AND id > ?2 ORDER BY id ASC LIMIT ?3`,
      ).bind(userId, afterId, REFERENCE_SCAN_PAGE_SIZE).all<{ id: string; content: string }>()
      if (!results.length) break

      for (const note of results) {
        for (const id of extractAttachmentIds(note.content)) {
          if (wantedIds && !wantedIds.has(id)) continue
          references.set(id, (references.get(id) ?? 0) + 1)
        }
      }
      afterId = results[results.length - 1]!.id
      if (results.length < REFERENCE_SCAN_PAGE_SIZE) break
    }
  }
  return references
}
