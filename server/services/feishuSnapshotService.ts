import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SyncedFeishuWorkItem } from './workItemService.js'

export interface FeishuSnapshotFile {
  version: 1
  source: 'feishu'
  projectKey: string
  syncedAt: string
  generatedBy: 'meegle-cli'
  items: SyncedFeishuWorkItem[]
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

export function writeFeishuSnapshot(path: string, snapshot: FeishuSnapshotFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  renameSync(temporaryPath, path)
}
