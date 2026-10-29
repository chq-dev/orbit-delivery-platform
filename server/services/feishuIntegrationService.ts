import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AppDatabase } from '../db/database.js'
import { config } from '../config.js'
import { AppError, errorMessage, unprocessable } from '../domain/errors.js'
import { formatDisplayTime, nowIso } from '../domain/time.js'
import type { WorkItemType } from '../domain/types.js'
import { optionalText, requiredText } from '../domain/validation.js'
import type { CredentialVault } from '../security/vault.js'
import { getExternalFeishuStatus } from './feishuIngestService.js'
import { FeishuProjectClient, FeishuProjectError } from './feishuClient.js'
import { upsertFeishuWorkItems } from './workItemService.js'

const INTEGRATION_ID = 'feishu-main'
const EVENT_PATH = '/api/integrations/feishu/events'
const EVENT_TOLERANCE_MS = 5 * 60 * 1000
const MAX_OUTBOX_ATTEMPTS = 5

let syncInFlight: Promise<FeishuSyncResult> | null = null
let outboxInFlight = false

interface IntegrationRow {
  id: string
  project_key: string
  plugin_id: string
  plugin_secret_ciphertext: string
  plugin_secret_iv: string
  plugin_secret_tag: string
  plugin_secret_hint: string
  user_key: string
  default_repo_id: string
  requirement_type_key: string
  defect_type_key: string
  default_owner: string
  close_transition_id: string | null
  webhook_secret_ciphertext: string | null
  webhook_secret_iv: string | null
  webhook_secret_tag: string | null
  webhook_secret_hint: string | null
  status: 'active' | 'error'
  last_sync_at: string | null
  last_sync_status: 'success' | 'failed' | null
  last_sync_message: string | null
  created_at: string
  updated_at: string
}

interface AccessTokenRow {
  token_ciphertext: string
  token_iv: string
  token_tag: string
  token_hint: string
}

export interface FeishuIntegrationStatus {
  connected: boolean
  status?: 'active' | 'error'
  authMode?: 'token' | 'plugin' | 'cli'
  projectKey?: string
  pluginId?: string
  pluginSecretHint?: string
  accessTokenHint?: string
  userKey?: string
  defaultRepoId?: string
  requirementTypeKey?: string
  defectTypeKey?: string
  defaultOwner?: string
  closeTransitionId?: string
  webhookConfigured: boolean
  webhookSecretHint?: string
  lastSyncAt?: string
  lastSyncStatus?: 'success' | 'failed'
  lastSyncMessage?: string
  eventPath: string
}

export interface FeishuConnectInput {
  accessToken?: unknown
  pluginId?: unknown
  pluginSecret?: unknown
  userKey?: unknown
  projectKey: unknown
  defaultRepoId: unknown
  requirementTypeKey: unknown
  defectTypeKey: unknown
  defaultOwner?: unknown
  closeTransitionId?: unknown
  webhookSecret?: unknown
}

export interface FeishuSyncResult {
  fetched: number
  upserted: number
  skipped: number
  message: string
  syncedAt: string
}

interface OutboxRow {
  id: string
  integration_id: string
  work_item_id: string
  external_id: string
  action: 'close'
  status: 'pending' | 'processing' | 'sent' | 'failed'
  attempts: number
}

function integrationSelect(): string {
  return `SELECT id, project_key, plugin_id, plugin_secret_ciphertext, plugin_secret_iv,
                 plugin_secret_tag, plugin_secret_hint, user_key, default_repo_id,
                 requirement_type_key, defect_type_key, default_owner, close_transition_id,
                 webhook_secret_ciphertext, webhook_secret_iv, webhook_secret_tag,
                 webhook_secret_hint, status, last_sync_at, last_sync_status,
                 last_sync_message, created_at, updated_at
          FROM feishu_integrations`
}

