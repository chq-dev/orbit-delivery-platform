import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../db/database.js'
import { errorMessage, notFound, unprocessable } from '../domain/errors.js'
import { nowIso } from '../domain/time.js'
import type { CredentialVault } from '../security/vault.js'
import {
  buildAgentCommandPayload,
  parseBuildAgentCommandRequest,
} from './buildService.js'
import { parseLocalDeliveryAgentRequest } from './localDeliveryAgentService.js'

export const DEFAULT_FEISHU_AGENT_CLIENT_ID = 'primary'
const RUNNING_COMMAND_LEASE_MS = 15 * 60_000
const RECENT_COMMAND_LIMIT = 20
const MAX_RUNNING_COMMAND_IDS = 50

export const FEISHU_AGENT_ONLINE_WINDOW_MS = 90_000

export type FeishuAgentCommandType =
  | 'login_start'
  | 'sync'
  | 'rotate_token'
  | 'delivery_start'
  | 'build_job_read'
  | 'build_trigger'
export type FeishuAgentCommandStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export interface FeishuAgentDeliveryStep {
  key: string
  name: string
  description: string
  status: 'pending' | 'running' | 'success' | 'failed'
  log?: string
  startedAt?: string
  finishedAt?: string
}

export interface FeishuAgentDeliveryJob {
  id: string
  commandId?: string
  status: 'running' | 'succeeded' | 'failed'
  stage: string
  workItemId: string
  repoId: string
  localPath?: string
  branch?: string
  steps: FeishuAgentDeliveryStep[]
  startedAt: string
  finishedAt?: string
  result?: unknown
  error?: string
}

export interface FeishuAgentHealth {
  ok: true
  version: number
  config: {
    configured: boolean
    platformBaseUrl?: string
    projectKey: string
    repoId?: string
    repoPaths: Record<string, string>
  }
  meegle: {
    available: boolean
    authenticated: boolean
    reason?: string
    host?: string
  }
  running: boolean
  lastRun: {
    at: string
    status: 'success' | 'failed'
    summary?: unknown
    error?: string
  } | null
  pendingLogin: {
    userCode: string
    verificationUriComplete: string
    expiresAt: number
  } | null
  feishuMcp?: {
    enabled: boolean
    configured: boolean
    available: boolean
    authenticated: boolean
    command?: string
    reason?: string
  }
  meegleMcp?: {
    enabled: boolean
    configured: boolean
    available: boolean
    command?: string
    reason?: string
  }
  codex?: {
    available: boolean
    path?: string
  }
  delivery?: FeishuAgentDeliveryJob | null
}

export interface FeishuAgentCommand {
  id: string
  clientId: string
  type: FeishuAgentCommandType
  status: FeishuAgentCommandStatus
  payload?: unknown
  createdAt: string
  updatedAt: string
  result?: unknown
  error?: string
}

export interface FeishuAgentBridgeStatus {
  clientId?: string
  clientName?: string
  machineName?: string
  online: boolean
  lastSeenAt?: string
  staleAfterSeconds: number
  health?: FeishuAgentHealth
  activeCommand: FeishuAgentCommand | null
  lastCommand: FeishuAgentCommand | null
  commands: FeishuAgentCommand[]
  clients: FeishuAgentClientStatus[]
}

export interface FeishuAgentClientStatus {
  clientId: string
  clientName: string
  machineName?: string
  online: boolean
  lastSeenAt?: string
  health?: FeishuAgentHealth
  activeCommand: FeishuAgentCommand | null
  lastCommand: FeishuAgentCommand | null
  commands: FeishuAgentCommand[]
}

interface AgentStateRow {
  id: string
  client_name: string
  machine_name: string
  health_json: string
  last_seen_at: string
}

interface CommandRow {
  id: string
  client_id: string
  command_type: FeishuAgentCommandType
  status: FeishuAgentCommandStatus
  payload_json: string | null
  result_json: string | null
  error: string | null
  created_at: string
  updated_at: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, maxLength = 4_000): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function optionalText(value: unknown, maxLength = 4_000): string | undefined {
  return text(value, maxLength) || undefined
}

