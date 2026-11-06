import {
  createCipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  timingSafeEqual,
  constants,
} from 'node:crypto'
import type { AppDatabase } from '../db/database.js'
import { conflict, notFound, unprocessable } from '../domain/errors.js'
import { nowIso } from '../domain/time.js'
import { parseFeishuAgentRepoPaths } from './feishuAgentConfig.js'
import { issueFeishuAgentCredential } from './feishuSyncTokenService.js'

const PAIRING_TTL_MS = 15 * 60_000
const MAX_PENDING_PAIRINGS = 50
const MAX_PENDING_PER_IP = 20

interface PairingRow {
  client_id: string
  pairing_secret_hash: string
  client_name: string
  machine_name: string
  platform_base_url: string
  project_key: string
  public_key: string
  source_ip: string
  status: 'pending' | 'approved'
  config_ciphertext: string | null
  created_at: string
  updated_at: string
  expires_at: string
}

export interface FeishuAgentPairingRequest {
  clientId: string
  clientName: string
  machineName: string
  platformBaseUrl: string
  projectKey: string
  publicKey: string
  pairingSecret: string
}

export interface FeishuAgentPairingSummary {
  clientId: string
  clientName: string
  machineName: string
  platformBaseUrl: string
  projectKey: string
  status: 'pending' | 'approved'
  verificationCode: string
  createdAt: string
  updatedAt: string
  expiresAt: string
}

function text(value: unknown, maxLength = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function validClientId(value: unknown): string | undefined {
  const candidate = text(value, 128)
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(candidate)
    ? candidate
    : undefined
}

function validBaseUrl(value: unknown): string | undefined {
  const candidate = text(value, 2_000).replace(/\/$/, '')
  try {
    const parsed = new URL(candidate)
    const loopback =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]' ||
      parsed.hostname === '::1'
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      return undefined
    }
    if (parsed.username || parsed.password) return undefined
    return candidate
  } catch {
    return undefined
  }
}

function secretHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function matchesSecret(hash: string, value: string): boolean {
  const expected = Buffer.from(hash)
  const actual = Buffer.from(secretHash(value))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function parsedPublicKey(value: unknown): string | undefined {
  const pem = text(value, 12_000)
  if (!pem) return undefined
  try {
    const key = createPublicKey(pem)
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      return undefined
    }
    return key.export({ type: 'spki', format: 'pem' }).toString()
  } catch {
    return undefined
  }
}

function publicPairing(row: PairingRow): FeishuAgentPairingSummary {
  const publicKey = createPublicKey(row.public_key)
  const fingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 12)
    .toUpperCase()
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    machineName: row.machine_name,
    platformBaseUrl: row.platform_base_url,
    projectKey: row.project_key,
    status: row.status,
    verificationCode: `${fingerprint.slice(0, 4)}-${fingerprint.slice(4, 8)}-${fingerprint.slice(8)}`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  }
}