function getIntegrationRow(db: AppDatabase): IntegrationRow | undefined {
  return db.prepare(`${integrationSelect()} WHERE id = ?`).get(INTEGRATION_ID) as
    | IntegrationRow
    | undefined
}

function requireIntegration(db: AppDatabase): IntegrationRow {
  const row = getIntegrationRow(db)
  if (!row) {
    throw new AppError(409, 'FEISHU_NOT_CONNECTED', '请先绑定飞书项目')
  }
  return row
}

function getAccessTokenRow(db: AppDatabase): AccessTokenRow | undefined {
  return db
    .prepare(
      `SELECT token_ciphertext, token_iv, token_tag, token_hint
       FROM feishu_access_tokens WHERE integration_id = ?`,
    )
    .get(INTEGRATION_ID) as AccessTokenRow | undefined
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  if (error instanceof FeishuProjectError) {
    return new AppError(error.statusCode, error.code, error.message, error.details)
  }
  return new AppError(502, 'FEISHU_INTEGRATION_FAILED', errorMessage(error))
}

function buildClient(
  db: AppDatabase,
  row: IntegrationRow,
  vault: CredentialVault,
): FeishuProjectClient {
  const tokenRow = getAccessTokenRow(db)
  const accessToken = tokenRow
    ? vault.decrypt({
        ciphertext: tokenRow.token_ciphertext,
        iv: tokenRow.token_iv,
        tag: tokenRow.token_tag,
      })
    : undefined
  return new FeishuProjectClient({
    baseUrl: config.feishuBaseUrl,
    projectKey: row.project_key,
    pluginId: row.plugin_id,
    pluginSecret: accessToken
      ? undefined
      : vault.decrypt({
          ciphertext: row.plugin_secret_ciphertext,
          iv: row.plugin_secret_iv,
          tag: row.plugin_secret_tag,
        }),
    accessToken,
    userKey: row.user_key,
  })
}

function normalizedInput(input: FeishuConnectInput) {
  const accessToken = optionalText(input.accessToken, '访问 Token', 4_000)
  const pluginId = accessToken
    ? optionalText(input.pluginId, 'Plugin ID', 200) ?? ''
    : requiredText(input.pluginId, 'Plugin ID', { max: 200 })
  const pluginSecret = accessToken
    ? optionalText(input.pluginSecret, 'Plugin Secret', 2_000) ?? ''
    : requiredText(input.pluginSecret, 'Plugin Secret', { max: 2_000 })
  const userKey = accessToken
    ? optionalText(input.userKey, 'User Key', 200) ?? ''
    : requiredText(input.userKey, 'User Key', { max: 200 })
  const projectKey = requiredText(input.projectKey, '项目标识', { max: 200 })
  const defaultRepoId = requiredText(input.defaultRepoId, '默认仓库', { max: 200 })
  const requirementTypeKey = requiredText(input.requirementTypeKey, '需求类型 Key', { max: 100 })
  const defectTypeKey = requiredText(input.defectTypeKey, '缺陷类型 Key', { max: 100 })
  const defaultOwner = optionalText(input.defaultOwner, '默认负责人', 100) ?? '飞书同步'
  const closeTransitionId = optionalText(input.closeTransitionId, '关闭流转 ID', 100)
  const webhookSecret = optionalText(input.webhookSecret, 'Webhook 密钥', 2_000)

  if (requirementTypeKey === defectTypeKey) {
    throw unprocessable('需求类型 Key 和缺陷类型 Key 不能相同')
  }
  if (closeTransitionId && !/^\d+$/.test(closeTransitionId)) {
    throw unprocessable('关闭流转 ID 必须是数字')
  }

  return {
    authMode: accessToken ? ('token' as const) : ('plugin' as const),
    accessToken,
    pluginId,
    pluginSecret,
    userKey,
    projectKey,
    defaultRepoId,
    requirementTypeKey,
    defectTypeKey,
    defaultOwner,
    closeTransitionId,
    webhookSecret,
  }
}