function agentClientId(value: unknown): string | undefined {
  const candidate = text(value, 128)
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(candidate) ? candidate : undefined
}

function agentClientName(value: unknown, clientId: string): string {
  return text(value, 120) || (clientId === DEFAULT_FEISHU_AGENT_CLIENT_ID ? '默认客户端' : clientId)
}

function boolean(value: unknown): boolean {
  return value === true
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
}

function repoPathOverrides(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const paths: Record<string, string> = {}
  for (const [key, rawPath] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(key)) continue
    const localPath = optionalText(rawPath, 1_000)
    if (localPath) paths[key] = localPath
  }
  return paths
}

function runningCommandIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  for (const item of value) {
    const id = text(item, 128)
    if (!id) continue
    ids.add(id)
    if (ids.size >= MAX_RUNNING_COMMAND_IDS) break
  }
  return [...ids]
}

function timestamp(value: unknown, fallback: string): string {
  const candidate = text(value, 80)
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : fallback
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function publicCommand(row: CommandRow): FeishuAgentCommand {
  return {
    id: row.id,
    clientId: row.client_id,
    type: row.command_type,
    status: row.status,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    result: parseJson(row.result_json),
    error: row.error || undefined,
  }
}

function deliveryResultStatus(value: unknown): FeishuAgentCommandStatus | undefined {
  if (!isRecord(value) || !isRecord(value.job)) return undefined
  return value.job.status === 'running' ||
    value.job.status === 'succeeded' ||
    value.job.status === 'failed'
    ? value.job.status
    : undefined
}

function deliveryStatus(value: unknown): FeishuAgentDeliveryStep['status'] {
  return value === 'running' || value === 'success' || value === 'failed' ? value : 'pending'
}

function sanitizeDeliveryJob(value: unknown): FeishuAgentDeliveryJob | undefined {
  if (!isRecord(value) || !optionalText(value.id, 200)) return undefined
  const status = value.status === 'succeeded' || value.status === 'failed' ? value.status : 'running'
  const steps = Array.isArray(value.steps)
    ? value.steps.slice(0, 12).filter(isRecord).map((step) => ({
        key: text(step.key, 100),
        name: text(step.name, 200),
        description: text(step.description, 500),
        status: deliveryStatus(step.status),
        log: optionalText(step.log, 4_000),
        startedAt: optionalText(step.startedAt, 80),
        finishedAt: optionalText(step.finishedAt, 80),
      })).filter((step) => step.key && step.name)
    : []
  return {
    id: optionalText(value.id, 200) ?? '',
    commandId: optionalText(value.commandId, 200),
    status,
    stage: optionalText(value.stage, 500) ?? '等待本机执行',
    workItemId: optionalText(value.workItemId, 200) ?? '',
    repoId: optionalText(value.repoId, 200) ?? '',
    localPath: optionalText(value.localPath, 1_000),
    branch: optionalText(value.branch, 200),
    steps,
    startedAt: timestamp(value.startedAt, nowIso()),
    finishedAt: optionalText(value.finishedAt, 80),
    result: isRecord(value.result) ? value.result : undefined,
    error: optionalText(value.error),
  }
}

function lastRun(value: unknown): FeishuAgentHealth['lastRun'] {
  if (!isRecord(value)) return null
  const status = value.status === 'failed' ? 'failed' : 'success'
  return {
    at: timestamp(value.at, nowIso()),
    status,
    summary: value.summary,
    error: optionalText(value.error),
  }
}

export function sanitizeFeishuAgentHealth(value: unknown): FeishuAgentHealth {
  if (!isRecord(value)) throw unprocessable('代理心跳必须包含 health 对象')
  const config = isRecord(value.config) ? value.config : {}
  const meegle = isRecord(value.meegle) ? value.meegle : {}
  const pendingLogin = isRecord(value.pendingLogin) ? value.pendingLogin : null
  const codex = isRecord(value.codex) ? value.codex : {}
  const feishuMcp = isRecord(value.feishuMcp) ? value.feishuMcp : {}
  const meegleMcp = isRecord(value.meegleMcp) ? value.meegleMcp : {}

  return {
    ok: true,
    version: nonNegativeInteger(value.version) || 1,
    config: {
      configured: boolean(config.configured),
      platformBaseUrl: optionalText(config.platformBaseUrl, 500),
      projectKey: optionalText(config.projectKey, 200) ?? 'rjcloud',
      repoId: optionalText(config.repoId, 200),
      repoPaths: repoPathOverrides(config.repoPaths),
    },
    meegle: {
      available: boolean(meegle.available),
      authenticated: boolean(meegle.authenticated),
      reason: optionalText(meegle.reason),
      host: optionalText(meegle.host, 500),
    },
    running: boolean(value.running),
    lastRun: lastRun(value.lastRun),
    pendingLogin:
      pendingLogin &&
      optionalText(pendingLogin.userCode, 100) &&
      optionalText(pendingLogin.verificationUriComplete, 1_000)
        ? {
            userCode: optionalText(pendingLogin.userCode, 100) ?? '',
            verificationUriComplete:
              optionalText(pendingLogin.verificationUriComplete, 1_000) ?? '',
            expiresAt: nonNegativeInteger(pendingLogin.expiresAt),
          }
        : null,
    feishuMcp: {
      enabled: boolean(feishuMcp.enabled),
      configured: boolean(feishuMcp.configured),
      available: boolean(feishuMcp.available),
      authenticated: boolean(feishuMcp.authenticated),
      command: optionalText(feishuMcp.command, 1_000),
      reason: optionalText(feishuMcp.reason),
    },
    meegleMcp: {
      enabled: boolean(meegleMcp.enabled),
      configured: boolean(meegleMcp.configured),
      available: boolean(meegleMcp.available),
      command: optionalText(meegleMcp.command, 1_000),
      reason: optionalText(meegleMcp.reason),
    },
    codex: {
      available: boolean(codex.available),
      path: optionalText(codex.path, 1_000),
    },
    delivery: value.delivery === null ? null : sanitizeDeliveryJob(value.delivery),
  }
}

function renewRunningCommands(
  db: AppDatabase,
  clientId: string,
  ids: string[],
  now: string,
): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(', ')
  db.prepare(
    `UPDATE feishu_agent_commands
     SET claimed_at = ?
     WHERE client_id = ? AND status = 'running' AND id IN (${placeholders})`,
  ).run(now, clientId, ...ids)
}

