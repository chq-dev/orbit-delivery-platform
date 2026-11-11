import type { AppDatabase } from '../db/database.js'
import { defaultOwnerUserId } from '../db/ownership.js'
import { nextSequence } from '../db/sequences.js'
import { conflict, notFound, unprocessable } from '../domain/errors.js'
import { formatDisplayTime, nowIso } from '../domain/time.js'
import type {
  Priority,
  WorkItem,
  WorkItemStatus,
  WorkItemType,
} from '../domain/types.js'
import { optionalText, oneOf, requiredText } from '../domain/validation.js'
import { requirementDeliveryContextIssue } from '../../src/deliveryContext.js'

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
  source: 'local' | 'feishu' | 'ruijie'
  external_id: string | null
  feishu_status: string | null
  project_line: string | null
  design_reference: string | null
  requirement_breakdown: string | null
  defect_note: string | null
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

export interface SyncedRuijieWorkItem {
  externalId: string
  type: WorkItemType
  title: string
  description: string
  priority: Priority
  owner: string
  updatedAt: string
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
    defectNote: row.defect_note || undefined,
    requirementScreenshotCount: Number(row.requirement_screenshot_count ?? 0),
  }
}

function selectSql(): string {
  return `SELECT id, type, title, description, priority, status, repo_id, branch, owner,
                 source, external_id, feishu_status, project_line, design_reference,
                 requirement_breakdown, defect_note,
                 (SELECT COUNT(*) FROM work_item_attachments
                  WHERE work_item_attachments.work_item_id = work_items.id)
                   AS requirement_screenshot_count,
                 created_at, updated_at
          FROM work_items`
}

export function listWorkItems(db: AppDatabase, ownerUserId?: string): WorkItem[] {
  const query = `${selectSql()} WHERE archived_at IS NULL${
    ownerUserId === undefined ? '' : ' AND owner_user_id = ?'
  } ORDER BY created_at DESC, id DESC`
  const rows = (ownerUserId === undefined
    ? db.prepare(query).all()
    : db.prepare(query).all(ownerUserId)) as WorkItemRow[]
  return rows.map(rowToWorkItem)
}

export function listWorkItemSummaries(db: AppDatabase, ownerUserId?: string): WorkItem[] {
  const query =
      `SELECT id, type, title, '' AS description, priority, status, repo_id, branch, owner,
              source, external_id, feishu_status, project_line, design_reference,
              '' AS requirement_breakdown, defect_note,
              (SELECT COUNT(*) FROM work_item_attachments
               WHERE work_item_attachments.work_item_id = work_items.id)
                AS requirement_screenshot_count,
              created_at, updated_at
       FROM work_items
       WHERE archived_at IS NULL${ownerUserId === undefined ? '' : ' AND owner_user_id = ?'}
       ORDER BY created_at DESC, id DESC`
  const rows = (ownerUserId === undefined
    ? db.prepare(query).all()
    : db.prepare(query).all(ownerUserId)) as WorkItemRow[]
  return rows.map(rowToWorkItem)
}

export function getWorkItem(db: AppDatabase, id: string, ownerUserId?: string): WorkItem {
  const query = `${selectSql()} WHERE id = ? AND archived_at IS NULL${
    ownerUserId === undefined ? '' : ' AND owner_user_id = ?'
  }`
  const row = (ownerUserId === undefined
    ? db.prepare(query).get(id)
    : db.prepare(query).get(id, ownerUserId)) as WorkItemRow | undefined
  if (!row) throw notFound('工作项')
  return rowToWorkItem(row)
}

export interface WorkItemDeliveryContextInput {
  requirementBreakdown?: unknown
  designReference?: unknown
  defectNote?: unknown
}

export interface WorkItemDeliveryContext {
  workItem: WorkItem
  requirementBreakdown?: string
  designReference?: string
  defectNote?: string
}

export function getWorkItemDeliveryContext(
  db: AppDatabase,
  id: string,
  ownerUserId?: string,
): WorkItemDeliveryContext {
  const workItem = getWorkItem(db, id, ownerUserId)
  return {
    workItem,
    requirementBreakdown: workItem.requirementBreakdown,
    designReference: workItem.designReference,
    defectNote: workItem.defectNote,
  }
}