export function getFeishuStatus(db: AppDatabase): FeishuIntegrationStatus {
  const row = getIntegrationRow(db)
  if (!row) {
    return (
      getExternalFeishuStatus(db) ?? {
        connected: false,
        webhookConfigured: false,
        eventPath: EVENT_PATH,
      }
    )
  }
  const tokenRow = getAccessTokenRow(db)
  return {
    connected: true,
    status: row.status,
    authMode: tokenRow ? 'token' : 'plugin',
    projectKey: row.project_key,
    ...(tokenRow
      ? { accessTokenHint: tokenRow.token_hint }
      : { pluginId: row.plugin_id, pluginSecretHint: row.plugin_secret_hint }),
    userKey: row.user_key || undefined,
    defaultRepoId: row.default_repo_id,
    requirementTypeKey: row.requirement_type_key,
    defectTypeKey: row.defect_type_key,
    defaultOwner: row.default_owner,
    closeTransitionId: row.close_transition_id ?? undefined,
    webhookConfigured: Boolean(row.webhook_secret_ciphertext),
    webhookSecretHint: row.webhook_secret_hint ?? undefined,
    lastSyncAt: row.last_sync_at ? formatDisplayTime(row.last_sync_at) : undefined,
    lastSyncStatus: row.last_sync_status ?? undefined,
    lastSyncMessage: row.last_sync_message ?? undefined,
    eventPath: EVENT_PATH,
  }
}

