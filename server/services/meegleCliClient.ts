import { execFile } from 'node:child_process'
import type { Priority, WorkItemType } from '../domain/types.js'
import { nowIso } from '../domain/time.js'
import type { SyncedFeishuWorkItem } from './workItemService.js'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGES = 100
const COMMAND_TIMEOUT_MS = 60_000
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export interface MeegleCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type MeegleCommandRunner = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<MeegleCommandResult>

export interface MeegleSyncConfig {
  command: string
  host: string
  projectKey: string
  requirementTypeKey: string
  defectTypeKey: string
  defaultOwner: string
  since?: string
  fetchDescriptions?: boolean
  env?: NodeJS.ProcessEnv
}

export interface MeegleFetchResult {
  items: SyncedFeishuWorkItem[]
  fetched: number
  skipped: number
  warnings: string[]
  complete: boolean
}

export class MeegleCliError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(message: string, code = 'MEEGLE_CLI_ERROR', details?: unknown) {
    super(message)
    this.name = 'MeegleCliError'
    this.code = code
    this.details = details
  }
}

interface QueryPage {
  rows: Record<string, unknown>[]
  count?: number
  sessionId?: string
  groupId: string
}

interface QueryTypeResult {
  rows: Record<string, unknown>[]
  complete: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function workItemId(value: unknown): string {
  if (!isRecord(value)) return ''
  const nested = isRecord(value.work_item) ? value.work_item : undefined
  return scalarText(
    value.work_item_id ?? value.workItemId ?? value.id ?? nested?.work_item_id ?? nested?.id,
  )
}

function workItemTitle(value: unknown): string {
  if (!isRecord(value)) return ''
  const nested = isRecord(value.work_item) ? value.work_item : undefined
  return scalarText(
    value.name ?? value.work_item_name ?? value.title ?? nested?.name ?? nested?.work_item_name,
  )
}

function collectWorkItemRows(value: unknown, rows: Map<string, Record<string, unknown>>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectWorkItemRows(item, rows)
    return
  }
  if (!isRecord(value)) return

  const id = workItemId(value)
  if (id && workItemTitle(value)) {
    const existing = rows.get(id)
    rows.set(id, existing ? { ...existing, ...value } : value)
  }
  for (const nested of Object.values(value)) collectWorkItemRows(nested, rows)
}

function findDeep(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeep(item, key)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (key in value) return value[key]
  for (const nested of Object.values(value)) {
    const found = findDeep(nested, key)
    if (found !== undefined) return found
  }
  return undefined
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function firstListGroup(payload: unknown): Record<string, unknown> | undefined {
  const list = findDeep(payload, 'list')
  if (!Array.isArray(list)) return undefined
  return list.find(isRecord)
}

function parseQueryPage(payload: unknown): QueryPage {
  const rows = new Map<string, Record<string, unknown>>()
  collectWorkItemRows(payload, rows)
  const group = firstListGroup(payload)
  const groupInfos = group?.group_infos
  const firstGroup = Array.isArray(groupInfos) ? groupInfos.find(isRecord) : undefined
  const count = positiveInteger(group?.count) ?? positiveInteger(findDeep(payload, 'count'))
  const sessionId = scalarText(findDeep(payload, 'session_id'))
  const groupId = scalarText(firstGroup?.group_id ?? firstGroup?.id) || '1'

  return {
    rows: [...rows.values()],
    count,
    sessionId: sessionId || undefined,
    groupId,
  }
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    const candidates = [trimmed.indexOf('{'), trimmed.indexOf('[')]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)
    for (const start of candidates) {
      const end = trimmed[start] === '{' ? trimmed.lastIndexOf('}') : trimmed.lastIndexOf(']')
      if (end <= start) continue
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {
        // Keep looking for a JSON document around diagnostics text.
      }
    }
  }
  return undefined
}

function commandError(result: MeegleCommandResult, args: string[]): MeegleCliError {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
  return new MeegleCliError(
    `Meegle CLI 执行失败：${detail}`,
    'MEEGLE_COMMAND_FAILED',
    { args, exitCode: result.exitCode },
  )
}

function validateConfig(config: MeegleSyncConfig): void {
  for (const [label, value] of [
    ['projectKey', config.projectKey],
    ['requirementTypeKey', config.requirementTypeKey],
    ['defectTypeKey', config.defectTypeKey],
  ] as const) {
    if (!IDENTIFIER_PATTERN.test(value)) {
      throw new MeegleCliError(`${label} 只能包含字母、数字和下划线`, 'MEEGLE_INVALID_CONFIG')
    }
  }
  if (config.since && !DATE_PATTERN.test(config.since)) {
    throw new MeegleCliError(
      '增量同步时间必须使用 YYYY-MM-DD 格式',
      'MEEGLE_INVALID_CONFIG',
    )
  }
}

function normalizeMeegleHost(host: string): string {
  return host
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
}

