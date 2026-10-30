import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../db/database.js'
import { nextSequence } from '../db/sequences.js'
import { conflict, notFound, unprocessable } from '../domain/errors.js'
import { formatDisplayTime, nowIso } from '../domain/time.js'
import type {
  Priority,
  WorkItem,
  WorkItemScreenshot,
  WorkItemStatus,
  WorkItemType,
} from '../domain/types.js'
import { optionalText, oneOf, requiredText } from '../domain/validation.js'
import {
  DELIVERY_SCREENSHOT_MIME_TYPES,
  MAX_DELIVERY_SCREENSHOT_BYTES,
  MAX_DELIVERY_SCREENSHOTS,
  MAX_DELIVERY_SCREENSHOTS_TOTAL_BYTES,
  requirementDeliveryContextIssue,
  type DeliveryScreenshotMimeType,
} from '../../src/deliveryContext.js'

const workItemTypes = ['requirement', 'defect'] as const
const priorities = ['紧急', '高', '中', '低'] as const

interface WorkItemRow {
  id: string
  type: WorkItemType
  title: string
  description: string
  priority: Priority
  status: WorkItemStatus
  repo_id: string
  branch: string
  owner: string
  source: 'local' | 'feishu'
  external_id: string | null
  feishu_status: string | null
  project_line: string | null
  design_reference: string | null
  requirement_breakdown: string | null
  requirement_screenshot_count: number
  created_at: string
  updated_at: string
}

export interface WorkItemInput {
  type: unknown
  title: unknown
  description: unknown
  priority: unknown
  repoId: unknown
  branch?: unknown
  owner: unknown
  source?: unknown
  externalId?: unknown
  designReference?: unknown
  requirementBreakdown?: unknown
}

export interface SyncedFeishuWorkItem {
  externalId: string
  type: WorkItemType
  title: string
  description: string
  priority: Priority
  owner: string
  updatedAt: string
  status?: WorkItemStatus
  feishuStatus?: string
  projectLine?: string
}

export interface WorkItemUpsertResult {
  created: number
  updated: number
}

export interface FeishuReconcileResult {
  archived: number
  inboxRemoved: number
}

function externalIdentity(externalId: string): string {
  const parts = externalId.split(':').filter(Boolean)
  return parts.length >= 2 ? parts.slice(-2).join(':') : externalId
}

function rowToWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    repoId: row.repo_id,
    branch: row.branch,
    owner: row.owner,
    updatedAt: formatDisplayTime(row.updated_at),
    createdAt: row.created_at.slice(0, 10),
    source: row.source,
    externalId: row.external_id ?? undefined,
    feishuStatus: row.feishu_status ?? undefined,
    projectLine: row.project_line ?? undefined,
    designReference: row.design_reference ?? undefined,
    requirementBreakdown: row.requirement_breakdown || undefined,
    requirementScreenshotCount: Number(row.requirement_screenshot_count ?? 0),
  }
}

function selectSql(): string {
  return `SELECT id, type, title, description, priority, status, repo_id, branch, owner,
                 source, external_id, feishu_status, project_line, design_reference,
                 requirement_breakdown,
                 (SELECT COUNT(*) FROM work_item_attachments
                  WHERE work_item_attachments.work_item_id = work_items.id)
                   AS requirement_screenshot_count,
                 created_at, updated_at
          FROM work_items`
}

export function listWorkItems(db: AppDatabase): WorkItem[] {
  const rows = db
    .prepare(`${selectSql()} WHERE archived_at IS NULL ORDER BY created_at DESC, id DESC`)
    .all() as WorkItemRow[]
  return rows.map(rowToWorkItem)
}

export function listWorkItemSummaries(db: AppDatabase): WorkItem[] {
  const rows = db
    .prepare(
      `SELECT id, type, title, '' AS description, priority, status, repo_id, branch, owner,
              source, external_id, feishu_status, project_line, design_reference,
              '' AS requirement_breakdown,
              (SELECT COUNT(*) FROM work_item_attachments
               WHERE work_item_attachments.work_item_id = work_items.id)
                AS requirement_screenshot_count,
              created_at, updated_at
       FROM work_items
       WHERE archived_at IS NULL
       ORDER BY created_at DESC, id DESC`,
    )
    .all() as WorkItemRow[]
  return rows.map(rowToWorkItem)
}

export function getWorkItem(db: AppDatabase, id: string): WorkItem {
  const row = db
    .prepare(`${selectSql()} WHERE id = ? AND archived_at IS NULL`)
    .get(id) as WorkItemRow | undefined
  if (!row) throw notFound('工作项')
  return rowToWorkItem(row)
}

export interface WorkItemDeliveryContextInput {
  requirementBreakdown?: unknown
  designReference?: unknown
  screenshots?: unknown
}