export async function connectFeishu(
  db: AppDatabase,
  vault: CredentialVault,
  rawInput: FeishuConnectInput,
): Promise<FeishuIntegrationStatus> {
  const input = normalizedInput(rawInput)
  const existing = getIntegrationRow(db)
  const repository = db
    .prepare('SELECT id FROM repositories WHERE id = ?')
    .get(input.defaultRepoId) as { id: string } | undefined
  if (!repository) throw new AppError(422, 'FEISHU_REPO_NOT_FOUND', '默认仓库不存在')

  const client = new FeishuProjectClient({
    baseUrl: config.feishuBaseUrl,
    projectKey: input.projectKey,
    pluginId: input.pluginId,
    pluginSecret: input.pluginSecret,
    accessToken: input.accessToken,
    userKey: input.userKey,
  })
  try {
    await client.testConnection(input.requirementTypeKey, input.defectTypeKey)
  } catch (error) {
    throw toAppError(error)
  }

  const encryptedPluginSecret = vault.encrypt(input.pluginSecret)
  const encryptedAccessToken = input.accessToken ? vault.encrypt(input.accessToken) : undefined
  const encryptedWebhookSecret = input.webhookSecret ? vault.encrypt(input.webhookSecret) : undefined
  const webhookSecret = encryptedWebhookSecret
    ? {
        ciphertext: encryptedWebhookSecret.ciphertext,
        iv: encryptedWebhookSecret.iv,
        tag: encryptedWebhookSecret.tag,
        hint: vault.hint(input.webhookSecret ?? ''),
      }
    : existing?.webhook_secret_ciphertext &&
        existing.webhook_secret_iv &&
        existing.webhook_secret_tag
      ? {
          ciphertext: existing.webhook_secret_ciphertext,
          iv: existing.webhook_secret_iv,
          tag: existing.webhook_secret_tag,
          hint: existing.webhook_secret_hint ?? '',
        }
      : undefined
  const now = nowIso()

  const persistConnection = db.transaction(() => {
    db.prepare(
      `INSERT INTO feishu_integrations
      (id, project_key, plugin_id, plugin_secret_ciphertext, plugin_secret_iv,
       plugin_secret_tag, plugin_secret_hint, user_key, default_repo_id,
       requirement_type_key, defect_type_key, default_owner, close_transition_id,
       webhook_secret_ciphertext, webhook_secret_iv, webhook_secret_tag,
       webhook_secret_hint, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_key = excluded.project_key,
       plugin_id = excluded.plugin_id,
       plugin_secret_ciphertext = excluded.plugin_secret_ciphertext,
       plugin_secret_iv = excluded.plugin_secret_iv,
       plugin_secret_tag = excluded.plugin_secret_tag,
       plugin_secret_hint = excluded.plugin_secret_hint,
       user_key = excluded.user_key,
       default_repo_id = excluded.default_repo_id,
       requirement_type_key = excluded.requirement_type_key,
       defect_type_key = excluded.defect_type_key,
       default_owner = excluded.default_owner,
       close_transition_id = excluded.close_transition_id,
       webhook_secret_ciphertext = excluded.webhook_secret_ciphertext,
       webhook_secret_iv = excluded.webhook_secret_iv,
       webhook_secret_tag = excluded.webhook_secret_tag,
       webhook_secret_hint = excluded.webhook_secret_hint,
       status = 'active',
       last_sync_at = NULL,
       last_sync_status = NULL,
       last_sync_message = NULL,
       updated_at = excluded.updated_at`,
    ).run(
      INTEGRATION_ID,
      input.projectKey,
      input.pluginId,
      encryptedPluginSecret.ciphertext,
      encryptedPluginSecret.iv,
      encryptedPluginSecret.tag,
      vault.hint(input.pluginSecret),
      input.userKey,
      input.defaultRepoId,
      input.requirementTypeKey,
      input.defectTypeKey,
      input.defaultOwner,
      input.closeTransitionId ?? null,
      webhookSecret?.ciphertext ?? null,
      webhookSecret?.iv ?? null,
      webhookSecret?.tag ?? null,
      webhookSecret?.hint ?? null,
      now,
      now,
    )

    if (encryptedAccessToken) {
      db.prepare(
        `INSERT INTO feishu_access_tokens
        (integration_id, token_ciphertext, token_iv, token_tag, token_hint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(integration_id) DO UPDATE SET
         token_ciphertext = excluded.token_ciphertext,
         token_iv = excluded.token_iv,
         token_tag = excluded.token_tag,
         token_hint = excluded.token_hint,
         updated_at = excluded.updated_at`,
      ).run(
        INTEGRATION_ID,
        encryptedAccessToken.ciphertext,
        encryptedAccessToken.iv,
        encryptedAccessToken.tag,
        vault.hint(input.accessToken ?? ''),
        now,
        now,
      )
    } else {
      db.prepare('DELETE FROM feishu_access_tokens WHERE integration_id = ?').run(INTEGRATION_ID)
    }
  })
  persistConnection()

  return getFeishuStatus(db)
}

export async function testFeishuConnection(
  db: AppDatabase,
  vault: CredentialVault,
): Promise<{ ok: true; projectName?: string }> {
  const row = requireIntegration(db)
  try {
    const result = await buildClient(db, row, vault).testConnection(
      row.requirement_type_key,
      row.defect_type_key,
    )
    db.prepare(
      "UPDATE feishu_integrations SET status = 'active', updated_at = ? WHERE id = ?",
    ).run(nowIso(), INTEGRATION_ID)
    return { ok: true, projectName: result.projectName }
  } catch (error) {
    db.prepare(
      "UPDATE feishu_integrations SET status = 'error', updated_at = ? WHERE id = ?",
    ).run(nowIso(), INTEGRATION_ID)
    throw toAppError(error)
  }
}

