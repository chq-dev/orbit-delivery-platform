import { createHash } from 'node:crypto'
import type { Priority, WorkItemType } from '../domain/types.js'
import { nowIso } from '../domain/time.js'

const DEFAULT_PAGE_SIZE = 200
const MAX_PAGES = 20
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

interface TokenCacheEntry {
  token: string
  expiresAt: number
}

const tokenCache = new Map<string, TokenCacheEntry>()

export interface FeishuProjectClientConfig {
  baseUrl: string
  projectKey: string
  pluginId?: string
  pluginSecret?: string
  accessToken?: string
  userKey: string
}

export interface FeishuInboxRecord {
  externalId: string
  type: WorkItemType
  title: string
  description: string
  priority: Priority
  owner: string
  updatedAt: string
}

export interface FeishuConnectionTest {
  projectKey: string
  projectName?: string
  requirementTypeKey: string
  defectTypeKey: string
}

export class FeishuProjectError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details?: unknown

  constructor(message: string, statusCode = 502, code = 'FEISHU_API_ERROR', details?: unknown) {
    super(message)
    this.name = 'FeishuProjectError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapData(payload: unknown): unknown {
  if (isRecord(payload) && 'data' in payload) return payload.data
  return payload
}

function extractItems(payload: unknown): unknown[] {
  const data = unwrapData(payload)
  if (Array.isArray(data)) return data
  if (!isRecord(data)) return []
  const keys = ['work_items', 'work_item_list', 'items', 'list', 'records', 'projects']
  for (const key of keys) {
    const value = data[key]
    if (Array.isArray(value)) return value
  }
  return []
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = scalarText(item)
      if (text) return text
    }
    return ''
  }
  if (isRecord(value)) {
    for (const key of ['text', 'label', 'name', 'title', 'value', 'user_key', 'key', 'email', 'id']) {
      const text = scalarText(value[key])
      if (text) return text
    }
  }
  return ''
}

function fieldMapOf(raw: Record<string, unknown>): Map<string, unknown> {
  const result = new Map<string, unknown>()
  const sources = [raw.fields, raw.field_values, raw.field_value_pairs, raw.custom_fields]
  for (const source of sources) {
    if (Array.isArray(source)) {
      for (const field of source) {
        if (!isRecord(field)) continue
        const key = scalarText(field.field_key ?? field.key ?? field.name)
        if (!key) continue
        result.set(key, field.field_value ?? field.value ?? field.text ?? field.label)
      }
      continue
    }
    if (isRecord(source)) {
      for (const [key, value] of Object.entries(source)) result.set(key, value)
    }
  }
  return result
}

function findValue(
  raw: Record<string, unknown>,
  fields: Map<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const direct = scalarText(raw[key])
    if (direct) return direct
    const mapped = scalarText(fields.get(key))
    if (mapped) return mapped
  }
  return ''
}

function recordId(raw: Record<string, unknown>): string {
  const nested = isRecord(raw.work_item) ? raw.work_item : undefined
  return scalarText(
    raw.id ?? raw.work_item_id ?? raw.workItemId ?? nested?.id ?? nested?.work_item_id,
  )
}

function normalizePriority(value: string): Priority {
  const text = value.toLowerCase()
  if (/紧急|urgent|critical|blocker|p0|最高|严重/.test(text)) return '紧急'
  if (/高|high|major|p1/.test(text)) return '高'
  if (/低|low|minor|trivial|p3/.test(text)) return '低'
  return '中'
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const numeric = Number(value)
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000
    const date = new Date(milliseconds)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return nowIso()
}

