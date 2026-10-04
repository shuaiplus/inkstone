import type { TargetRow } from './engine'
import { backupArchivePath } from './archive'
import type { Snapshot } from './snapshot'

export async function retainSuccessfulBackup(
  db: D1Database,
  target: TargetRow,
  snapshot: Pick<Snapshot, 'stamp' | 'createdAt'>,
  keep: number,
  remove: (path: string) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(keep) || keep <= 0) return
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${target.type}:${target.config}`))
  const destination = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const archivePath = backupArchivePath(snapshot)
  const current = await db.prepare(
    `SELECT config FROM backup_targets WHERE user_id = ?1 AND id = ?2 AND enabled = 1`,
  ).bind(target.user_id, target.id).first<{ config: string }>()
  if (!current || current.config !== target.config) return
  await db.prepare(
    `INSERT OR IGNORE INTO backup_archives (user_id, target_id, destination, archive_path, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(target.user_id, target.id, destination, archivePath, snapshot.createdAt.getTime()).run()
  const { results } = await db.prepare(
    `SELECT archive_path FROM backup_archives
     WHERE user_id = ?1 AND target_id = ?2 AND destination = ?3
     ORDER BY created_at DESC, archive_path DESC LIMIT 51 OFFSET ?4`,
  ).bind(target.user_id, target.id, destination, keep).all<{ archive_path: string }>()
  for (const row of results.slice(0, 50)) {
    if (row.archive_path === archivePath || !/^backups\/inkstone-backup-\d{8}-\d{6}-\d{3}\.zip$/.test(row.archive_path)) continue
    await remove(row.archive_path)
    await db.prepare(
      `DELETE FROM backup_archives WHERE user_id = ?1 AND target_id = ?2 AND destination = ?3 AND archive_path = ?4`,
    ).bind(target.user_id, target.id, destination, row.archive_path).run()
  }
  if (results.length > 50) throw new Error('Old backup cleanup will continue after the next successful backup')
}
