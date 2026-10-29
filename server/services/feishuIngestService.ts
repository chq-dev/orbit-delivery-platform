import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../db/database.js'
import { config } from '../config.js'
import { notFound, unprocessable } from '../domain/errors.js'
import { formatDisplayTime, nowIso } from '../domain/time.js'
import type { Priority, WorkItemStatus, WorkItemType } from '../domain/types.js'
import { oneOf, optionalText, requiredText } from '../domain/validation.js'
import {
  reconcileFeishuWorkItems,
  upsertFeishuWorkItems,
  type SyncedFeishuWorkItem,
} from './workItemService.js'

const workItemTypes = ['requirement', 'defect'] as const
const priorities = ['紧急', '高', '中', '低'] as const
const workItemStatuses = ['待处理', '进行中', '已交付', '已关闭'] as const
const INTEGRATION_ID = 'feishu-main'

export interface FeishuIngestInput {
  projectKey: unknown
  repoId: unknown
  items: unknown
  reconcile?: unknown
  activeExternalIds?: unknown
}

export interface FeishuIngestResult {
  fetched: number
  upserted: number
  created: number
  updated: number
  archived: number
  skipped: number
  message: string
  syncedAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeTimestamp(value: unknown): string {
  if (value === undefined || value === null || value === '') return nowIso()
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const numeric = Number(value)
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000
    const date = new Date(milliseconds)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  if (typeof value === 'string') {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return nowIso()
}

function normalizeItem(raw: unknown, projectKey: string): SyncedFeishuWorkItem {
  if (!isRecord(raw)) throw unprocessable('工作项格式不正确')
  const type = oneOf(raw.type, '工作项类型', workItemTypes) as WorkItemType
  const title = requiredText(raw.title, '标题', { max: 300 })
  const externalId = requiredText(raw.externalId, '外部工作项编号', { max: 200 })
  if (!externalId.startsWith(`${projectKey}:`)) {
    throw unprocessable(`外部工作项编号必须以 ${projectKey}: 开头`)
  }
  return {
    externalId,
    type,
    title,
    description: optionalText(raw.description, '描述', 20_000) ?? title,
    priority: oneOf(raw.priority, '优先级', priorities) as Priority,
    owner: optionalText(raw.owner, '负责人', 100) ?? config.feishuDefaultOwner,
    updatedAt: normalizeTimestamp(raw.updatedAt),
    status:
      raw.status === undefined || raw.status === ''
        ? undefined
        : (oneOf(raw.status, '工作项状态', workItemStatuses) as WorkItemStatus),
    feishuStatus: optionalText(raw.feishuStatus, '飞书状态', 100),
  }
}

export function ingestFeishuWorkItems(
  db: AppDatabase,
  input: FeishuIngestInput,
): FeishuIngestResult {
  const projectKey = requiredText(input.projectKey, '项目标识', { max: 200 })
  const repoId = requiredText(input.repoId, '默认仓库', { max: 200 })
  const rawItems = Array.isArray(input.items) ? input.items : []
  if (rawItems.length > 500) throw unprocessable('单次最多接收 500 条工作项')

  const reconcile = input.reconcile === true
  let activeExternalIds: string[] = []
  if (reconcile) {
    if (!Array.isArray(input.activeExternalIds)) {
      throw unprocessable('删除对账必须提供 activeExternalIds')
    }
    if (input.activeExternalIds.length > 10_000) {
      throw unprocessable('单次删除对账最多接收 10000 条活动工作项')
    }
    activeExternalIds = input.activeExternalIds.map((externalId) =>
      requiredText(externalId, '活动工作项编号', { max: 200 }),
    )
    if (activeExternalIds.length === 0) {
      throw unprocessable('完整同步未返回活动工作项，已跳过删除对账')
    }
  }

  const repository = db
    .prepare('SELECT id FROM repositories WHERE id = ?')
    .get(repoId) as { id: string } | undefined
  if (!repository) throw notFound('关联仓库')

  const items = rawItems.map((item) => normalizeItem(item, projectKey))
  const now = nowIso()
  const result = db.transaction(() => {
    const upsertInbox = db.prepare(
      `INSERT INTO feishu_inbox
        (external_id, type, title, description, priority, repo_id, owner, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(external_id) DO UPDATE SET
         type = excluded.type,
         title = excluded.title,
         description = excluded.description,
         priority = excluded.priority,
         repo_id = excluded.repo_id,
         owner = excluded.owner,
         updated_at = excluded.updated_at`,
    )
    for (const item of items) {
      upsertInbox.run(
        item.externalId,
        item.type,
        item.title,
        item.description,
        item.priority,
        repoId,
        item.owner,
        item.updatedAt,
      )
    }

    const upserted = upsertFeishuWorkItems(db, repoId, items)
    const reconciled = reconcile
      ? reconcileFeishuWorkItems(db, activeExternalIds)
      : { archived: 0, inboxRemoved: 0 }
    const message = `已接收外部飞书同步 ${items.length} 条工作项，新增 ${upserted.created} 条、更新 ${upserted.updated} 条${
      reconciled.archived > 0 ? `，归档 ${reconciled.archived} 条飞书已删除项` : ''
    }`

    const integration = db
      .prepare('SELECT id FROM feishu_integrations WHERE id = ?')
      .get(INTEGRATION_ID) as { id: string } | undefined
    if (integration) {
      db.prepare(
        `UPDATE feishu_integrations
         SET status = 'active', last_sync_at = ?, last_sync_status = 'success',
             last_sync_message = ?, updated_at = ?
         WHERE id = ?`,
      ).run(now, message, now, INTEGRATION_ID)
      db.prepare(
        `INSERT INTO feishu_sync_logs
          (id, integration_id, trigger_type, status, fetched, upserted, skipped, message, created_at)
         VALUES (?, ?, 'manual', 'success', ?, ?, 0, ?, ?)`,
      ).run(
        randomUUID(),
        INTEGRATION_ID,
        items.length,
        items.length,
        message,
        now,
      )
    }

    return {
      fetched: items.length,
      upserted: items.length,
      created: upserted.created,
      updated: upserted.updated,
      archived: reconciled.archived,
      skipped: 0,
      message,
      syncedAt: formatDisplayTime(now),
    }
  })()

  return result
}

export function getExternalFeishuStatus(db: AppDatabase) {
  const count = db
    .prepare(
      `SELECT COUNT(*) AS count FROM work_items
       WHERE source = 'feishu' AND archived_at IS NULL`,
    )
    .get() as { count: number }
  if (count.count === 0) return undefined

  const latest = db
    .prepare(
      `SELECT repo_id, updated_at FROM work_items
       WHERE source = 'feishu' AND archived_at IS NULL
       ORDER BY updated_at DESC, id DESC LIMIT 1`,
    )
    .get() as { repo_id: string; updated_at: string } | undefined

  return {
    connected: true as const,
    status: 'active' as const,
    authMode: 'cli' as const,
    projectKey: config.feishuProjectKey,
    defaultRepoId: latest?.repo_id,
    requirementTypeKey: config.feishuRequirementTypeKey,
    defectTypeKey: config.feishuDefectTypeKey,
    defaultOwner: config.feishuDefaultOwner,
    webhookConfigured: false,
    lastSyncAt: latest?.updated_at,
    lastSyncStatus: 'success' as const,
    lastSyncMessage: `已通过外部 Meegle CLI 同步 ${count.count} 条工作项`,
    eventPath: '/api/integrations/feishu/events',
  }
}