export interface WorkItemDeliveryContext {
  workItem: WorkItem
  requirementBreakdown?: string
  designReference?: string
  screenshots: WorkItemScreenshot[]
}

interface ScreenshotRow {
  name: string
  mime_type: string
  size_bytes: number
  data_base64: string
}

interface NormalizedScreenshot {
  name: string
  mimeType: DeliveryScreenshotMimeType
  sizeBytes: number
  dataBase64: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function screenshotName(value: unknown, index: number, mimeType: DeliveryScreenshotMimeType): string {
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg'
  const fallback = `design-screenshot-${index + 1}.${extension}`
  const candidate = typeof value === 'string' ? value.trim() : ''
  return (candidate || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[._]+/, '_')
    .slice(0, 120)
}

function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

function normalizeScreenshots(value: unknown): NormalizedScreenshot[] {
  if (!Array.isArray(value)) throw unprocessable('设计截图必须是数组')
  if (value.length > MAX_DELIVERY_SCREENSHOTS) {
    throw unprocessable(`设计截图最多上传 ${MAX_DELIVERY_SCREENSHOTS} 张`)
  }

  let totalBytes = 0
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw unprocessable(`第 ${index + 1} 张设计截图格式不正确`)
    const mimeType = optionalText(entry.mimeType, '截图类型', 100) ?? ''
    if (!DELIVERY_SCREENSHOT_MIME_TYPES.includes(mimeType as DeliveryScreenshotMimeType)) {
      throw unprocessable('设计截图仅支持 PNG、JPEG 或 WebP')
    }
    const typedMimeType = mimeType as DeliveryScreenshotMimeType
    const dataUrl = typeof entry.dataUrl === 'string' ? entry.dataUrl.trim() : ''
    const prefix = `data:${typedMimeType};base64,`
    if (!dataUrl.startsWith(prefix)) throw unprocessable('设计截图内容格式不正确')
    const dataBase64 = dataUrl.slice(prefix.length)
    if (
      !dataBase64 ||
      dataBase64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)
    ) {
      throw unprocessable('设计截图不是合法的 Base64 图片')
    }
    const sizeBytes = base64ByteLength(dataBase64)
    if (sizeBytes <= 0) throw unprocessable('设计截图内容为空')
    if (sizeBytes > MAX_DELIVERY_SCREENSHOT_BYTES) {
      throw unprocessable(
        `第 ${index + 1} 张设计截图超过 ${Math.floor(MAX_DELIVERY_SCREENSHOT_BYTES / 1024)}KB，请压缩后重试`,
      )
    }
    totalBytes += sizeBytes
    if (totalBytes > MAX_DELIVERY_SCREENSHOTS_TOTAL_BYTES) {
      throw unprocessable(
        `设计截图合计不能超过 ${Math.floor(MAX_DELIVERY_SCREENSHOTS_TOTAL_BYTES / 1024)}KB`,
      )
    }
    return {
      name: screenshotName(entry.name, index, typedMimeType),
      mimeType: typedMimeType,
      sizeBytes,
      dataBase64,
    }
  })
}

function deliveryScreenshots(db: AppDatabase, workItemId: string): WorkItemScreenshot[] {
  const rows = db
    .prepare(
      `SELECT name, mime_type, size_bytes, data_base64
       FROM work_item_attachments
       WHERE work_item_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(workItemId) as ScreenshotRow[]
  return rows.map((row) => ({
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    dataUrl: `data:${row.mime_type};base64,${row.data_base64}`,
  }))
}

export function getWorkItemDeliveryContext(
  db: AppDatabase,
  id: string,
): WorkItemDeliveryContext {
  const workItem = getWorkItem(db, id)
  return {
    workItem,
    requirementBreakdown: workItem.requirementBreakdown,
    designReference: workItem.designReference,
    screenshots: deliveryScreenshots(db, id),
  }
}

export function saveWorkItemDeliveryContext(
  db: AppDatabase,
  id: string,
  rawInput: WorkItemDeliveryContextInput,
): WorkItemDeliveryContext {
  const workItem = getWorkItem(db, id)
  const current = getWorkItemDeliveryContext(db, id)
  const requirementBreakdown =
    rawInput.requirementBreakdown === undefined
      ? current.requirementBreakdown
      : optionalText(rawInput.requirementBreakdown, '需求拆解', 20_000)
  const designReference =
    rawInput.designReference === undefined
      ? current.designReference
      : optionalText(rawInput.designReference, '设计稿链接或本地路径', 2_000)
  const screenshots =
    rawInput.screenshots === undefined ? undefined : normalizeScreenshots(rawInput.screenshots)
  const screenshotCount = screenshots?.length ?? current.screenshots.length

  if (workItem.type === 'requirement') {
    const issue = requirementDeliveryContextIssue({
      requirementBreakdown,
      designReference,
      screenshotCount,
    })
    if (issue) throw unprocessable(issue)
  }

  const now = nowIso()
  db.transaction(() => {
    db.prepare(
      `UPDATE work_items
       SET requirement_breakdown = ?, design_reference = ?, updated_at = ?
       WHERE id = ?`,
    ).run(requirementBreakdown ?? null, designReference ?? null, now, id)
    if (screenshots !== undefined) {
      db.prepare('DELETE FROM work_item_attachments WHERE work_item_id = ?').run(id)
      const insert = db.prepare(
        `INSERT INTO work_item_attachments
          (id, work_item_id, name, mime_type, size_bytes, data_base64, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const screenshot of screenshots) {
        insert.run(
          `attachment-${randomUUID()}`,
          id,
          screenshot.name,
          screenshot.mimeType,
          screenshot.sizeBytes,
          screenshot.dataBase64,
          now,
        )
      }
    }
  })()

  return getWorkItemDeliveryContext(db, id)
}

