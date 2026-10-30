import { execFile } from 'node:child_process'
import type { Priority, WorkItemStatus, WorkItemType } from '../domain/types.js'
import { nowIso } from '../domain/time.js'
import type { SyncedFeishuWorkItem } from './workItemService.js'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGES = 100
const COMMAND_TIMEOUT_MS = 60_000
const DEFAULT_RETRY_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 1_500
const MAX_RETRY_DELAY_MS = 15_000
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_REQUIREMENT_PROJECT_FIELD = 'field_c7834f'
const DEFAULT_DEFECT_PROJECT_FIELD = 'field_e1d325'

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
  requirementProjectField?: string
  defectProjectField?: string
  defaultOwner: string
  since?: string
  fetchDescriptions?: boolean
  retryAttempts?: number
  retryDelayMs?: number
  env?: NodeJS.ProcessEnv
}

export interface MeegleFetchResult {
  items: SyncedFeishuWorkItem[]
  fetched: number
  skipped: number
  warnings: string[]
  complete: boolean
}

export interface MeegleWorkItemFilter {
  search?: string
  status?: string
  owner?: string
  since?: string
}

export interface MeegleWorkItemQuery extends MeegleWorkItemFilter {
  type?: 'requirement' | 'defect' | 'all'
  limit?: number
}

export interface MeegleQueriedWorkItem extends SyncedFeishuWorkItem {
  projectKey: string
  typeKey: string
  workItemId: string
  url: string
}