export function requestFeishuAgentPairing(
  db: AppDatabase,
  input: unknown,
  sourceIp: string,
): { status: 'pending' | 'approved'; clientId: string; configCiphertext?: string } {
  const value = typeof input === 'object' && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
  const clientId = validClientId(value.clientId)
  const pairingSecret = text(value.pairingSecret, 256)
  const clientName = text(value.clientName, 120)
  const machineName = text(value.machineName, 120)
  const platformBaseUrl = validBaseUrl(value.platformBaseUrl)
  const projectKey = text(value.projectKey, 100) || 'rjcloud'
  const publicKey = parsedPublicKey(value.publicKey)
  if (!clientId || !clientName || !machineName || !platformBaseUrl || !publicKey) {
    throw unprocessable('本机客户端登记信息不完整或格式不正确')
  }
  if (!/^[a-f0-9]{64}$/.test(pairingSecret)) {
    throw unprocessable('本机客户端登记密钥格式不正确')
  }
  if (!/^[A-Za-z0-9_]+$/.test(projectKey)) {
    throw unprocessable('项目标识格式不正确')
  }

  const now = nowIso()
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString()
  const existing = db
    .prepare('SELECT * FROM feishu_agent_pairings WHERE client_id = ?')
    .get(clientId) as PairingRow | undefined

  if (existing && !matchesSecret(existing.pairing_secret_hash, pairingSecret)) {
    throw conflict('该客户端标识已有不同的待绑定请求，请重新启动本机代理')
  }

  if (existing?.status === 'approved') {
    if (Date.parse(existing.expires_at) < Date.now()) {
      db.prepare('DELETE FROM feishu_agent_pairings WHERE client_id = ?').run(clientId)
    } else {
      return {
        status: 'approved',
        clientId,
        configCiphertext: existing.config_ciphertext ?? undefined,
      }
    }
  }

  if (!existing || Date.parse(existing.expires_at) < Date.now()) {
    db.prepare(
      `DELETE FROM feishu_agent_pairings
       WHERE status = 'pending' AND expires_at <= ?`,
    ).run(now)
    const activeCount = db
      .prepare("SELECT COUNT(*) AS count FROM feishu_agent_pairings WHERE status = 'pending' AND expires_at > ?")
      .get(now) as { count: number }
    if (activeCount.count >= MAX_PENDING_PAIRINGS) {
      throw conflict('当前待绑定客户端过多，请稍后重试')
    }
    if (sourceIp) {
      const fromIp = db
        .prepare("SELECT COUNT(*) AS count FROM feishu_agent_pairings WHERE status = 'pending' AND source_ip = ? AND expires_at > ?")
        .get(sourceIp, now) as { count: number }
      if (fromIp.count >= MAX_PENDING_PER_IP) {
        throw conflict('此网络的待绑定客户端过多，请先处理账号中心中的待绑定请求')
      }
    }
  }

  db.prepare(
    `INSERT INTO feishu_agent_pairings
      (client_id, pairing_secret_hash, client_name, machine_name, platform_base_url,
       project_key, public_key, source_ip, status, config_ciphertext, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET
       client_name = excluded.client_name,
       machine_name = excluded.machine_name,
       platform_base_url = excluded.platform_base_url,
       project_key = excluded.project_key,
       public_key = excluded.public_key,
       source_ip = excluded.source_ip,
       status = 'pending',
       config_ciphertext = NULL,
       updated_at = excluded.updated_at,
       expires_at = excluded.expires_at`,
  ).run(
    clientId,
    secretHash(pairingSecret),
    clientName,
    machineName,
    platformBaseUrl,
    projectKey,
    publicKey,
    text(sourceIp, 120),
    now,
    now,
    expiresAt,
  )

  return { status: 'pending', clientId }
}

export function listFeishuAgentPairings(db: AppDatabase): FeishuAgentPairingSummary[] {
  const now = nowIso()
  const rows = db
    .prepare(
      `SELECT * FROM feishu_agent_pairings
       WHERE expires_at > ? ORDER BY created_at DESC, client_id ASC`,
    )
    .all(now) as PairingRow[]
  return rows.map(publicPairing)
}

export function approveFeishuAgentPairing(
  db: AppDatabase,
  clientIdInput: unknown,
  repoPathsInput: unknown,
): FeishuAgentPairingSummary {
  const clientId = validClientId(clientIdInput)
  if (!clientId) throw unprocessable('客户端标识格式不正确')
  const repoPaths = parseFeishuAgentRepoPaths(repoPathsInput, true)

  const row = db
    .prepare('SELECT * FROM feishu_agent_pairings WHERE client_id = ?')
    .get(clientId) as PairingRow | undefined
  if (!row || Date.parse(row.expires_at) <= Date.now()) throw notFound('待绑定客户端')
  if (row.status === 'approved') return publicPairing(row)

  try {
    return db.transaction(() => {
      const syncToken = issueFeishuAgentCredential(db, clientId)
      const payload = JSON.stringify({
        platformBaseUrl: row.platform_base_url,
        syncToken,
        projectKey: row.project_key,
        clientId,
        clientName: row.client_name,
        repoPaths,
      })
      const contentKey = randomBytes(32)
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', contentKey, iv)
      const encryptedPayload = Buffer.concat([
        cipher.update(Buffer.from(payload)),
        cipher.final(),
      ])
      const encryptedKey = publicEncrypt(
        {
          key: row.public_key,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        contentKey,
      ).toString('base64')
      const configCiphertext = JSON.stringify({
        encryptedKey,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: encryptedPayload.toString('base64'),
      })
      const now = nowIso()
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString()
      const update = db.prepare(
        `UPDATE feishu_agent_pairings
         SET status = 'approved', config_ciphertext = ?, updated_at = ?, expires_at = ?
         WHERE client_id = ? AND status = 'pending'`,
      ).run(configCiphertext, now, expiresAt, clientId)
      if (update.changes !== 1) throw conflict('待绑定请求已被其他操作更新，请刷新后重试')
      return {
        ...publicPairing(row),
        status: 'approved' as const,
        updatedAt: now,
        expiresAt,
      }
    })()
  } catch {
    throw unprocessable('无法为该客户端加密绑定配置，请重启本机代理后重试')
  }
}

export function completeFeishuAgentPairing(db: AppDatabase, clientIdInput: unknown): void {
  const clientId = validClientId(clientIdInput)
  if (!clientId) return
  db.prepare(
    "DELETE FROM feishu_agent_pairings WHERE client_id = ? AND status = 'approved'",
  ).run(clientId)
}