export function assertRequirementDeliveryContextReady(db: AppDatabase, id: string): void {
  const workItem = getWorkItem(db, id)
  if (workItem.type !== 'requirement') return
  const issue = requirementDeliveryContextIssue({
    requirementBreakdown: workItem.requirementBreakdown,
    designReference: workItem.designReference,
    screenshotCount: workItem.requirementScreenshotCount,
  })
  if (issue) throw unprocessable(issue)
}

interface NormalizedWorkItem {
  type: WorkItemType
  title: string
  description: string
  priority: Priority
  repoId: string
  owner: string
  source: 'local' | 'feishu'
  externalId?: string
  designReference?: string
  requirementBreakdown?: string
}

function normalizeWorkItemInput(input: WorkItemInput, forcedSource?: 'feishu'): NormalizedWorkItem {
  const type = oneOf(input.type, '工作项类型', workItemTypes)
  const source = forcedSource ?? (input.source === 'feishu' ? 'feishu' : 'local')
  return {
    type,
    title: requiredText(input.title, '标题', { max: 300 }),
    description: requiredText(input.description, '描述', { max: 20_000 }),
    priority: oneOf(input.priority, '优先级', priorities),
    repoId: requiredText(input.repoId, '关联仓库', { max: 200 }),
    owner: requiredText(input.owner, '负责人', { max: 100 }),
    source,
    externalId: optionalText(input.externalId, '外部工作项编号', 200),
    designReference: optionalText(input.designReference, '设计稿或设计说明', 2_000),
    requirementBreakdown: optionalText(input.requirementBreakdown, '需求拆解', 20_000),
  }
}

