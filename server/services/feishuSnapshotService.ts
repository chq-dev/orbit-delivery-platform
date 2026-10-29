import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AppDatabase } from '../db/database.js'
import type { WorkItemStatus } from '../domain/types.js'
import type { SyncedFeishuWorkItem } from './workItemService.js'

export interface FeishuSnapshotWorkItem extends SyncedFeishuWorkItem {
  status?: WorkItemStatus
  repoId?: string
  branch?: string
}

export interface FeishuSnapshotFile {
  version: 1
  source: 'feishu'
  projectKey: string
  syncedAt: string
  generatedBy: 'meegle-cli'
  items: FeishuSnapshotWorkItem[]
}

function sanitizeSnapshotText(value: string): string {
  return value
    .replace(
      /([?&](?:[^=&#\s]*?(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)[^=&#\s]*?)=)[^&#\s]*/gi,
      '$1[REDACTED]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, 'Bearer [REDACTED]')
}

export function buildFeishuSnapshot(
  projectKey: string,
  items: SyncedFeishuWorkItem[],
  syncedAt = new Date().toISOString(),
): FeishuSnapshotFile {
  return {
    version: 1,
    source: 'feishu',
    projectKey,
    syncedAt,
    generatedBy: 'meegle-cli',
    items: items
      .map((item) => ({
        ...item,
        title: sanitizeSnapshotText(item.title),
        description: sanitizeSnapshotText(item.description),
        owner: sanitizeSnapshotText(item.owner),
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  }
}

interface SnapshotRow {
  type: 'requirement' | 'defect'
  title: string
  description: string
  priority: '紧急' | '高' | '中' | '低'
  status: WorkItemStatus
  repo_id: string
  branch: string
  owner: string
  external_id: string
  updated_at: string
}

export function readFeishuSnapshotFromDatabase(
  db: AppDatabase,
  projectKey: string,
): FeishuSnapshotFile | null {
  const rows = db
    .prepare(
      `SELECT type, title, description, priority, status, repo_id, branch, owner,
              external_id, updated_at
       FROM work_items
       WHERE source = 'feishu' AND external_id IS NOT NULL AND external_id <> ''
       ORDER BY updated_at DESC, id DESC`,
    )
    .all() as SnapshotRow[]
  if (rows.length === 0) return null

  const fallbackTime = new Date().toISOString()
  const items: FeishuSnapshotWorkItem[] = rows.map((row) => ({
    externalId: row.external_id,
    type: row.type,
    title: row.title,
    description: row.description,
    priority: row.priority,
    owner: row.owner,
    updatedAt: Number.isNaN(Date.parse(row.updated_at)) ? fallbackTime : row.updated_at,
    status: row.status,
    repoId: row.repo_id,
    branch: row.branch,
  }))
  const syncedAt = items.reduce(
    (latest, item) => (item.updatedAt > latest ? item.updatedAt : latest),
    '',
  ) || fallbackTime

  return buildFeishuSnapshot(projectKey, items, syncedAt)
}

export function writeFeishuSnapshot(path: string, snapshot: FeishuSnapshotFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  renameSync(temporaryPath, path)
}