function claimPendingCommands(
  db: AppDatabase,
  clientId: string,
  vault?: CredentialVault,
): FeishuAgentCommand[] {
  return db.transaction(() => {
    const now = nowIso()
    const staleBefore = new Date(Date.now() - RUNNING_COMMAND_LEASE_MS).toISOString()
    db.prepare(
      `UPDATE feishu_agent_commands
       SET status = 'pending', claimed_at = NULL, updated_at = ?
       WHERE client_id = ? AND status = 'running' AND (claimed_at IS NULL OR claimed_at < ?)`,
    ).run(now, clientId, staleBefore)

    const rows = db
      .prepare(
        `SELECT id, client_id, command_type, status, payload_json, result_json, error, created_at, updated_at
         FROM feishu_agent_commands
         WHERE client_id = ? AND status = 'pending'
         ORDER BY created_at ASC, rowid ASC
         LIMIT 10`,
      )
      .all(clientId) as CommandRow[]
    const update = db.prepare(
      `UPDATE feishu_agent_commands
       SET status = 'running', claimed_at = ?, updated_at = ?
       WHERE id = ? AND client_id = ? AND status = 'pending'`,
    )
    const commands: FeishuAgentCommand[] = []
    for (const row of rows) {
      if (update.run(now, now, row.id, clientId).changes !== 1) continue
      const command = publicCommand({ ...row, status: 'running', updated_at: now })
      if (command.type === 'build_job_read' || command.type === 'build_trigger') {
        try {
          if (!vault) throw new Error('缺少编译凭据解密上下文')
          const request = parseBuildAgentCommandRequest(command.payload)
          command.payload = buildAgentCommandPayload(db, vault, request)
        } catch (error) {
          db.prepare(
            `UPDATE feishu_agent_commands
             SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
             WHERE id = ?`,
          ).run(errorMessage(error).slice(0, 4_000), now, now, row.id)
          continue
        }
      }
      commands.push(command)
    }
    return commands
  })()
}