export function saveWorkItemDeliveryContext(
  db: AppDatabase,
  id: string,
  rawInput: WorkItemDeliveryContextInput,
  ownerUserId?: string,
): WorkItemDeliveryContext {
  const workItem = getWorkItem(db, id, ownerUserId)
  const current = getWorkItemDeliveryContext(db, id, ownerUserId)
  const requirementBreakdown =
    rawInput.requirementBreakdown === undefined
      ? current.requirementBreakdown
      : optionalText(rawInput.requirementBreakdown, '需求拆解', 20_000)
  const designReference =
    rawInput.designReference === undefined
      ? current.designReference
      : optionalText(rawInput.designReference, '设计稿链接或本地路径', 2_000)
  const defectNote =
    rawInput.defectNote === undefined
      ? current.defectNote
      : optionalText(rawInput.defectNote, '缺陷说明', 20_000)

  if (workItem.type === 'requirement') {
    const issue = requirementDeliveryContextIssue({
      requirementBreakdown,
      designReference,
    })
    if (issue) throw unprocessable(issue)
  }

  const now = nowIso()
  db.transaction(() => {
    db.prepare(
      `UPDATE work_items
       SET requirement_breakdown = ?, design_reference = ?, defect_note = ?, updated_at = ?
       WHERE id = ?`,
    ).run(requirementBreakdown ?? null, designReference ?? null, defectNote ?? null, now, id)
  })()

  return getWorkItemDeliveryContext(db, id, ownerUserId)
}

