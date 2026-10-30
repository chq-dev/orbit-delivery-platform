import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../db/database.js'
import { notFound, unprocessable } from '../domain/errors.js'
import { nowIso } from '../domain/time.js'
import { parseLocalDeliveryAgentRequest } from './localDeliveryAgentService.js'

const AGENT_STATE_ID = 'primary'
const RUNNING_COMMAND_LEASE_MS = 15 * 60_000
const RECENT_COMMAND_LIMIT = 20
const MAX_RUNNING_COMMAND_IDS = 50

export const FEISHU_AGENT_ONLINE_WINDOW_MS = 90_000

export type FeishuAgentCommandType =
  | 'login_start'
  | 'sync'
  | 'rotate_token'
  | 'delivery_start'
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
  type: FeishuAgentCommandType
  status: FeishuAgentCommandStatus
  payload?: unknown
  createdAt: string
  updatedAt: string
  result?: unknown
  error?: string
}

export interface FeishuAgentBridgeStatus {
  online: boolean
  lastSeenAt?: string
  staleAfterSeconds: number
  health?: FeishuAgentHealth
  activeCommand: FeishuAgentCommand | null
  lastCommand: FeishuAgentCommand | null
  commands: FeishuAgentCommand[]
}

interface AgentStateRow {
  health_json: string
  last_seen_at: string
}

interface CommandRow {
  id: string
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
    type: row.command_type,
    status: row.status,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    result: parseJson(row.result_json),
    error: row.error || undefined,
  }
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

function renewRunningCommands(db: AppDatabase, ids: string[], now: string): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(', ')
  db.prepare(
    `UPDATE feishu_agent_commands
     SET claimed_at = ?
     WHERE status = 'running' AND id IN (${placeholders})`,
  ).run(now, ...ids)
}