function createInTransaction(
  db: AppDatabase,
  input: NormalizedWorkItem,
  now: string,
): WorkItem {
  const repo = db
    .prepare('SELECT branch FROM repositories WHERE id = ?')
    .get(input.repoId) as { branch: string } | undefined
  if (!repo) throw notFound('关联仓库')

  const prefix = input.type === 'requirement' ? 'REQ' : 'BUG'
  const sequenceName = input.type === 'requirement' ? 'work_item_requirement' : 'work_item_defect'
  const initial = input.type === 'requirement' ? 1082 : 236
  const id = `${prefix}-${nextSequence(db, sequenceName, initial)}`
  db.prepare(
    `INSERT INTO work_items
      (id, type, title, description, priority, status, repo_id, branch, owner, source,
       external_id, design_reference, requirement_breakdown, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '待处理', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.type,
    input.title,
    input.description,
    input.priority,
    input.repoId,
    repo.branch,
    input.owner,
    input.source,
    input.externalId ?? null,
    input.designReference ?? null,
    input.requirementBreakdown ?? null,
    now,
    now,
  )
  return getWorkItem(db, id)
}

export function createWorkItem(db: AppDatabase, rawInput: WorkItemInput): WorkItem {
  const input = normalizeWorkItemInput(rawInput)
  if (input.externalId) {
    const duplicate = db
      .prepare('SELECT id FROM work_items WHERE source = ? AND external_id = ?')
      .get(input.source, input.externalId) as { id: string } | undefined
    if (duplicate) throw conflict(`外部工作项 ${input.externalId} 已导入`)
  }

  return db.transaction(() => createInTransaction(db, input, nowIso()))()
}

export function importWorkItems(
  db: AppDatabase,
  rawInputs: unknown,
): { items: WorkItem[]; skipped: number } {
  if (!Array.isArray(rawInputs) || rawInputs.length === 0) {
    throw unprocessable('导入工作项不能为空')
  }
  if (rawInputs.length > 500) throw unprocessable('单次最多导入 500 条工作项')

  const inputs = rawInputs.map((input) => normalizeWorkItemInput(input as WorkItemInput, 'feishu'))
  const created: WorkItem[] = []
  let skipped = 0

  db.transaction(() => {
    for (const input of inputs) {
      if (input.externalId) {
        const duplicate = db
          .prepare('SELECT id FROM work_items WHERE source = ? AND external_id = ?')
          .get('feishu', input.externalId) as { id: string } | undefined
        if (duplicate) {
          skipped += 1
          continue
        }
      }
      created.push(createInTransaction(db, input, nowIso()))
    }
  })()

  return { items: created, skipped }
}

export function upsertFeishuWorkItems(
  db: AppDatabase,
  repoId: string,
  items: SyncedFeishuWorkItem[],
): WorkItemUpsertResult {
  const repository = db
    .prepare('SELECT branch FROM repositories WHERE id = ?')
    .get(repoId) as { branch: string } | undefined
  if (!repository) throw notFound('关联仓库')

  const existingRows = db
    .prepare("SELECT id, external_id FROM work_items WHERE source = 'feishu' AND external_id IS NOT NULL")
    .all() as Array<{ id: string; external_id: string }>
  const existingByIdentity = new Map(
    existingRows.map((row) => [externalIdentity(row.external_id), row.id]),
  )
  const updateExisting = db.prepare(
    `UPDATE work_items
     SET title = ?, description = ?, priority = ?, repo_id = ?, branch = ?, owner = ?,
         status = CASE
           WHEN ? = '已关闭' THEN '已关闭'
           WHEN status = '待处理' THEN ?
           ELSE status
         END,
         feishu_status = ?, project_line = ?, archived_at = NULL, updated_at = ?
     WHERE id = ?`,
  )
  const insertWorkItem = db.prepare(
    `INSERT INTO work_items
      (id, type, title, description, priority, status, repo_id, branch, owner, source, external_id,
       feishu_status, project_line, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'feishu', ?, ?, ?, ?, ?)`,
  )

  let created = 0
  let updated = 0
  for (const item of items) {
    const status = item.status ?? '待处理'
    const feishuStatus = item.feishuStatus ?? null
    const projectLine = item.projectLine ?? null
    const identity = externalIdentity(item.externalId)
    const existingId = existingByIdentity.get(identity)
    if (existingId) {
      updateExisting.run(
        item.title,
        item.description,
        item.priority,
        repoId,
        repository.branch,
        item.owner,
        status,
        status,
        feishuStatus,
        projectLine,
        item.updatedAt,
        existingId,
      )
      updated += 1
      continue
    }

    const prefix = item.type === 'requirement' ? 'REQ' : 'BUG'
    const sequenceName =
      item.type === 'requirement' ? 'work_item_requirement' : 'work_item_defect'
    const initial = item.type === 'requirement' ? 1082 : 236
    const id = `${prefix}-${nextSequence(db, sequenceName, initial)}`
    insertWorkItem.run(
      id,
      item.type,
      item.title,
      item.description,
      item.priority,
      status,
      repoId,
      repository.branch,
      item.owner,
      item.externalId,
      feishuStatus,
      projectLine,
      item.updatedAt,
      item.updatedAt,
    )
    existingByIdentity.set(identity, id)
    created += 1
  }

  return { created, updated }
}

export function reconcileFeishuWorkItems(
  db: AppDatabase,
  activeExternalIds: string[],
  now = nowIso(),
): FeishuReconcileResult {
  if (activeExternalIds.length === 0) {
    throw unprocessable('完整同步未返回活动工作项，已跳过删除对账')
  }

  const activeIdentities = new Set(activeExternalIds.map(externalIdentity))
  const workItemRows = db
    .prepare(
      `SELECT id, external_id FROM work_items
       WHERE source = 'feishu' AND external_id IS NOT NULL AND external_id <> ''
         AND archived_at IS NULL`,
    )
    .all() as Array<{ id: string; external_id: string }>
  const inboxRows = db
    .prepare('SELECT external_id FROM feishu_inbox')
    .all() as Array<{ external_id: string }>
  const archiveWorkItem = db.prepare(
    'UPDATE work_items SET archived_at = ? WHERE id = ? AND archived_at IS NULL',
  )
  const deleteInboxItem = db.prepare('DELETE FROM feishu_inbox WHERE external_id = ?')

  let archived = 0
  let inboxRemoved = 0
  db.transaction(() => {
    for (const row of workItemRows) {
      if (activeIdentities.has(externalIdentity(row.external_id))) continue
      archived += archiveWorkItem.run(now, row.id).changes
    }
    for (const row of inboxRows) {
      if (activeIdentities.has(externalIdentity(row.external_id))) continue
      inboxRemoved += deleteInboxItem.run(row.external_id).changes
    }
  })()

  return { archived, inboxRemoved }
}