export function assertRequirementDeliveryContextReady(
  db: AppDatabase,
  id: string,
  ownerUserId?: string,
): void {
  const workItem = getWorkItem(db, id, ownerUserId)
  if (workItem.type !== 'requirement') return
  const issue = requirementDeliveryContextIssue({
    requirementBreakdown: workItem.requirementBreakdown,
    designReference: workItem.designReference,
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
  source: 'local' | 'feishu' | 'ruijie'
  externalId?: string
  designReference?: string
  requirementBreakdown?: string
}

function normalizeWorkItemInput(input: WorkItemInput, forcedSource?: 'feishu'): NormalizedWorkItem {
  const type = oneOf(input.type, '工作项类型', workItemTypes)
  const source =
    forcedSource ??
    (input.source === 'feishu' || input.source === 'ruijie' ? input.source : 'local')
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
  ownerUserId?: string,
): WorkItem {
  const repo = db
    .prepare(
      ownerUserId === undefined
        ? 'SELECT branch, owner_user_id FROM repositories WHERE id = ?'
        : 'SELECT branch, owner_user_id FROM repositories WHERE id = ? AND owner_user_id = ?',
    )
    .get(...(ownerUserId === undefined ? [input.repoId] : [input.repoId, ownerUserId])) as
    | { branch: string; owner_user_id: string }
    | undefined
  if (!repo) throw notFound('关联仓库')
  const workItemOwner = defaultOwnerUserId(db, repo.owner_user_id || ownerUserId)

  const prefix = input.type === 'requirement' ? 'REQ' : 'BUG'
  const sequenceName = input.type === 'requirement' ? 'work_item_requirement' : 'work_item_defect'
  const initial = input.type === 'requirement' ? 1082 : 236
  const id = `${prefix}-${nextSequence(db, sequenceName, initial)}`
  db.prepare(
    `INSERT INTO work_items
      (id, owner_user_id, type, title, description, priority, status, repo_id, branch, owner, source,
       external_id, design_reference, requirement_breakdown, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '待处理', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workItemOwner,
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

export function createWorkItem(
  db: AppDatabase,
  rawInput: WorkItemInput,
  ownerUserId?: string,
): WorkItem {
  const input = normalizeWorkItemInput(rawInput)
  if (input.externalId) {
    const duplicate = db
      .prepare(
        ownerUserId === undefined
          ? 'SELECT id FROM work_items WHERE source = ? AND external_id = ?'
          : 'SELECT id FROM work_items WHERE owner_user_id = ? AND source = ? AND external_id = ?',
      )
      .get(
        ...(ownerUserId === undefined
          ? [input.source, input.externalId]
          : [ownerUserId, input.source, input.externalId]),
      ) as { id: string } | undefined
    if (duplicate) throw conflict(`外部工作项 ${input.externalId} 已导入`)
  }

  return db.transaction(() => createInTransaction(db, input, nowIso(), ownerUserId))()
}

export function importWorkItems(
  db: AppDatabase,
  rawInputs: unknown,
  ownerUserId?: string,
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
          .prepare(
            ownerUserId === undefined
              ? 'SELECT id FROM work_items WHERE source = ? AND external_id = ?'
              : 'SELECT id FROM work_items WHERE owner_user_id = ? AND source = ? AND external_id = ?',
          )
          .get(
            ...(ownerUserId === undefined
              ? ['feishu', input.externalId]
              : [ownerUserId, 'feishu', input.externalId]),
          ) as { id: string } | undefined
        if (duplicate) {
          skipped += 1
          continue
        }
      }
      created.push(createInTransaction(db, input, nowIso(), ownerUserId))
    }
  })()

  return { items: created, skipped }
}

type ExternalWorkItemSource = 'feishu' | 'ruijie'

interface SyncedExternalWorkItem {
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

function upsertExternalWorkItems(
  db: AppDatabase,
  repoId: string,
  items: SyncedExternalWorkItem[],
  source: ExternalWorkItemSource,
): WorkItemUpsertResult {
  const repository = db
    .prepare('SELECT branch, owner_user_id FROM repositories WHERE id = ?')
    .get(repoId) as { branch: string; owner_user_id: string } | undefined
  if (!repository) throw notFound('关联仓库')
  const ownerUserId = defaultOwnerUserId(db, repository.owner_user_id)

  const existingRows = db
    .prepare(
      `SELECT id, external_id FROM work_items
       WHERE owner_user_id = ? AND source = ? AND external_id IS NOT NULL`,
    )
    .all(ownerUserId, source) as Array<{ id: string; external_id: string }>
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
      (id, owner_user_id, type, title, description, priority, status, repo_id, branch, owner, source, external_id,
       feishu_status, project_line, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ownerUserId,
      item.type,
      item.title,
      item.description,
      item.priority,
      status,
      repoId,
      repository.branch,
      item.owner,
      source,
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

export function upsertFeishuWorkItems(
  db: AppDatabase,
  repoId: string,
  items: SyncedFeishuWorkItem[],
): WorkItemUpsertResult {
  return upsertExternalWorkItems(db, repoId, items, 'feishu')
}

export function upsertRuijieWorkItems(
  db: AppDatabase,
  repoId: string,
  items: SyncedRuijieWorkItem[],
): WorkItemUpsertResult {
  return upsertExternalWorkItems(db, repoId, items, 'ruijie')
}

export function reconcileFeishuWorkItems(
  db: AppDatabase,
  activeExternalIds: string[],
  now = nowIso(),
  ownerUserId?: string,
): FeishuReconcileResult {
  if (activeExternalIds.length === 0) {
    throw unprocessable('完整同步未返回活动工作项，已跳过删除对账')
  }

  const activeIdentities = new Set(activeExternalIds.map(externalIdentity))
  const workItemRows = db
    .prepare(
      `SELECT id, external_id FROM work_items
       WHERE source = 'feishu' AND external_id IS NOT NULL AND external_id <> ''
         AND archived_at IS NULL${ownerUserId === undefined ? '' : ' AND owner_user_id = ?'}`,
    )
    .all(...(ownerUserId === undefined ? [] : [ownerUserId])) as Array<{
    id: string
    external_id: string
  }>
  const inboxRows = db
    .prepare(
      `SELECT external_id FROM feishu_inbox${
        ownerUserId === undefined ? '' : ' WHERE owner_user_id = ?'
      }`,
    )
    .all(...(ownerUserId === undefined ? [] : [ownerUserId])) as Array<{ external_id: string }>
  const archiveWorkItem = db.prepare(
    'UPDATE work_items SET archived_at = ? WHERE id = ? AND archived_at IS NULL',
  )
  const deleteInboxItem = db.prepare(
    'DELETE FROM feishu_inbox WHERE external_id = ? AND owner_user_id = ?',
  )

  let archived = 0
  let inboxRemoved = 0
  db.transaction(() => {
    for (const row of workItemRows) {
      if (activeIdentities.has(externalIdentity(row.external_id))) continue
      archived += archiveWorkItem.run(now, row.id).changes
    }
    for (const row of inboxRows) {
      if (activeIdentities.has(externalIdentity(row.external_id))) continue
      inboxRemoved += deleteInboxItem.run(row.external_id, ownerUserId ?? '').changes
    }
  })()

  return { archived, inboxRemoved }
}