function buildMql(
  projectKey: string,
  typeKey: string,
  since: string | undefined,
): string {
  const fields = [
    '`work_item_id`',
    '`name`',
    '`work_item_status`',
    '`priority`',
    '`current_status_operator`',
    '`updated_at`',
  ].join(', ')
  const conditions = ['`archiving_date` IS NULL']
  if (since) conditions.push(`\`updated_at\` >= '${since}'`)
  const where = ` WHERE ${conditions.join(' AND ')}`
  return `SELECT ${fields} FROM \`${projectKey}\`.\`${typeKey}\`${where} ORDER BY \`updated_at\` DESC`
}

async function runMeegle(
  config: MeegleSyncConfig,
  args: string[],
  runner: MeegleCommandRunner,
): Promise<MeegleCommandResult> {
  return runner(config.command, [...args, '--format', 'json'], {
    ...process.env,
    ...config.env,
    MEEGLE_HOST: normalizeMeegleHost(config.host),
  })
}

async function runMeegleJson(
  config: MeegleSyncConfig,
  args: string[],
  runner: MeegleCommandRunner,
): Promise<unknown> {
  const result = await runMeegle(config, args, runner)
  if (result.exitCode !== 0) throw commandError(result, args)
  const payload = parseJsonOutput(result.stdout)
  if (payload === undefined) {
    throw new MeegleCliError(
      'Meegle CLI 未返回可解析的 JSON',
      'MEEGLE_INVALID_OUTPUT',
      { args, stderr: result.stderr },
    )
  }
  if (isRecord(payload) && payload.error) {
    throw new MeegleCliError(
      scalarText(payload.message) || 'Meegle CLI 返回错误',
      'MEEGLE_API_ERROR',
      payload,
    )
  }
  return payload
}

export async function assertMeegleAuthenticated(
  config: MeegleSyncConfig,
  runner: MeegleCommandRunner = defaultMeegleCommandRunner,
): Promise<void> {
  const result = await runMeegle(config, ['auth', 'status'], runner)
  const payload = parseJsonOutput(result.stdout) ?? parseJsonOutput(result.stderr)
  if (result.exitCode === 0 && isRecord(payload) && payload.authenticated === true) return

  const reason = isRecord(payload) ? scalarText(payload.reason) : ''
  throw new MeegleCliError(
    `Meegle 尚未登录${reason ? `（${reason}）` : ''}。请先在同步机上执行 meegle auth login --device-code，或配置 MEEGLE_USER_ACCESS_TOKEN`,
    'MEEGLE_NOT_AUTHENTICATED',
    { exitCode: result.exitCode, stderr: result.stderr },
  )
}

async function queryFirstPage(
  config: MeegleSyncConfig,
  typeKey: string,
  since: string | undefined,
  runner: MeegleCommandRunner,
): Promise<QueryPage> {
  const payload = await runMeegleJson(
    config,
    ['workitem', 'query', '--project-key', config.projectKey, '--mql', buildMql(config.projectKey, typeKey, since)],
    runner,
  )
  return parseQueryPage(payload)
}

