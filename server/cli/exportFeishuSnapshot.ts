import 'dotenv/config'
import { resolve } from 'node:path'
import { config } from '../config.js'
import { createDatabase } from '../db/database.js'
import type {
  Priority,
  WorkItemStatus,
  WorkItemType,
} from '../domain/types.js'
import {
  buildFeishuSnapshot,
  writeFeishuSnapshot,
} from '../services/feishuSnapshotService.js'
import type { SyncedFeishuWorkItem } from '../services/workItemService.js'

interface FeishuWorkItemRow {
  type: WorkItemType
  title: string
  description: string
  priority: Priority
  status: WorkItemStatus
  owner: string
  external_id: string
  feishu_status: string | null
  project_line: string | null
  updated_at: string
}

function snapshotPath(): string {
  return resolve(
    process.cwd(),
    process.env.FEISHU_SNAPSHOT_PATH?.trim() || 'data/feishu-work-items.json',
  )
}

const db = createDatabase({ filename: config.dbPath })
try {
  const rows = db
    .prepare(
      `SELECT type, title, description, priority, status, owner, external_id,
              feishu_status, project_line, updated_at
       FROM work_items
       WHERE source = 'feishu' AND external_id IS NOT NULL AND external_id <> ''
         AND archived_at IS NULL
       ORDER BY updated_at DESC, id DESC`,
    )
    .all() as FeishuWorkItemRow[]
  const items: SyncedFeishuWorkItem[] = rows.map((row) => ({
    externalId: row.external_id,
    type: row.type,
    title: row.title,
    description: row.description,
    priority: row.priority,
    owner: row.owner,
    status: row.status,
    feishuStatus: row.feishu_status ?? undefined,
    projectLine: row.project_line ?? undefined,
    updatedAt: Number.isNaN(Date.parse(row.updated_at))
      ? new Date().toISOString()
      : row.updated_at,
  }))
  const path = snapshotPath()
  const syncedAt = new Date().toISOString()
  writeFeishuSnapshot(path, buildFeishuSnapshot(config.feishuProjectKey, items, syncedAt))
  console.log(
    JSON.stringify(
      {
        snapshotFile: path,
        projectKey: config.feishuProjectKey,
        items: items.length,
        syncedAt,
      },
      null,
      2,
    ),
  )
} finally {
  db.close()
}
