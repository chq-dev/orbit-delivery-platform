import type { AppDatabase } from '../db/database.js'
import { formatDisplayTime } from '../domain/time.js'
import type { FeishuInboxItem, Priority, WorkItemType } from '../domain/types.js'

interface InboxRow {
  external_id: string
  type: WorkItemType
  title: string
  description: string
  priority: Priority
  repo_id: string
  owner: string
  updated_at: string
}

export function listFeishuInbox(db: AppDatabase): FeishuInboxItem[] {
  const rows = db
    .prepare(
      `SELECT external_id, type, title, description, priority, repo_id, owner, updated_at
       FROM feishu_inbox ORDER BY updated_at DESC`,
    )
    .all() as InboxRow[]
  return rows.map((row) => ({
    externalId: row.external_id,
    type: row.type,
    title: row.title,
    description: row.description,
    priority: row.priority,
    repoId: row.repo_id,
    owner: row.owner,
    updatedAt: formatDisplayTime(row.updated_at),
  }))
}
