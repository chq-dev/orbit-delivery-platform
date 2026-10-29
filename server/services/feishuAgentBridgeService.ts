import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../db/database.js'
import { notFound, unprocessable } from '../domain/errors.js'
import { nowIso } from '../domain/time.js'

const AGENT_STATE_ID = 'primary'
const RUNNING_COMMAND_LEASE_MS = 15 * 60_000
const RECENT_COMMAND_LIMIT = 20

export const FEISHU_AGENT_ONLINE_WINDOW_MS = 90_000

export type FeishuAgentCommandType = 'login_start' | 'sync' | 'rotate_token'
export type FeishuAgentCommandStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export interface FeishuAgentHealth {
  ok: true
  version: number
  config: {
    configured: boolean
    platformBaseUrl?: string
    projectKey: string
    repoId?: string
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
}

export interface FeishuAgentCommand {
  id: string
  type: FeishuAgentCommandType
  status: FeishuAgentCommandStatus
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    result: parseJson(row.result_json),
    error: row.error || undefined,
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

  return {
    ok: true,
    version: nonNegativeInteger(value.version) || 1,
    config: {
      configured: boolean(config.configured),
      platformBaseUrl: optionalText(config.platformBaseUrl, 500),
      projectKey: optionalText(config.projectKey, 200) ?? 'rjcloud',
      repoId: optionalText(config.repoId, 200),
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
  }
}

function claimPendingCommands(db: AppDatabase): FeishuAgentCommand[] {
  return db.transaction(() => {
    const now = nowIso()
    const staleBefore = new Date(Date.now() - RUNNING_COMMAND_LEASE_MS).toISOString()
    db.prepare(
      `UPDATE feishu_agent_commands
       SET status = 'pending', claimed_at = NULL, updated_at = ?
       WHERE status = 'running' AND claimed_at < ?`,
    ).run(now, staleBefore)

    const rows = db
      .prepare(
        `SELECT id, command_type, status, result_json, error, created_at, updated_at
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
  const health = sanitizeFeishuAgentHealth(
    isRecord(input) && 'health' in input ? input.health : input,
  )
  const now = nowIso()
  db.prepare(
    `INSERT INTO feishu_agent_state (id, health_json, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       health_json = excluded.health_json,
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`,
  ).run(AGENT_STATE_ID, JSON.stringify(health), now, now, now)
  return {
    lastSeenAt: now,
    commands: claimPendingCommands(db),
  }
}

export function enqueueFeishuAgentCommand(
  db: AppDatabase,
  type: unknown,
): FeishuAgentCommand {
  if (type !== 'login_start' && type !== 'sync' && type !== 'rotate_token') {
    throw unprocessable('不支持的代理命令')
  }
  const existing = db
    .prepare(
      `SELECT id, command_type, status, result_json, error, created_at, updated_at
       FROM feishu_agent_commands
       WHERE command_type = ? AND status IN ('pending', 'running')
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(type) as CommandRow | undefined
  if (existing) return publicCommand(existing)

  const now = nowIso()
  const id = `agent-command-${randomUUID()}`
  db.prepare(
    `INSERT INTO feishu_agent_commands
      (id, command_type, status, result_json, error, created_at, updated_at)
     VALUES (?, ?, 'pending', NULL, NULL, ?, ?)`,
  ).run(id, type, now, now)
  return {
    id,
    type,
    status: 'pending',
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
      `SELECT id, command_type, status, result_json, error, created_at, updated_at
       FROM feishu_agent_commands WHERE id = ?`,
    )
    .get(id) as CommandRow | undefined
  if (!existing) throw notFound('代理命令')

  const payload = isRecord(input) ? input : {}
  const error = text(payload.error, 4_000)
  const status: FeishuAgentCommandStatus = error ? 'failed' : 'succeeded'
  const now = nowIso()
  const resultJson =
    payload.result === undefined ? null : JSON.stringify(payload.result).slice(0, 64 * 1024)
  db.prepare(
    `UPDATE feishu_agent_commands
     SET status = ?, result_json = ?, error = ?, updated_at = ?, completed_at = ?
     WHERE id = ?`,
  ).run(status, resultJson, error || null, now, now, id)
  return publicCommand({
    ...existing,
    status,
    result_json: resultJson,
    error: error || null,
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
      `SELECT id, command_type, status, result_json, error, created_at, updated_at
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