function mapWorkItem(
  raw: unknown,
  type: WorkItemType,
  projectKey: string,
  typeKey: string,
  defaultOwner: string,
): FeishuInboxRecord | undefined {
  if (!isRecord(raw)) return undefined
  const id = recordId(raw)
  if (!id) return undefined
  const fields = fieldMapOf(raw)
  const title = findValue(raw, fields, ['name', 'title', 'summary', 'work_item_name'])
  if (!title) return undefined
  const description = findValue(raw, fields, [
    'description',
    'desc',
    'detail',
    'content',
    'requirement_description',
  ])
  const priorityText = findValue(raw, fields, [
    'priority',
    'priority_key',
    'priority_level',
    'severity',
  ])
  const owner = findValue(raw, fields, [
    'owner',
    'assignee',
    'assignee_key',
    'user_key',
    'created_by',
  ])
  const updatedAt = normalizeTimestamp(
    raw.updated_at ?? raw.update_time ?? raw.updatedAt ?? raw.modified_at,
  )

  return {
    externalId: `${projectKey}:${typeKey}:${id}`,
    type,
    title,
    description: description || title,
    priority: normalizePriority(priorityText),
    owner: owner || defaultOwner,
    updatedAt,
  }
}

function mergeWorkItems(summaries: unknown[], details: unknown[]): unknown[] {
  if (summaries.length === 0) return details
  if (details.length === 0) return summaries
  const byId = new Map<string, Record<string, unknown>>()
  for (const detail of details) {
    if (!isRecord(detail)) continue
    const id = recordId(detail)
    if (id) byId.set(id, detail)
  }
  return summaries.map((summary) => {
    if (!isRecord(summary)) return summary
    const id = recordId(summary)
    const detail = id ? byId.get(id) : undefined
    return detail ? { ...summary, ...detail } : summary
  })
}

export class FeishuProjectClient {
  private readonly config: FeishuProjectClientConfig
  private readonly tokenCacheKey: string

  constructor(config: FeishuProjectClientConfig) {
    this.config = config
    this.tokenCacheKey = createHash('sha256')
      .update(
        `${config.baseUrl}|${config.projectKey}|${config.pluginId ?? ''}|${config.pluginSecret ?? ''}|${config.accessToken ?? ''}`,
      )
      .digest('hex')
  }

  private path(path: string): string {
    return `${this.config.baseUrl.replace(/\/$/, '')}${path}`
  }

  private async request(
    path: string,
    init: RequestInit,
    token?: string,
  ): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(this.path(path), {
        ...init,
        headers: {
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { 'X-PLUGIN-TOKEN': token } : {}),
          ...(token && this.config.userKey ? { 'X-USER-KEY': this.config.userKey } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw new FeishuProjectError(
        `无法连接飞书项目：${error instanceof Error ? error.message : '网络错误'}`,
        502,
        'FEISHU_NETWORK_ERROR',
      )
    }

    const text = await response.text()
    let payload: unknown = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = { message: text }
      }
    }

    if (!response.ok) {
      const record = isRecord(payload) ? payload : {}
      const error = isRecord(record.error) ? record.error : undefined
      const message =
        scalarText(error?.msg ?? record.err_msg ?? record.message) || `HTTP ${response.status}`
      throw new FeishuProjectError(message, response.status, 'FEISHU_API_ERROR', payload)
    }

    if (isRecord(payload)) {
      const error = isRecord(payload.error) ? payload.error : undefined
      const code = error?.code ?? payload.err_code ?? payload.code
      if (typeof code === 'number' && code !== 0) {
        const message =
          scalarText(error?.msg ?? payload.err_msg ?? payload.message) ||
          `飞书项目接口返回错误码 ${code}`
        throw new FeishuProjectError(message, 502, 'FEISHU_API_ERROR', payload)
      }
    }

