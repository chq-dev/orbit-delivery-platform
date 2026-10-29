import type {
  Priority,
  Repository,
  WorkItem,
  WorkItemStatus,
  WorkItemType,
} from './types'

export interface FeishuSnapshotItem {
  externalId: string
  type: WorkItemType
  title: string
  description: string
  priority: Priority
  owner: string
  updatedAt: string
  status?: WorkItemStatus
  repoId?: string
  branch?: string
}

export interface FeishuSnapshot {
  version: 1
  source: 'feishu'
  projectKey: string
  syncedAt: string
  items: FeishuSnapshotItem[]
}

export interface ParsedFeishuSnapshot {
  snapshot: FeishuSnapshot
  skipped: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeType(value: unknown): WorkItemType | undefined {
  if (value === 'requirement' || value === 'defect') return value
  if (value === 'story') return 'requirement'
  if (value === 'issue' || value === 'bug') return 'defect'
  return undefined
}

function normalizePriority(value: unknown): Priority {
  if (value === '紧急' || value === '高' || value === '中' || value === '低') return value
  if (value === 'P0' || value === 'urgent') return '紧急'
  if (value === 'P1' || value === 'high') return '高'
  if (value === 'P3' || value === 'low') return '低'
  return '中'
}

function normalizeStatus(value: unknown): WorkItemStatus | undefined {
  if (value === '待处理' || value === '进行中' || value === '已交付' || value === '已关闭') {
    return value
  }
  return undefined
}

function displayTime(value: string): string {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return value || '-'
  const diffMinutes = Math.floor((Date.now() - timestamp) / 60_000)
  if (diffMinutes < 1) return '刚刚'
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`
  if (diffMinutes < 24 * 60) return `${Math.floor(diffMinutes / 60)} 小时前`
  if (diffMinutes < 48 * 60) return '昨天'
  return new Date(timestamp).toISOString().slice(0, 10)
}

function stableHash(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

function remoteItemId(externalId: string): string {
  const tail = externalId.split(':').pop()?.replace(/[^A-Za-z0-9_-]/g, '') ?? ''
  return tail || stableHash(externalId)
}

function identityOf(externalId: string): string {
  const parts = externalId.split(':').filter(Boolean)
  return parts.length >= 2 ? parts.slice(-2).join(':') : externalId
}

function snapshotId(item: FeishuSnapshotItem): string {
  const prefix = item.type === 'defect' ? 'BUG' : 'REQ'
  return `${prefix}-FS-${remoteItemId(item.externalId)}`
}

function mapItem(
  item: FeishuSnapshotItem,
  snapshot: FeishuSnapshot,
  repositories: Repository[],
): WorkItem {
  const repository =
    repositories.find((entry) => entry.id === item.repoId) ?? repositories[0]
  const updatedAt = displayTime(item.updatedAt || snapshot.syncedAt)
  return {
    id: snapshotId(item),
    type: item.type,
    title: item.title,
    description: item.description || item.title,
    priority: item.priority,
    status: item.status ?? '待处理',
    repoId: repository?.id ?? '',
    branch: item.branch || repository?.branch || '',
    owner: item.owner || '飞书同步',
    updatedAt,
    createdAt: updatedAt,
    source: 'feishu',
    externalId: item.externalId,
    frontendOnly: true,
  }
}

export function parseFeishuSnapshot(payload: unknown): ParsedFeishuSnapshot {
  if (!isRecord(payload)) throw new Error('飞书快照格式错误：根节点必须是 JSON 对象')
  if (payload.version !== 1) throw new Error('飞书快照格式错误：不支持的版本')
  if (payload.source !== undefined && payload.source !== 'feishu') {
    throw new Error('飞书快照格式错误：source 必须为 feishu')
  }
  if (!Array.isArray(payload.items)) throw new Error('飞书快照格式错误：items 必须是数组')

  const syncedAt = text(payload.syncedAt)
  const projectKey = text(payload.projectKey)
  const items: FeishuSnapshotItem[] = []
  let skipped = 0

  for (const raw of payload.items) {
    if (!isRecord(raw)) {
      skipped += 1
      continue
    }
    const externalId = text(raw.externalId)
    const type = normalizeType(raw.type)
    const title = text(raw.title)
    if (!externalId || !type || !title) {
      skipped += 1
      continue
    }
    items.push({
      externalId,
      type,
      title,
      description: text(raw.description),
      priority: normalizePriority(raw.priority),
      owner: text(raw.owner) || '飞书同步',
      updatedAt: text(raw.updatedAt) || syncedAt,
      status: normalizeStatus(raw.status),
      repoId: text(raw.repoId) || undefined,
      branch: text(raw.branch) || undefined,
    })
  }

  return {
    snapshot: {
      version: 1,
      source: 'feishu',
      projectKey,
      syncedAt,
      items,
    },
    skipped,
  }
}

export function mapFeishuSnapshotItems(
  snapshot: FeishuSnapshot,
  repositories: Repository[],
): WorkItem[] {
  return snapshot.items.map((item) => mapItem(item, snapshot, repositories))
}

export function mergeFeishuSnapshot(
  serverItems: WorkItem[],
  snapshotItems: WorkItem[],
): WorkItem[] {
  const snapshotByIdentity = new Map(
    snapshotItems.map((item) => [identityOf(item.externalId ?? item.id), item]),
  )
  const mergedServerItems = serverItems.map((item) => {
    if (item.source !== 'feishu' || !item.externalId) return item
    const identity = identityOf(item.externalId)
    const snapshot = snapshotByIdentity.get(identity)
    if (!snapshot) return item
    snapshotByIdentity.delete(identity)
    return {
      ...item,
      title: snapshot.title,
      description: snapshot.description,
      priority: snapshot.priority,
      owner: snapshot.owner,
      updatedAt: snapshot.updatedAt,
      frontendOnly: false,
    }
  })
  return [...mergedServerItems, ...snapshotByIdentity.values()]
}
