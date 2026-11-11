import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AppDatabase } from '../db/database.js'
import { config } from '../config.js'
import { AppError, conflict } from '../domain/errors.js'
import { nowIso } from '../domain/time.js'

const CREDENTIAL_ID = 'feishu-ingest'

export interface FeishuSyncTokenStatus {
  configured: boolean
  source: 'env' | 'database' | 'none'
  hint?: string
  updatedAt?: string
}

interface CredentialRow {
  token_hash: string
  token_hint: string
  updated_at: string
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function createToken(): string {
  return randomBytes(32).toString('hex')
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function getCredentialRow(db: AppDatabase): CredentialRow | undefined {
  return db
    .prepare(
      'SELECT token_hash, token_hint, updated_at FROM feishu_sync_credentials WHERE id = ?',
    )
    .get(CREDENTIAL_ID) as CredentialRow | undefined
}

interface AgentCredentialRow {
  client_id: string
  owner_user_id: string
  token_hash: string
  token_hint: string
  created_at: string
  updated_at: string
}

function agentCredentialForToken(
  db: AppDatabase,
  token: string,
): AgentCredentialRow | undefined {
  if (!token) return undefined
  const rows = db
    .prepare(
      'SELECT client_id, owner_user_id, token_hash, token_hint, created_at, updated_at FROM feishu_agent_credentials',
    )
    .all() as AgentCredentialRow[]
  return rows.find((row) => safeHashEqual(row.token_hash, tokenHash(token)))
}

export function issueFeishuAgentCredential(
  db: AppDatabase,
  clientId: string,
  ownerUserId = '',
): string {
  const token = createToken()
  const now = nowIso()
  db.prepare(
    `INSERT INTO feishu_agent_credentials
      (client_id, owner_user_id, token_hash, token_hint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET
       owner_user_id = CASE
         WHEN excluded.owner_user_id <> '' THEN excluded.owner_user_id
         ELSE feishu_agent_credentials.owner_user_id
       END,
       token_hash = excluded.token_hash,
       token_hint = excluded.token_hint,
       updated_at = excluded.updated_at`,
  ).run(clientId, ownerUserId, tokenHash(token), `••••${token.slice(-4)}`, now, now)
  return token
}

export function getFeishuSyncTokenStatus(db: AppDatabase): FeishuSyncTokenStatus {
  if (config.feishuIngestToken) {
    return {
      configured: true,
      source: 'env',
      hint: `••••${config.feishuIngestToken.slice(-4)}`,
    }
  }
  const row = getCredentialRow(db)
  if (!row) return { configured: false, source: 'none' }
  return {
    configured: true,
    source: 'database',
    hint: row.token_hint,
    updatedAt: row.updated_at,
  }
}

export function bootstrapFeishuSyncToken(db: AppDatabase): {
  token: string
  status: FeishuSyncTokenStatus
} {
  if (getFeishuSyncTokenStatus(db).configured) {
    throw conflict('飞书同步密钥已配置；如需更换，请由服务器管理员重置')
  }
  const token = createToken()
  const now = nowIso()
  db.prepare(
    `INSERT INTO feishu_sync_credentials
      (id, token_hash, token_hint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(CREDENTIAL_ID, tokenHash(token), `••••${token.slice(-4)}`, now, now)
  return { token, status: getFeishuSyncTokenStatus(db) }
}

export function rotateFeishuSyncToken(
  db: AppDatabase,
  currentToken: string,
): {
  token: string
  status: FeishuSyncTokenStatus
} {
  const agentCredential = agentCredentialForToken(db, currentToken)
  if (agentCredential) {
    const token = createToken()
    const now = nowIso()
    db.prepare(
      `UPDATE feishu_agent_credentials
       SET token_hash = ?, token_hint = ?, updated_at = ?
       WHERE client_id = ?`,
    ).run(tokenHash(token), `••••${token.slice(-4)}`, now, agentCredential.client_id)
    return { token, status: getFeishuSyncTokenStatus(db) }
  }

  if (config.feishuIngestToken) {
    throw conflict('飞书同步密钥由 FEISHU_INGEST_TOKEN 管理，不能在页面轮换')
  }
  const row = getCredentialRow(db)
  if (!row) {
    throw conflict('飞书同步密钥尚未初始化，请先生成密钥')
  }
  if (!verifyFeishuSyncToken(db, currentToken)) {
    throw new AppError(401, 'FEISHU_INGEST_UNAUTHORIZED', '当前飞书同步密钥无效，无法轮换')
  }

  const token = createToken()
  const now = nowIso()
  db.prepare(
    `UPDATE feishu_sync_credentials
     SET token_hash = ?, token_hint = ?, updated_at = ?
     WHERE id = ?`,
  ).run(tokenHash(token), `••••${token.slice(-4)}`, now, CREDENTIAL_ID)
  return { token, status: getFeishuSyncTokenStatus(db) }
}

export function verifyFeishuSyncToken(db: AppDatabase, token: string): boolean {
  if (!token) return false
  if (config.feishuIngestToken) {
    const expected = Buffer.from(config.feishuIngestToken)
    const actual = Buffer.from(token)
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return true
  }
  const row = getCredentialRow(db)
  if (row && safeHashEqual(row.token_hash, tokenHash(token))) return true
  return Boolean(agentCredentialForToken(db, token))
}