async function queryType(
  config: MeegleSyncConfig,
  typeKey: string,
  runner: MeegleCommandRunner,
  warnings: string[],
): Promise<QueryTypeResult> {
  let first: QueryPage
  try {
    first = await queryFirstPage(config, typeKey, config.since, runner)
  } catch (error) {
    if (!config.since) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (!/updated_at|unsupported field|invalid.*(field|argument)|syntax/i.test(message)) throw error
    warnings.push(`${typeKey} 按 updated_at 增量过滤失败，已回退全量查询：${message}`)
    first = await queryFirstPage(config, typeKey, undefined, runner)
  }

  const rows = new Map<string, Record<string, unknown>>()
  for (const row of first.rows) {
    const id = workItemId(row)
    if (id) rows.set(id, row)
  }

  if (!first.count || first.count <= first.rows.length) {
    return { rows: [...rows.values()], complete: true }
  }
  if (!first.sessionId) {
    warnings.push(`${typeKey} 返回 ${first.count} 条但缺少 session_id，仅同步了首页数据`)
    return { rows: [...rows.values()], complete: false }
  }

  const pageCount = Math.ceil(first.count / DEFAULT_PAGE_SIZE)
  for (let pageNum = 2; pageNum <= Math.min(pageCount, MAX_PAGES); pageNum += 1) {
    const payload = await runMeegleJson(
      config,
      [
        'workitem',
        'query',
        '--project-key',
        config.projectKey,
        '--session-id',
        first.sessionId,
        '--group-pagination-list',
        JSON.stringify([{ group_id: first.groupId, page_num: pageNum }]),
      ],
      runner,
    )
    const page = parseQueryPage(payload)
    for (const row of page.rows) {
      const id = workItemId(row)
      if (id) rows.set(id, row)
    }
  }
  if (pageCount > MAX_PAGES) {
    warnings.push(`${typeKey} 共有 ${pageCount} 页，已按安全上限截断到 ${MAX_PAGES} 页`)
  }
  return { rows: [...rows.values()], complete: pageCount <= MAX_PAGES }
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

function textFromFields(value: unknown, keys: string[]): string {
  if (!isRecord(value)) return ''
  for (const key of keys) {
    const direct = scalarText(value[key])
    if (direct) return direct
  }
  const fields = value.fields ?? value.field_values ?? value.work_item_fields ?? value.custom_fields
  if (Array.isArray(fields)) {
    for (const field of fields) {
      if (!isRecord(field)) continue
      const key = scalarText(field.field_key ?? field.key ?? field.name)
      if (keys.includes(key)) {
        const text = scalarText(field.field_value ?? field.value ?? field.text ?? field.label)
        if (text) return text
      }
    }
  }
  return ''
}

function mergeDetails(
  rows: Record<string, unknown>[],
  details: Map<string, Record<string, unknown>>,
): Record<string, unknown>[] {
  return rows.map((row) => {
    const id = workItemId(row)
    const detail = id ? details.get(id) : undefined
    return detail ? { ...row, ...detail } : row
  })
}

async function fetchDescriptions(
  config: MeegleSyncConfig,
  typeKey: string,
  rows: Record<string, unknown>[],
  runner: MeegleCommandRunner,
  warnings: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const details = new Map<string, Record<string, unknown>>()
  if (config.fetchDescriptions === false || rows.length === 0) return details

  const ids = rows
    .filter((row) => !textFromFields(row, ['description', 'desc', 'detail', 'content']))
    .map((row) => workItemId(row))
    .filter(Boolean)

  for (let index = 0; index < ids.length; index += 200) {
    const chunk = ids.slice(index, index + 200)
    try {
      const payload = await runMeegleJson(
        config,
        [
          'workitem',
          '+batch-get',
          '--project-key',
          config.projectKey,
          '--work-item-ids',
          chunk.join(','),
          '--fields',
          JSON.stringify(['description']),
        ],
        runner,
      )
      const results = findDeep(payload, 'results')
      if (!Array.isArray(results)) continue
      for (const result of results) {
        if (!isRecord(result) || !isRecord(result.data)) continue
        const id = workItemId(result)
        if (id) details.set(id, result.data)
      }
    } catch (error) {
      warnings.push(
        `${typeKey} 详情读取失败，描述将回退为标题：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return details
}

function mapWorkItem(
  raw: Record<string, unknown>,
  type: WorkItemType,
  projectKey: string,
  typeKey: string,
  defaultOwner: string,
): SyncedFeishuWorkItem | undefined {
  const id = workItemId(raw)
  const title = workItemTitle(raw)
  if (!id || !title) return undefined

  const description = textFromFields(raw, ['description', 'desc', 'detail', 'content']) || title
  const priorityText = textFromFields(raw, ['priority', 'priority_key', 'priority_level', 'severity'])
  const owner = textFromFields(raw, [
    'current_status_operator',
    'owner',
    'assignee',
    'assignee_key',
    'user_key',
    'created_by',
  ])

  return {
    externalId: `${projectKey}:${typeKey}:${id}`,
    type,
    title,
    description,
    priority: normalizePriority(priorityText),
    owner: owner || defaultOwner,
    updatedAt: normalizeTimestamp(
      raw.updated_at ?? raw.update_time ?? raw.updatedAt ?? raw.modified_at,
    ),
  }
}

export async function fetchMeegleWorkItems(
  config: MeegleSyncConfig,
  runner: MeegleCommandRunner = defaultMeegleCommandRunner,
): Promise<MeegleFetchResult> {
  validateConfig(config)
  const warnings: string[] = []
  const items: SyncedFeishuWorkItem[] = []
  let fetched = 0
  let complete = true

  for (const [type, typeKey] of [
    ['requirement', config.requirementTypeKey],
    ['defect', config.defectTypeKey],
  ] as const) {
    const queried = await queryType(config, typeKey, runner, warnings)
    if (!queried.complete) complete = false
    const rows = queried.rows
    const details = await fetchDescriptions(config, typeKey, rows, runner, warnings)
    const merged = mergeDetails(rows, details)
    fetched += merged.length
    for (const row of merged) {
      const item = mapWorkItem(row, type, config.projectKey, typeKey, config.defaultOwner)
      if (item) items.push(item)
    }
  }

  return { items, fetched, skipped: fetched - items.length, warnings, complete }
}

export const defaultMeegleCommandRunner: MeegleCommandRunner = (command, args, env) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        env,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code
        resolve({
          stdout: String(stdout ?? ''),
          stderr: `${String(stderr ?? '')}${error && typeof code !== 'number' ? error.message : ''}`,
          exitCode: typeof code === 'number' ? code : error ? 1 : 0,
        })
      },
    )
  })