export function recordFeishuAgentHeartbeat(
  db: AppDatabase,
  input: unknown,
  vault?: CredentialVault,
): {
  clientId: string
  clientName: string
  machineName?: string
  lastSeenAt: string
  commands: FeishuAgentCommand[]
} {
  const payload = isRecord(input) ? input : {}
  const requestedClientId = text(payload.clientId, 128)
  const clientId = agentClientId(requestedClientId) ?? DEFAULT_FEISHU_AGENT_CLIENT_ID
  if (requestedClientId && !agentClientId(requestedClientId)) {
    throw unprocessable('客户端标识格式不正确')
  }
  const clientName = agentClientName(payload.clientName, clientId)
  const machineName = text(payload.machineName, 120)
  const existingState = db
    .prepare(
      'SELECT id, client_name, machine_name, health_json, last_seen_at FROM feishu_agent_state WHERE id = ?',
    )
    .get(clientId) as AgentStateRow | undefined
  if (
    existingState?.machine_name &&
    machineName &&
    existingState.machine_name !== machineName
  ) {
    throw unprocessable(
      `执行客户端标识 ${clientId} 已被机器 ${existingState.machine_name} 使用；请在当前机器设置唯一的 FEISHU_AGENT_CLIENT_ID 后重启代理`,
    )
  }
  const storedMachineName = machineName || existingState?.machine_name || ''
  const health = sanitizeFeishuAgentHealth(
    'health' in payload ? payload.health : input,
  )
  const activeCommandIds = runningCommandIds(payload.runningCommandIds)
  const now = nowIso()
  db.prepare(
    `INSERT INTO feishu_agent_state (id, client_name, machine_name, health_json, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       client_name = excluded.client_name,
       machine_name = excluded.machine_name,
       health_json = excluded.health_json,
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`,
  ).run(clientId, clientName, storedMachineName, JSON.stringify(health), now, now, now)
  renewRunningCommands(db, clientId, activeCommandIds, now)
  return {
    clientId,
    clientName,
    machineName: storedMachineName || undefined,
    lastSeenAt: now,
    commands: claimPendingCommands(db, clientId, vault),
  }
}

function onlineAt(lastSeenAt: string, now = Date.now()): boolean {
  const lastSeen = Date.parse(lastSeenAt)
  return Number.isFinite(lastSeen) && now - lastSeen <= FEISHU_AGENT_ONLINE_WINDOW_MS
}

export function resolveCommandClientId(db: AppDatabase, requestedClientId: unknown): string {
  const requested = agentClientId(requestedClientId)
  if (text(requestedClientId, 128) && !requested) {
    throw unprocessable('执行客户端标识格式不正确')
  }
  if (!requested) {
    throw unprocessable('请先选择要执行任务的客户端，平台不会再自动猜测执行机器')
  }
  const state = db
    .prepare(
      'SELECT id, client_name, machine_name, health_json, last_seen_at FROM feishu_agent_state WHERE id = ?',
    )
    .get(requested) as AgentStateRow | undefined
  if (!state) {
    throw unprocessable('执行客户端不存在或尚未上报心跳，请确认客户端代理已启动')
  }
  if (!onlineAt(state.last_seen_at)) {
    throw unprocessable(
      `执行客户端 ${state.client_name || state.id} 已离线，请恢复该客户端代理后重试`,
    )
  }
  return requested
}