    return payload
  }

  private async getPluginToken(): Promise<string> {
    if (this.config.accessToken) return this.config.accessToken
    const cached = tokenCache.get(this.tokenCacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.token

    if (!this.config.pluginId || !this.config.pluginSecret) {
      throw new FeishuProjectError(
        '缺少飞书项目访问 Token 或 Plugin 凭证',
        401,
        'FEISHU_CREDENTIALS_MISSING',
      )
    }

    const payload = await this.request('/open_api/authen/plugin_token', {
      method: 'POST',
      body: JSON.stringify({
        plugin_id: this.config.pluginId,
        plugin_secret: this.config.pluginSecret,
        type: 0,
      }),
    })
    const data = unwrapData(payload)
    if (!isRecord(data)) {
      throw new FeishuProjectError('飞书项目 Token 响应格式异常', 502, 'FEISHU_TOKEN_INVALID')
    }
    const token = scalarText(data.token)
    const expireSeconds = Number(data.expire_time ?? data.expire)
    if (!token) {
      throw new FeishuProjectError('飞书项目未返回 plugin_token', 502, 'FEISHU_TOKEN_INVALID')
    }
    const expiresAt =
      Date.now() +
      Math.max(60_000, (Number.isFinite(expireSeconds) ? expireSeconds : 3600) * 1000 - TOKEN_REFRESH_MARGIN_MS)
    tokenCache.set(this.tokenCacheKey, { token, expiresAt })
    return token
  }

  private async authorizedRequest(path: string, init: RequestInit): Promise<unknown> {
    const token = await this.getPluginToken()
    return this.request(path, init, token)
  }

  async testConnection(requirementTypeKey: string, defectTypeKey: string): Promise<FeishuConnectionTest> {
    const token = await this.getPluginToken()
    const detail = await this.request(
      '/open_api/projects/detail',
      {
        method: 'POST',
        body: JSON.stringify({
          project_keys: [this.config.projectKey],
          simple_names: [this.config.projectKey],
          ...(this.config.userKey ? { user_key: this.config.userKey } : {}),
        }),
      },
      token,
    )
    const detailData = unwrapData(detail)
    const detailRows = extractItems(detailData)
    const projectMapEntries = isRecord(detailData)
      ? Object.values(detailData).filter((value): value is Record<string, unknown> =>
          isRecord(value),
        )
      : []
    const projectMapEntry =
      projectMapEntries.find((entry) => {
        return [entry.project_key, entry.simple_name, entry.key].some(
          (value) => scalarText(value) === this.config.projectKey,
        )
      }) ?? projectMapEntries[0]
    if (isRecord(projectMapEntry)) {
      const projectName = scalarText(
        projectMapEntry.name ?? projectMapEntry.project_name ?? projectMapEntry.title,
      )
      for (const typeKey of [requirementTypeKey, defectTypeKey]) {
        await this.request(
          `/open_api/${encodeURIComponent(this.config.projectKey)}/work_item/${encodeURIComponent(typeKey)}/meta`,
          { method: 'GET' },
          token,
        )
      }
      return {
        projectKey: this.config.projectKey,
        projectName: projectName || undefined,
        requirementTypeKey,
        defectTypeKey,
      }
    }
    const project = detailRows.find((row) => {
      if (!isRecord(row)) return false
      return scalarText(row.project_key ?? row.simple_name ?? row.key) === this.config.projectKey
    })
    const directProject =
      isRecord(detailData) &&
      scalarText(detailData.project_key ?? detailData.simple_name ?? detailData.key) ===
        this.config.projectKey
    if (!project && !directProject) {
      throw new FeishuProjectError(
        `飞书项目 ${this.config.projectKey} 不存在或当前服务账号无权访问`,
        422,
        'FEISHU_PROJECT_NOT_ACCESSIBLE',
        detail,
      )
    }

    for (const typeKey of [requirementTypeKey, defectTypeKey]) {
      await this.request(
        `/open_api/${encodeURIComponent(this.config.projectKey)}/work_item/${encodeURIComponent(typeKey)}/meta`,
        { method: 'GET' },
        token,
      )
    }

    const projectRecord = isRecord(project) ? project : isRecord(detailData) ? detailData : undefined
    const projectName = projectRecord
      ? scalarText(projectRecord.name ?? projectRecord.project_name ?? projectRecord.title)
      : undefined
    return {
      projectKey: this.config.projectKey,
      projectName: projectName || undefined,
      requirementTypeKey,
      defectTypeKey,
    }
  }

  private async listWorkItemPage(typeKey: string, pageNum: number): Promise<unknown[]> {
    const payload = await this.authorizedRequest(
      `/open_api/${encodeURIComponent(this.config.projectKey)}/work_item/filter`,
      {
        method: 'POST',
        body: JSON.stringify({
          work_item_type_keys: [typeKey],
          page_num: pageNum,
          page_size: DEFAULT_PAGE_SIZE,
        }),
      },
    )
    return extractItems(payload)
  }

  private async queryWorkItems(typeKey: string, ids: string[]): Promise<unknown[]> {
    const numericIds = ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))
    if (numericIds.length === 0) return []
    const payload = await this.authorizedRequest(
      `/open_api/${encodeURIComponent(this.config.projectKey)}/work_item/${encodeURIComponent(typeKey)}/query`,
      {
        method: 'POST',
        body: JSON.stringify({
          work_item_ids: numericIds,
          expand: { need_workflow: true, need_multi_text: true },
        }),
      },
    )
    return extractItems(payload)
  }

  private async listWorkItems(typeKey: string): Promise<unknown[]> {
    const summaries: unknown[] = []
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const rows = await this.listWorkItemPage(typeKey, page)
      summaries.push(...rows)
      if (rows.length < DEFAULT_PAGE_SIZE) break
    }

    const details: unknown[] = []
    for (let index = 0; index < summaries.length; index += 50) {
      const chunk = summaries.slice(index, index + 50)
      const ids = chunk
        .map((row) => (isRecord(row) ? recordId(row) : ''))
        .filter(Boolean)
      if (ids.length === 0) continue
      try {
        details.push(...(await this.queryWorkItems(typeKey, ids)))
      } catch {
        // The filter endpoint is enough to populate the inbox when detail access is unavailable.
      }
    }
    return mergeWorkItems(summaries, details)
  }

  async fetchInboxItems(
    requirementTypeKey: string,
    defectTypeKey: string,
    defaultOwner: string,
  ): Promise<{ items: FeishuInboxRecord[]; fetched: number; skipped: number }> {
    const result: FeishuInboxRecord[] = []
    let fetched = 0

    for (const [type, typeKey] of [
      ['requirement', requirementTypeKey],
      ['defect', defectTypeKey],
    ] as const) {
      const rawItems = await this.listWorkItems(typeKey)
      fetched += rawItems.length
      for (const raw of rawItems) {
        const mapped = mapWorkItem(raw, type, this.config.projectKey, typeKey, defaultOwner)
        if (mapped) result.push(mapped)
      }
    }

    return { items: result, fetched, skipped: fetched - result.length }
  }

  async closeWorkItem(
    projectKey: string,
    typeKey: string,
    workItemId: string,
    closeTransitionId?: string,
  ): Promise<void> {
    if (!closeTransitionId) {
      throw new FeishuProjectError(
        '未配置关闭流转 ID，无法将缺陷回写为已关闭',
        422,
        'FEISHU_CLOSE_TRANSITION_MISSING',
      )
    }
    const transitionId = Number(closeTransitionId)
    if (!Number.isFinite(transitionId)) {
      throw new FeishuProjectError('关闭流转 ID 必须是数字', 422, 'FEISHU_CLOSE_TRANSITION_INVALID')
    }
    await this.authorizedRequest(
      `/open_api/${encodeURIComponent(projectKey)}/workflow/${encodeURIComponent(typeKey)}/${encodeURIComponent(workItemId)}/node/state_change`,
      {
        method: 'POST',
        body: JSON.stringify({ transition_id: transitionId }),
      },
    )
  }
}