function writeSyncLog(
  db: AppDatabase,
  status: 'success' | 'failed',
  trigger: 'manual' | 'event' | 'schedule',
  fetched: number,
  upserted: number,
  skipped: number,
  message: string,
  now: string,
): void {
  db.prepare(
    `INSERT INTO feishu_sync_logs
      (id, integration_id, trigger_type, status, fetched, upserted, skipped, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), INTEGRATION_ID, trigger, status, fetched, upserted, skipped, message, now)
}

async function performSync(
  db: AppDatabase,
  vault: CredentialVault,
  trigger: 'manual' | 'event' | 'schedule' = 'manual',
): Promise<FeishuSyncResult> {
  const row = requireIntegration(db)
  try {
    const result = await buildClient(db, row, vault).fetchInboxItems(
      row.requirement_type_key,
      row.defect_type_key,
      row.default_owner,
    )
    const now = nowIso()
    let message = ''

    db.transaction(() => {
      const upsert = db.prepare(
        `INSERT INTO feishu_inbox
          (external_id, type, title, description, priority, repo_id, owner, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(external_id) DO UPDATE SET
           type = excluded.type,
           title = excluded.title,
           description = excluded.description,
           priority = excluded.priority,
           repo_id = excluded.repo_id,
           owner = excluded.owner,
           updated_at = excluded.updated_at`,
      )
      for (const item of result.items) {
        upsert.run(
          item.externalId,
          item.type,
          item.title,
          item.description,
          item.priority,
          row.default_repo_id,
          item.owner,
          item.updatedAt,
        )
      }
      const workItems = upsertFeishuWorkItems(db, row.default_repo_id, result.items)
      message = `已同步 ${result.items.length} 条飞书工作项，列表新增 ${workItems.created} 条、更新 ${workItems.updated} 条${
        result.skipped > 0 ? `，跳过 ${result.skipped} 条无效数据` : ''
      }`
      db.prepare(
        `UPDATE feishu_integrations
         SET status = 'active', last_sync_at = ?, last_sync_status = 'success',
             last_sync_message = ?, updated_at = ?
         WHERE id = ?`,
      ).run(now, message, now, INTEGRATION_ID)
      writeSyncLog(db, 'success', trigger, result.fetched, result.items.length, result.skipped, message, now)
    })()

    return {
      fetched: result.fetched,
      upserted: result.items.length,
      skipped: result.skipped,
      message,
      syncedAt: formatDisplayTime(now),
    }
  } catch (error) {
    const now = nowIso()
    const message = errorMessage(error)
    db.transaction(() => {
      db.prepare(
        `UPDATE feishu_integrations
         SET status = 'error', last_sync_at = ?, last_sync_status = 'failed',
             last_sync_message = ?, updated_at = ?
         WHERE id = ?`,
      ).run(now, message, now, INTEGRATION_ID)
      writeSyncLog(db, 'failed', trigger, 0, 0, 0, message, now)
    })()
    throw toAppError(error)
  }
}

export function syncFeishu(
  db: AppDatabase,
  vault: CredentialVault,
  trigger: 'manual' | 'event' | 'schedule' = 'manual',
): Promise<FeishuSyncResult> {
  if (syncInFlight) return syncInFlight
  syncInFlight = performSync(db, vault, trigger).finally(() => {
    syncInFlight = null
  })
  return syncInFlight
}

export function disconnectFeishu(db: AppDatabase): FeishuIntegrationStatus {
  db.prepare('DELETE FROM feishu_integrations WHERE id = ?').run(INTEGRATION_ID)
  return getFeishuStatus(db)
}

export function enqueueFeishuCloseOutbox(db: AppDatabase, workItemId: string): void {
  const item = db
    .prepare('SELECT type, source, external_id FROM work_items WHERE id = ?')
    .get(workItemId) as
    | { type: WorkItemType; source: 'local' | 'feishu'; external_id: string | null }
    | undefined
  if (!item || item.type !== 'defect' || item.source !== 'feishu' || !item.external_id) return

  const integration = db
    .prepare('SELECT id FROM feishu_integrations WHERE id = ?')
    .get(INTEGRATION_ID) as { id: string } | undefined
  if (!integration) return

  const now = nowIso()
  db.prepare(
    `INSERT INTO feishu_outbox
      (id, integration_id, work_item_id, external_id, action, status, attempts,
       next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'close', 'pending', 0, ?, ?, ?)
     ON CONFLICT(work_item_id, action) DO UPDATE SET
       external_id = excluded.external_id,
       status = 'pending',
       attempts = 0,
       next_attempt_at = excluded.next_attempt_at,
       last_error = NULL,
       updated_at = excluded.updated_at`,
  ).run(randomUUID(), INTEGRATION_ID, workItemId, item.external_id, now, now, now)
}

function splitExternalId(
  externalId: string,
  fallbackProjectKey: string,
  fallbackTypeKey: string,
): { projectKey: string; typeKey: string; workItemId: string } {
  const parts = externalId.split(':')
  if (parts.length >= 3) {
    return {
      projectKey: parts[0],
      typeKey: parts[1],
      workItemId: parts.slice(2).join(':'),
    }
  }
  return { projectKey: fallbackProjectKey, typeKey: fallbackTypeKey, workItemId: externalId }
}

export async function processFeishuOutbox(
  db: AppDatabase,
  vault: CredentialVault,
  limit = 10,
): Promise<number> {
  if (outboxInFlight) return 0
  outboxInFlight = true
  try {
    const now = nowIso()
    const rows = db
      .prepare(
        `SELECT id, integration_id, work_item_id, external_id, action, status, attempts
         FROM feishu_outbox
         WHERE status IN ('pending', 'failed') AND next_attempt_at <= ? AND attempts < ?
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(now, MAX_OUTBOX_ATTEMPTS, limit) as OutboxRow[]
    if (rows.length === 0) return 0

    let processed = 0
    for (const row of rows) {
      const integration = db
        .prepare(`${integrationSelect()} WHERE id = ?`)
        .get(row.integration_id) as IntegrationRow | undefined
      if (!integration) continue
      const workItem = db
        .prepare('SELECT type FROM work_items WHERE id = ?')
        .get(row.work_item_id) as { type: WorkItemType } | undefined
      if (!workItem) continue
      const fallbackTypeKey =
        workItem.type === 'defect' ? integration.defect_type_key : integration.requirement_type_key
      const target = splitExternalId(row.external_id, integration.project_key, fallbackTypeKey)

      try {
        await buildClient(db, integration, vault).closeWorkItem(
          target.projectKey,
          target.typeKey,
          target.workItemId,
          integration.close_transition_id ?? undefined,
        )
        db.prepare(
          `UPDATE feishu_outbox SET status = 'sent', last_error = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(nowIso(), row.id)
        processed += 1
      } catch (error) {
        const attempts = row.attempts + 1
        const retryDelayMs = Math.min(60 * 60 * 1000, 60_000 * 2 ** Math.max(0, attempts - 1))
        const nextAttemptAt = new Date(Date.now() + retryDelayMs).toISOString()
        db.prepare(
          `UPDATE feishu_outbox SET status = 'failed', attempts = ?, next_attempt_at = ?,
           last_error = ?, updated_at = ? WHERE id = ?`,
        ).run(attempts, nextAttemptAt, errorMessage(error), nowIso(), row.id)
      }
    }
    return processed
  } finally {
    outboxInFlight = false
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = headers[name] ?? headers[name.toLowerCase()]
    if (Array.isArray(value)) return value[0]
    if (value) return value
  }
  return undefined
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function verifyWebhookSignature(
  row: IntegrationRow,
  vault: CredentialVault,
  rawBody: Buffer,
  body: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
): void {
  if (!row.webhook_secret_ciphertext || !row.webhook_secret_iv || !row.webhook_secret_tag) {
    throw new AppError(422, 'FEISHU_WEBHOOK_NOT_CONFIGURED', '请先配置飞书项目回调 Token')
  }
  const signature =
    (typeof body.signature === 'string' ? body.signature : undefined) ??
    headerValue(headers, ['x-feishu-signature', 'x-lark-signature', 'x-signature'])
  if (!signature) {
    throw new AppError(401, 'FEISHU_WEBHOOK_SIGNATURE_MISSING', '缺少飞书事件签名')
  }
  const timestampValue = body.request_time ??
    headerValue(headers, [
      'x-feishu-request-timestamp',
      'x-lark-request-timestamp',
      'x-timestamp',
    ])
  const timestamp = timestampValue === undefined ? undefined : String(timestampValue)
  const nonce = headerValue(headers, [
    'x-feishu-request-nonce',
    'x-lark-request-nonce',
    'x-nonce',
  ])
  if (timestamp) {
    const numeric = Number(timestamp)
    const timestampMs = numeric > 10_000_000_000 ? numeric : numeric * 1000
    if (Number.isFinite(timestampMs) && Math.abs(Date.now() - timestampMs) > EVENT_TOLERANCE_MS) {
      throw new AppError(401, 'FEISHU_WEBHOOK_EXPIRED', '飞书事件时间戳已过期')
    }
  }

  const secret = vault.decrypt({
    ciphertext: row.webhook_secret_ciphertext,
    iv: row.webhook_secret_iv,
    tag: row.webhook_secret_tag,
  })
  const rawText = rawBody.toString('utf8')
  const officialSignature = createHash('sha256')
    .update(`${row.plugin_id}${timestamp ?? ''}${secret}`)
    .digest('hex')
  const payloads = [
    `${timestamp ?? ''}${nonce ?? ''}${rawText}`,
    `${timestamp ?? ''}\n${nonce ?? ''}\n${rawText}`,
    rawText,
  ]
  const candidates = payloads.flatMap((payload) => {
    const digest = createHmac('sha256', secret).update(payload).digest()
    return [digest.toString('hex'), digest.toString('base64')]
  })
  const normalizedSignature = signature.trim()
  if (
    !safeEqual(officialSignature, normalizedSignature) &&
    !candidates.some((candidate) => safeEqual(candidate, normalizedSignature))
  ) {
    throw new AppError(401, 'FEISHU_WEBHOOK_SIGNATURE_INVALID', '飞书事件签名校验失败')
  }
}

function eventKeyOf(body: Record<string, unknown>, rawBody: Buffer): string {
  const data = body.data
  if (isRecord(data)) {
    const idempotentKey = data.idempotent_key
    if (typeof idempotentKey === 'string' && idempotentKey) {
      return `event:${idempotentKey}`
    }
  }
  const direct = body.event_id ?? body.uuid ?? body.id
  if (typeof direct === 'string' && direct) return `event:${direct}`
  return `body:${createHash('sha256').update(rawBody).digest('hex')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function handleFeishuEvent(
  db: AppDatabase,
  vault: CredentialVault,
  body: unknown,
  rawBody: Buffer | undefined,
  headers: Record<string, string | string[] | undefined>,
): { ok: true; success: true; challenge?: string; duplicate?: boolean; queued?: boolean } {
  if (!rawBody) {
    throw new AppError(400, 'FEISHU_WEBHOOK_RAW_BODY_MISSING', '无法读取飞书事件原始请求体')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw unprocessable('飞书事件请求体格式不正确')
  }
  const record = body as Record<string, unknown>
  const row = requireIntegration(db)
  verifyWebhookSignature(row, vault, rawBody, record, headers)

  const challenge = record.challenge
  if (typeof challenge === 'string' && challenge) {
    return { ok: true, success: true, challenge }
  }

  const eventKey = eventKeyOf(record, rawBody)
  const dedup = db
    .prepare('INSERT OR IGNORE INTO feishu_event_dedup (event_key, received_at) VALUES (?, ?)')
    .run(eventKey, nowIso())
  if (dedup.changes === 0) return { ok: true, success: true, duplicate: true }

  setImmediate(() => {
    void syncFeishu(db, vault, 'event').catch((error) => {
      console.error('飞书事件触发同步失败', error)
    })
  })
  return { ok: true, success: true, queued: true }
}