export function enqueueFeishuAgentCommand(
  db: AppDatabase,
  type: unknown,
  payload?: unknown,
  requestedClientId?: unknown,
): FeishuAgentCommand {
  const supportedTypes: FeishuAgentCommandType[] = [
    'login_start',
    'sync',
    'rotate_token',
    'delivery_start',
    'build_job_read',
    'build_trigger',
  ]
  if (!supportedTypes.includes(type as FeishuAgentCommandType)) {
    throw unprocessable('不支持的代理命令')
  }
  const commandType = type as FeishuAgentCommandType
  const isBuildCommand = commandType === 'build_job_read' || commandType === 'build_trigger'
  const clientId = resolveCommandClientId(db, requestedClientId)
  const deliveryRequest =
    commandType === 'delivery_start' ? parseLocalDeliveryAgentRequest(payload) : undefined
  const buildRequest = isBuildCommand ? parseBuildAgentCommandRequest(payload) : undefined
  const commandPayload = deliveryRequest ?? buildRequest
  const payloadJson = commandPayload ? JSON.stringify(commandPayload) : null
  if (!isBuildCommand) {
    const existing = db
      .prepare(
        `SELECT id, client_id, command_type, status, payload_json, result_json, error, created_at, updated_at
         FROM feishu_agent_commands
         WHERE client_id = ? AND command_type = ? AND status IN ('pending', 'running')
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(clientId, commandType) as CommandRow | undefined
    if (existing) {
      if (commandType === 'delivery_start' && existing.payload_json !== payloadJson) {
        throw unprocessable('该执行客户端已有其他交付正在执行，请等待完成后再启动')
      }
      return publicCommand(existing)
    }
  }

  const now = nowIso()
  const id = `agent-command-${randomUUID()}`
  db.prepare(
    `INSERT INTO feishu_agent_commands
      (id, client_id, command_type, status, payload_json, result_json, error, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)`,
  ).run(id, clientId, commandType, payloadJson, now, now)
  return {
    id,
    clientId,
    type: commandType,
    status: 'pending',
    payload: commandPayload,
    createdAt: now,
    updatedAt: now,
  }
}

export function getFeishuAgentCommand(db: AppDatabase, id: string): FeishuAgentCommand {
  const row = db
    .prepare(
      `SELECT id, client_id, command_type, status, payload_json, result_json, error, created_at, updated_at
       FROM feishu_agent_commands WHERE id = ?`,
    )
    .get(id) as CommandRow | undefined
  if (!row) throw notFound('代理命令')
  return publicCommand(row)
}

export function completeFeishuAgentCommand(
  db: AppDatabase,
  id: string,
  input: unknown,
  requestedClientId?: unknown,
): FeishuAgentCommand {
  const existing = db
    .prepare(
      `SELECT id, client_id, command_type, status, payload_json, result_json, error, created_at, updated_at
       FROM feishu_agent_commands WHERE id = ?`,
    )
    .get(id) as CommandRow | undefined
  if (!existing) throw notFound('代理命令')
  assertCommandClient(existing, requestedClientId)

  const payload = isRecord(input) ? input : {}
  const error = text(payload.error, 4_000)
  const preserveDeliveryFailure =
    existing.command_type === 'delivery_start' && existing.status === 'failed'
  const deliveryStatus =
    existing.command_type === 'delivery_start'
      ? deliveryResultStatus(payload.result)
      : undefined
  const deliveryError =
    existing.command_type === 'delivery_start' &&
    isRecord(payload.result) &&
    isRecord(payload.result.job)
      ? optionalText(payload.result.job.error)
      : undefined
  const status: FeishuAgentCommandStatus =
    error || preserveDeliveryFailure || deliveryStatus === 'failed'
      ? 'failed'
      : deliveryStatus === 'running'
        ? 'running'
        : 'succeeded'
  const finalError =
    error || deliveryError || (preserveDeliveryFailure ? existing.error || '' : '')
  const now = nowIso()
  const resultJson =
    payload.result === undefined ? null : JSON.stringify(payload.result).slice(0, 64 * 1024)
  db.prepare(
    `UPDATE feishu_agent_commands
     SET status = ?, result_json = ?, error = ?, updated_at = ?, completed_at = ?
     WHERE id = ?`,
  ).run(status, resultJson, finalError || null, now, status === 'running' ? null : now, id)
  return publicCommand({
    ...existing,
    status,
    result_json: resultJson,
    error: finalError || null,
    updated_at: now,
  })
}

export function updateFeishuAgentCommandProgress(
  db: AppDatabase,
  id: string,
  input: unknown,
  requestedClientId?: unknown,
): FeishuAgentCommand {
  const existing = db
    .prepare(
      `SELECT id, client_id, command_type, status, payload_json, result_json, error, created_at, updated_at
       FROM feishu_agent_commands WHERE id = ?`,
    )
    .get(id) as CommandRow | undefined
  if (!existing) throw notFound('代理命令')
  assertCommandClient(existing, requestedClientId)
  if (existing.command_type !== 'delivery_start') {
    throw unprocessable('该代理命令不支持交付进度')
  }
  const payload = isRecord(input) ? input : {}
  const job = sanitizeDeliveryJob(payload.job)
  if (!job) throw unprocessable('交付进度缺少有效任务')

  const now = nowIso()
  const status: FeishuAgentCommandStatus =
    job.status === 'failed'
      ? 'failed'
      : job.status === 'succeeded'
        ? 'succeeded'
        : existing.status
  const error = job.status === 'failed' ? job.error || '本机交付执行失败' : existing.error
  const resultJson = JSON.stringify({ job }).slice(0, 64 * 1024)
  db.prepare(
    `UPDATE feishu_agent_commands
     SET status = ?, result_json = ?, error = ?, updated_at = ?, completed_at = ?
     WHERE id = ?`,
  ).run(status, resultJson, error, now, job.status === 'running' ? null : now, id)
  return publicCommand({
    ...existing,
    status,
    result_json: resultJson,
    error,
    updated_at: now,
  })
}

function assertCommandClient(existing: CommandRow, requestedClientId: unknown): void {
  const requested = agentClientId(requestedClientId)
  if (existing.client_id !== DEFAULT_FEISHU_AGENT_CLIENT_ID && !requested) {
    throw unprocessable('多客户端代理命令必须携带执行客户端标识')
  }
  if (requested && requested !== existing.client_id) {
    throw unprocessable('该代理命令不属于当前执行客户端')
  }
}

function clientStatus(
  db: AppDatabase,
  state: AgentStateRow,
  now: number,
): FeishuAgentClientStatus {
  const rows = db
    .prepare(
      `SELECT id, client_id, command_type, status, payload_json, result_json, error, created_at, updated_at
       FROM feishu_agent_commands
       WHERE client_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(state.id, RECENT_COMMAND_LIMIT) as CommandRow[]
  const commands = rows.map(publicCommand)
  return {
    clientId: state.id,
    clientName: state.client_name || agentClientName(undefined, state.id),
    machineName: state.machine_name || undefined,
    online: onlineAt(state.last_seen_at, now),
    lastSeenAt: state.last_seen_at,
    health: parseJson(state.health_json) as FeishuAgentHealth | undefined,
    activeCommand:
      commands.find(
        (command) => command.status === 'pending' || command.status === 'running',
      ) ?? null,
    lastCommand: commands[0] ?? null,
    commands,
  }
}

export function getFeishuAgentBridgeStatus(
  db: AppDatabase,
  requestedClientId?: unknown,
): FeishuAgentBridgeStatus {
  const states = db
    .prepare(
      `SELECT id, client_name, machine_name, health_json, last_seen_at
       FROM feishu_agent_state
       ORDER BY last_seen_at DESC`,
    )
    .all() as AgentStateRow[]
  const now = Date.now()
  const clients = states
    .map((state) => clientStatus(db, state, now))
    .sort((left, right) => {
      if (left.online !== right.online) return left.online ? -1 : 1
      return Date.parse(right.lastSeenAt ?? '') - Date.parse(left.lastSeenAt ?? '')
    })
  const requested = agentClientId(requestedClientId)
  const selected = requested
    ? clients.find((client) => client.clientId === requested)
    : clients.find((client) => client.online) ?? clients[0]

  if (!selected) {
    return {
      clientId: requested,
      online: false,
      staleAfterSeconds: Math.floor(FEISHU_AGENT_ONLINE_WINDOW_MS / 1_000),
      activeCommand: null,
      lastCommand: null,
      commands: [],
      clients,
    }
  }

  return {
    clientId: selected.clientId,
    clientName: selected.clientName,
    machineName: selected.machineName,
    online: selected.online,
    lastSeenAt: selected.lastSeenAt,
    staleAfterSeconds: Math.floor(FEISHU_AGENT_ONLINE_WINDOW_MS / 1_000),
    health: selected.health,
    activeCommand: selected.activeCommand,
    lastCommand: selected.lastCommand,
    commands: selected.commands,
    clients,
  }
}