function claimPendingCommands(db: AppDatabase): FeishuAgentCommand[] {
  return db.transaction(() => {
    const now = nowIso()
    const staleBefore = new Date(Date.now() - RUNNING_COMMAND_LEASE_MS).toISOString()
    db.prepare(
      `UPDATE feishu_agent_commands
       SET status = 'pending', claimed_at = NULL, updated_at = ?
       WHERE status = 'running' AND (claimed_at IS NULL OR claimed_at < ?)`,
    ).run(now, staleBefore)

    const rows = db
      .prepare(
        `SELECT id, command_type, status, payload_json, result_json, error, created_at, updated_at
         FROM feishu_agent_commands
         WHERE status = 'pending'
         ORDER BY created_at ASC, rowid ASC
         LIMIT 10`,
      )
      .all() as CommandRow[]
    const update = db.prepare(
      `UPDATE feishu_agent_commands
       SET status = 'running', claimed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    return rows
      .filter((row) => update.run(now, now, row.id).changes === 1)
      .map((row) => publicCommand({ ...row, status: 'running', updated_at: now }))
  })()
}

export function recordFeishuAgentHeartbeat(
  db: AppDatabase,
  input: unknown,
): {
  lastSeenAt: string
  commands: FeishuAgentCommand[]
} {
  const payload = isRecord(input) ? input : {}
  const health = sanitizeFeishuAgentHealth(
    'health' in payload ? payload.health : input,
  )
  const activeCommandIds = runningCommandIds(payload.runningCommandIds)
  const now = nowIso()
  db.prepare(
    `INSERT INTO feishu_agent_state (id, health_json, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       health_json = excluded.health_json,
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`,
  ).run(AGENT_STATE_ID, JSON.stringify(health), now, now, now)
  renewRunningCommands(db, activeCommandIds, now)
  return {
    lastSeenAt: now,
    commands: claimPendingCommands(db),
  }
}

export function enqueueFeishuAgentCommand(
  db: AppDatabase,
  type: unknown,
  payload?: unknown,
): FeishuAgentCommand {
  if (
    type !== 'login_start' &&
    type !== 'sync' &&
    type !== 'rotate_token' &&
    type !== 'delivery_start'
  ) {
    throw unprocessable('不支持的代理命令')
  }
  const request = type === 'delivery_start' ? parseLocalDeliveryAgentRequest(payload) : undefined
  const payloadJson = request ? JSON.stringify(request) : null
  const existing = db
    .prepare(
      `SELECT id, command_type, status, payload_json, result_json, error, created_at, updated_at
       FROM feishu_agent_commands
       WHERE command_type = ? AND status IN ('pending', 'running')
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(type) as CommandRow | undefined
  if (existing) {
    if (type === 'delivery_start' && existing.payload_json !== payloadJson) {
      throw unprocessable('本机已有其他交付正在执行，请等待完成后再启动')
    }
    return publicCommand(existing)
  }

  const now = nowIso()
  const id = `agent-command-${randomUUID()}`
  db.prepare(
    `INSERT INTO feishu_agent_commands
      (id, command_type, status, payload_json, result_json, error, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, NULL, NULL, ?, ?)`,
  ).run(id, type, payloadJson, now, now)
  return {
    id,
    type,
    status: 'pending',
    payload: request,
    createdAt: now,
    updatedAt: now,
  }
}

export function completeFeishuAgentCommand(
  db: AppDatabase,
  id: string,
  input: unknown,
): FeishuAgentCommand {
  const existing = db
    .prepare(
      `SELECT id, command_type, status, payload_json, result_json, error, created_at, updated_at
       FROM feishu_agent_commands WHERE id = ?`,
    )
    .get(id) as CommandRow | undefined
  if (!existing) throw notFound('代理命令')

  const payload = isRecord(input) ? input : {}
  const error = text(payload.error, 4_000)
  const preserveDeliveryFailure =
    existing.command_type === 'delivery_start' && existing.status === 'failed'
  const status: FeishuAgentCommandStatus =
    error || preserveDeliveryFailure ? 'failed' : 'succeeded'
  const finalError = error || (preserveDeliveryFailure ? existing.error || '' : '')
  const now = nowIso()
  const resultJson =
    payload.result === undefined ? null : JSON.stringify(payload.result).slice(0, 64 * 1024)
  db.prepare(
    `UPDATE feishu_agent_commands
     SET status = ?, result_json = ?, error = ?, updated_at = ?, completed_at = ?
     WHERE id = ?`,
  ).run(status, resultJson, finalError || null, now, now, id)
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
): FeishuAgentCommand {
  const existing = db
    .prepare(
      `SELECT id, command_type, status, payload_json, result_json, error, created_at, updated_at
       FROM feishu_agent_commands WHERE id = ?`,
    )
    .get(id) as CommandRow | undefined
  if (!existing) throw notFound('代理命令')
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

export function getFeishuAgentBridgeStatus(db: AppDatabase): FeishuAgentBridgeStatus {
  const state = db
    .prepare(
      `SELECT health_json, last_seen_at
       FROM feishu_agent_state WHERE id = ?`,
    )
    .get(AGENT_STATE_ID) as AgentStateRow | undefined
  const rows = db
    .prepare(
      `SELECT id, command_type, status, payload_json, result_json, error, created_at, updated_at
       FROM feishu_agent_commands
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(RECENT_COMMAND_LIMIT) as CommandRow[]
  const commands = rows.map(publicCommand)
  const lastSeen = state ? Date.parse(state.last_seen_at) : Number.NaN
  const online = Number.isFinite(lastSeen) && Date.now() - lastSeen <= FEISHU_AGENT_ONLINE_WINDOW_MS

  return {
    online,
    lastSeenAt: state?.last_seen_at,
    staleAfterSeconds: Math.floor(FEISHU_AGENT_ONLINE_WINDOW_MS / 1_000),
    health: state ? (parseJson(state.health_json) as FeishuAgentHealth) : undefined,
    activeCommand:
      commands.find(
        (command) => command.status === 'pending' || command.status === 'running',
      ) ?? null,
    lastCommand: commands[0] ?? null,
    commands,
  }
}