export interface MeegleWorkItemQueryResult {
  items: MeegleQueriedWorkItem[]
  fetched: number
  total: number
  complete: boolean
  warnings: string[]
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

interface MeegleExecutionResult {
  result: MeegleCommandResult
  attempts: number
}

interface MeegleFailureInfo {
  code: string
  message: string
  retryable: boolean
  logId: string
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

function moqlValueText(value: unknown): string {
  if (!isRecord(value)) return scalarText(value)
  if ('string_value' in value) return scalarText(value.string_value)
  if ('long_value' in value) return scalarText(value.long_value)
  if ('double_value' in value) return scalarText(value.double_value)
  if ('bool_value' in value) return scalarText(value.bool_value)
  const keyLabels = value.key_label_value_list
  if (Array.isArray(keyLabels)) {
    return keyLabels
      .map((entry) => (isRecord(entry) ? scalarText(entry.label ?? entry.key) : scalarText(entry)))
      .filter(Boolean)
      .join(',')
  }
  const keyLabel = value.key_label_value
  if (isRecord(keyLabel)) {
    return scalarText(keyLabel.label ?? keyLabel.key)
  }
  const users = value.user_value_list
  if (Array.isArray(users)) {
    return users
      .map((entry) => {
        if (!isRecord(entry)) return scalarText(entry)
        return scalarText(entry.name_cn ?? entry.name_en ?? entry.email ?? entry.user_key)
      })
      .filter(Boolean)
      .join(',')
  }
  return scalarText(value)
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

  const moqlFields = value.moql_field_list
  if (Array.isArray(moqlFields)) {
    const normalized: Record<string, unknown> = { ...value }
    for (const field of moqlFields) {
      if (!isRecord(field)) continue
      const key = scalarText(field.key ?? field.field_key ?? field.name)
      if (!key) continue
      normalized[key] = moqlValueText(field.value ?? field.field_value)
    }
    const id = workItemId(normalized)
    const title = workItemTitle(normalized)
    if (id && title) {
      const existing = rows.get(id)
      rows.set(id, existing ? { ...existing, ...normalized } : normalized)
    }
    return
  }

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

function retryableFailureText(value: string): boolean {
  return /retriable\s*[=:]\s*true|RPCRequestTimeout|SERVER_CALL_FAILED|request timed out|timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|temporarily unavailable|too many requests/i.test(
    value,
  )
}

function meegleFailureInfo(payload: unknown, fallback = ''): MeegleFailureInfo {
  const record = isRecord(payload) ? payload : undefined
  const nested = record && isRecord(record.error) ? record.error : undefined
  const errorText = record && typeof record.error === 'string' ? record.error.trim() : ''
  const message = nested
    ? scalarText(nested.message)
    : errorText || scalarText(record?.message)
  const code = scalarText(nested?.code ?? record?.code)
  const logId = scalarText(record?.meta && isRecord(record.meta) ? record.meta.logid : record?.logid)
  return {
    code,
    message: message || (retryableFailureText(fallback) ? 'RPCRequestTimeout' : fallback),
    retryable: nested?.retriable === true || retryableFailureText(`${message}\n${fallback}`),
    logId,
  }
}

function retrySuffix(attempts: number): string {
  return attempts > 1
    ? `已自动重试 ${attempts - 1} 次，仍未恢复，请稍后再次同步`
    : '请稍后再次同步'
}

function errorHandle(attempts: number, logId: string): string {
  return logId ? `；LogID: ${logId}` : attempts > 1 ? `；尝试 ${attempts} 次` : ''
}

function commandError(
  result: MeegleCommandResult,
  args: string[],
  attempts: number,
): MeegleCliError {
  const raw = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
  const payload = parseJsonOutput(raw)
  const info = meegleFailureInfo(payload, raw)
  const detail = info.message || boundedText(raw.replace(/\s+/g, ' '), 800)
  const prefix = info.retryable ? '飞书项目服务暂时不可用' : 'Meegle CLI 执行失败'
  const code = info.code ? `（${info.code}）` : ''
  return new MeegleCliError(
    `${prefix}${code}：${detail}；${retrySuffix(attempts)}${errorHandle(attempts, info.logId)}`,
    'MEEGLE_COMMAND_FAILED',
    { args, exitCode: result.exitCode, attempts, response: payload ?? detail },
  )
}

function apiError(payload: unknown, args: string[], attempts: number): MeegleCliError {
  const raw = JSON.stringify(payload) ?? ''
  const info = meegleFailureInfo(payload, raw)
  const prefix = info.retryable ? '飞书项目服务暂时不可用' : '飞书项目接口返回错误'
  const code = info.code ? `（${info.code}）` : ''
  return new MeegleCliError(
    `${prefix}${code}：${info.message || '未知错误'}；${retrySuffix(attempts)}${errorHandle(attempts, info.logId)}`,
    'MEEGLE_API_ERROR',
    { args, attempts, response: payload },
  )
}

function validateConfig(config: MeegleSyncConfig): void {
  for (const [label, value] of [
    ['projectKey', config.projectKey],
    ['requirementTypeKey', config.requirementTypeKey],
    ['defectTypeKey', config.defectTypeKey],
    ['requirementProjectField', config.requirementProjectField],
    ['defectProjectField', config.defectProjectField],
  ] as const) {
    if (!value) continue
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
  projectField: string,
): string {
  const fields = [
    '`work_item_id`',
    '`name`',
    '`work_item_status`',
    '`priority`',
    '`current_status_operator`',
    '`description`',
    '`updated_at`',
  ]
  if (projectField) fields.push(`\`${projectField}\``)
  const conditions = ['`archiving_date` IS NULL']
  if (since) conditions.push(`\`updated_at\` >= '${since}'`)
  const where = ` WHERE ${conditions.join(' AND ')}`
  return `SELECT ${fields.join(', ')} FROM \`${projectKey}\`.\`${typeKey}\`${where} ORDER BY \`updated_at\` DESC`
}

function mqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function mqlLike(value: string): string {
  return mqlString(value).replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export function buildMeegleWorkItemMql(
  projectKey: string,
  typeKey: string,
  projectField: string,
  filter: MeegleWorkItemFilter = {},
): string {
  const fields = [
    '`work_item_id`',
    '`name`',
    '`work_item_status`',
    '`priority`',
    '`current_status_operator`',
    '`description`',
    '`updated_at`',
  ]
  if (projectField) fields.push(`\`${projectField}\``)
  const conditions = ['`archiving_date` IS NULL']
  const since = filter.since?.trim()
  if (since) {
    if (!DATE_PATTERN.test(since)) {
      throw new MeegleCliError('起始日期必须使用 YYYY-MM-DD 格式', 'MEEGLE_INVALID_CONFIG')
    }
    conditions.push(`\`updated_at\` >= '${since}'`)
  }
  const search = filter.search?.trim().slice(0, 200)
  if (search) conditions.push(`\`name\` LIKE '%${mqlLike(search)}%'`)
  const status = filter.status?.trim().slice(0, 200)
  if (status) conditions.push(`\`work_item_status\` = '${mqlString(status)}'`)
  const owner = filter.owner?.trim().slice(0, 200)
  if (owner) conditions.push(`\`current_status_operator\` = '${mqlString(owner)}'`)
  return `SELECT ${fields.join(', ')} FROM \`${projectKey}\`.\`${typeKey}\` WHERE ${conditions.join(' AND ')} ORDER BY \`updated_at\` DESC LIMIT 50`
}

function shouldRetryMeegleResult(result: MeegleCommandResult): boolean {
  if (result.exitCode === 0) {
    const payload = parseJsonOutput(result.stdout)
    return Boolean(
      payload &&
      isRecord(payload) &&
      payload.error &&
      retryableFailureText(`${JSON.stringify(payload)}\n${result.stderr}`),
    )
  }
  return retryableFailureText(`${result.stderr}\n${result.stdout}`)
}

function retryDelay(config: MeegleSyncConfig, failedAttempt: number): number {
  const base = Math.min(
    MAX_RETRY_DELAY_MS,
    Math.max(0, Math.trunc(config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)),
  )
  return Math.min(MAX_RETRY_DELAY_MS, base * 2 ** Math.max(0, failedAttempt - 1))
}

async function runMeegle(
  config: MeegleSyncConfig,
  args: string[],
  runner: MeegleCommandRunner,
): Promise<MeegleExecutionResult> {
  const maxAttempts = Math.min(
    5,
    Math.max(1, Math.trunc(config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS)),
  )
  const env = {
    ...process.env,
    ...config.env,
    MEEGLE_HOST: normalizeMeegleHost(config.host),
  }
  const commandArgs = [...args, '--format', 'json']
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runner(config.command, commandArgs, env)
    if (attempt === maxAttempts || !shouldRetryMeegleResult(result)) {
      return { result, attempts: attempt }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelay(config, attempt)))
  }
  throw new MeegleCliError('Meegle CLI 执行失败', 'MEEGLE_COMMAND_FAILED', { args })
}

async function runMeegleJson(
  config: MeegleSyncConfig,
  args: string[],
  runner: MeegleCommandRunner,
): Promise<unknown> {
  const execution = await runMeegle(config, args, runner)
  const { result } = execution
  if (result.exitCode !== 0) throw commandError(result, args, execution.attempts)
  const payload = parseJsonOutput(result.stdout)
  if (payload === undefined) {
    throw new MeegleCliError(
      'Meegle CLI 未返回可解析的 JSON',
      'MEEGLE_INVALID_OUTPUT',
      { args, stderr: result.stderr },
    )
  }
  if (isRecord(payload) && payload.error) {
    throw apiError(payload, args, execution.attempts)
  }
  return payload
}

export async function assertMeegleAuthenticated(
  config: MeegleSyncConfig,
  runner: MeegleCommandRunner = defaultMeegleCommandRunner,
): Promise<void> {
  const { result } = await runMeegle(config, ['auth', 'status'], runner)
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
  projectField: string,
  since: string | undefined,
  runner: MeegleCommandRunner,
): Promise<QueryPage> {
  const payload = await runMeegleJson(
    config,
    [
      'workitem',
      'query',
      '--project-key',
      config.projectKey,
      '--mql',
      buildMql(config.projectKey, typeKey, since, projectField),
    ],
    runner,
  )
  return parseQueryPage(payload)
}

async function queryType(
  config: MeegleSyncConfig,
  typeKey: string,
  projectField: string,
  runner: MeegleCommandRunner,
  warnings: string[],
): Promise<QueryTypeResult> {
  let first: QueryPage
  try {
    first = await queryFirstPage(config, typeKey, projectField, config.since, runner)
  } catch (error) {
    if (!config.since) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (!/updated_at|unsupported field|invalid.*(field|argument)|syntax/i.test(message)) throw error
    warnings.push(`${typeKey} 按 updated_at 增量过滤失败，已回退全量查询：${message}`)
    first = await queryFirstPage(config, typeKey, projectField, undefined, runner)
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

function normalizeWorkItemStatus(value: string): WorkItemStatus | undefined {
  const text = value.trim().toLowerCase()
  if (!text) return undefined
  if (/已关闭|关闭$|拒绝|取消|终止|不修复|不解决|closed|rejected|cancelled|canceled/.test(text)) {
    return '已关闭'
  }
  if (
    /已交付|已测试|已完成|已发布|已上线|验收通过|已解决|resolved|delivered|released|done/.test(text)
  ) {
    return '已交付'
  }
  if (/规划|需求确认|新$|待|排队|未开始|审核|需要复现|open|pending|todo|backlog/.test(text)) {
    return '待处理'
  }
  if (
    /进行中|评审|重新打开|设计|开发|测试中|转测试|接受处理|验证|复现中|修复|implement|progress|testing|review|reopen/.test(
      text,
    )
  ) {
    return '进行中'
  }
  return '待处理'
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

function boundedText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const sliced = value.slice(0, maxLength)
  const lastCode = sliced.charCodeAt(sliced.length - 1)
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? sliced.slice(0, -1) : sliced
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

function multiTextFromFields(value: unknown, keys: string[]): string {
  if (!isRecord(value)) return ''
  for (const key of keys) {
    const text = moqlValueText(value[key])
    if (text) return text
  }
  const fields = value.fields ?? value.field_values ?? value.work_item_fields ?? value.custom_fields
  if (Array.isArray(fields)) {
    for (const field of fields) {
      if (!isRecord(field)) continue
      const key = scalarText(field.field_key ?? field.key ?? field.name)
      if (!keys.includes(key)) continue
      const text = moqlValueText(field.field_value ?? field.value ?? field.text ?? field.label)
      if (text) return text
    }
  }
  return ''
}

function normalizeMultiText(value: string): string {
  return [...new Set(value.split(/[,，]/).map((entry) => entry.trim()).filter(Boolean))].join(',')
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
  projectField: string,
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
  const feishuStatus = textFromFields(raw, ['work_item_status', 'status', 'state'])
  const projectLine = normalizeMultiText(
    projectField ? multiTextFromFields(raw, [projectField]) : '',
  )

  return {
    externalId: `${projectKey}:${typeKey}:${id}`,
    type,
    title: boundedText(title, 300),
    description: boundedText(description, 20_000),
    priority: normalizePriority(priorityText),
    owner: boundedText(owner || defaultOwner, 100),
    status: normalizeWorkItemStatus(feishuStatus),
    feishuStatus: feishuStatus ? boundedText(feishuStatus, 100) : undefined,
    ...(projectLine ? { projectLine: boundedText(projectLine, 500) } : {}),
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

  for (const [type, typeKey, projectField] of [
    [
      'requirement',
      config.requirementTypeKey,
      config.requirementProjectField ?? DEFAULT_REQUIREMENT_PROJECT_FIELD,
    ],
    [
      'defect',
      config.defectTypeKey,
      config.defectProjectField ?? DEFAULT_DEFECT_PROJECT_FIELD,
    ],
  ] as const) {
    const queried = await queryType(config, typeKey, projectField, runner, warnings)
    if (!queried.complete) complete = false
    const rows = queried.rows
    const details = await fetchDescriptions(config, typeKey, rows, runner, warnings)
    const merged = mergeDetails(rows, details)
    fetched += merged.length
    for (const row of merged) {
      const item = mapWorkItem(
        row,
        type,
        config.projectKey,
        typeKey,
        projectField,
        config.defaultOwner,
      )
      if (item) items.push(item)
    }
  }

  return { items, fetched, skipped: fetched - items.length, warnings, complete }
}

interface MeegleMcpQueryPage {
  rows: Record<string, unknown>[]
  total: number
  complete: boolean
  warnings: string[]
}

async function queryMcpPages(
  config: MeegleSyncConfig,
  typeKey: string,
  projectField: string,
  filter: MeegleWorkItemFilter,
  limit: number,
  runner: MeegleCommandRunner,
): Promise<MeegleMcpQueryPage> {
  const mql = buildMeegleWorkItemMql(config.projectKey, typeKey, projectField, filter)
  const first = parseQueryPage(
    await runMeegleJson(
      config,
      ['workitem', 'query', '--project-key', config.projectKey, '--mql', mql],
      runner,
    ),
  )
  const rows = new Map<string, Record<string, unknown>>()
  for (const row of first.rows) {
    const id = workItemId(row)
    if (id) rows.set(id, row)
  }
  const warnings: string[] = []
  const pageCount = Math.min(MAX_PAGES, Math.max(1, Math.ceil(limit / DEFAULT_PAGE_SIZE)))
  const total = first.count ?? first.rows.length
  let complete = true
  if (total > first.rows.length && pageCount > 1) {
    if (!first.sessionId) {
      complete = false
      warnings.push(`${typeKey} 查询结果不完整：缺少 session_id，无法继续分页`)
    } else {
      for (let pageNum = 2; pageNum <= pageCount && rows.size < Math.min(limit, total); pageNum += 1) {
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
    }
  }
  return { rows: [...rows.values()], total, complete, warnings }
}

export async function queryMeegleWorkItems(
  config: MeegleSyncConfig,
  query: MeegleWorkItemQuery = {},
  runner: MeegleCommandRunner = defaultMeegleCommandRunner,
): Promise<MeegleWorkItemQueryResult> {
  validateConfig(config)
  const limit = Math.min(100, Math.max(1, Math.trunc(query.limit ?? DEFAULT_PAGE_SIZE)))
  const requestedType = query.type ?? 'all'
  const types = requestedType === 'all'
    ? (['requirement', 'defect'] as const)
    : ([requestedType] as const)
  const warnings: string[] = []
  let fetched = 0
  let total = 0
  let complete = true
  const items: MeegleQueriedWorkItem[] = []

  for (const type of types) {
    const typeKey = type === 'requirement' ? config.requirementTypeKey : config.defectTypeKey
    const projectField = type === 'requirement'
      ? config.requirementProjectField ?? DEFAULT_REQUIREMENT_PROJECT_FIELD
      : config.defectProjectField ?? DEFAULT_DEFECT_PROJECT_FIELD
    const page = await queryMcpPages(config, typeKey, projectField, query, limit, runner)
    fetched += page.rows.length
    total += page.total
    complete = complete && page.complete
    warnings.push(...page.warnings)
    for (const row of page.rows) {
      const item = mapWorkItem(
        row,
        type,
        config.projectKey,
        typeKey,
        projectField,
        config.defaultOwner,
      )
      const id = workItemId(row)
      if (!item || !id) continue
      items.push({
        ...item,
        projectKey: config.projectKey,
        typeKey,
        workItemId: id,
        url: `https://project.feishu.cn/${config.projectKey}/${typeKey}/detail/${id}`,
      })
    }
  }

  items.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  return { items: items.slice(0, limit), fetched, total, complete, warnings }
}

export async function getMeegleWorkItem(
  config: MeegleSyncConfig,
  workItemIdValue: string,
  runner: MeegleCommandRunner = defaultMeegleCommandRunner,
): Promise<unknown> {
  validateConfig(config)
  const id = workItemIdValue.trim()
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new MeegleCliError('工作项 ID 格式不正确', 'MEEGLE_INVALID_CONFIG')
  }
  return runMeegleJson(
    config,
    ['workitem', 'get', '--project-key', config.projectKey, '--work-item-id', id],
    runner,
  )
}

export async function searchMeegleProjects(
  config: MeegleSyncConfig,
  projectKey?: string,
  runner: MeegleCommandRunner = defaultMeegleCommandRunner,
): Promise<unknown> {
  const key = projectKey?.trim()
  return runMeegleJson(
    config,
    ['project', 'search', ...(key ? ['--project-key', key] : [])],
    runner,
  )
}

export async function getMeegleAuthStatus(
  config: MeegleSyncConfig,
  runner: MeegleCommandRunner = defaultMeegleCommandRunner,
): Promise<{ authenticated: boolean; host: string; reason?: string }> {
  const { result } = await runMeegle(config, ['auth', 'status'], runner)
  const payload = parseJsonOutput(result.stdout) ?? parseJsonOutput(result.stderr)
  const authenticated = result.exitCode === 0 && isRecord(payload) && payload.authenticated === true
  return {
    authenticated,
    host: normalizeMeegleHost(config.host),
    ...(authenticated || !isRecord(payload) || !scalarText(payload.reason)
      ? {}
      : { reason: scalarText(payload.reason) }),
  }
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
