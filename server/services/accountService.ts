import type { AppDatabase } from '../db/database.js'
import { nextSequence } from '../db/sequences.js'
import { conflict, notFound, unprocessable } from '../domain/errors.js'
import { nowIso } from '../domain/time.js'
import type { Account, AccountStatus, PlatformKey } from '../domain/types.js'
import { httpUrl, oneOf, optionalText, requiredText } from '../domain/validation.js'
import type { CredentialVault } from '../security/vault.js'

const platforms = ['git', 'feishu', 'build', 'device'] as const

interface AccountRow {
  id: string
  platform: PlatformKey
  username: string
  label: string
  service_url: string
  secret_hint: string
  status: AccountStatus
  created_at: string
}

interface AccountStorageRow extends AccountRow {
  secret_ciphertext: string
  secret_iv: string
  secret_tag: string
}

export interface AccountInput {
  platform: unknown
  username: unknown
  password: unknown
  label?: unknown
  serviceUrl?: unknown
}

export interface AccountUpdateInput {
  platform?: unknown
  username?: unknown
  password?: unknown
  label?: unknown
  serviceUrl?: unknown
}

function rowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    platform: row.platform,
    username: row.username,
    label: row.label,
    serviceUrl: row.service_url,
    secretHint: row.secret_hint,
    status: row.status,
    createdAt: row.created_at.slice(0, 10),
  }
}

export function listAccounts(db: AppDatabase): Account[] {
  const rows = db
    .prepare(
      `SELECT id, platform, username, label, service_url, secret_hint, status, created_at
       FROM accounts ORDER BY created_at DESC, id DESC`,
    )
    .all() as AccountRow[]
  return rows.map(rowToAccount)
}

function normalizedInput(input: AccountInput) {
  const platform = oneOf(input.platform, '平台', platforms)
  const username = requiredText(input.username, '账号', { max: 200 })
  const password = requiredText(input.password, '密码', { max: 2_000 })
  const label = optionalText(input.label, '账号标签', 100) ?? '平台账号'
  const serviceUrl = normalizedServiceUrl(input.serviceUrl, '')
  return { platform, username, password, label, serviceUrl }
}

function normalizedServiceUrl(value: unknown, fallback: string): string {
  if (value === undefined) return fallback
  if (value === null) return ''
  if (typeof value !== 'string') throw unprocessable('服务地址必须是文本')
  const text = value.trim()
  return text ? httpUrl(text, '服务地址') : ''
}

function getAccountRow(db: AppDatabase, id: string): AccountStorageRow {
  const row = db
    .prepare(
      `SELECT id, platform, username, label, service_url, secret_hint, status, created_at,
              secret_ciphertext, secret_iv, secret_tag
       FROM accounts WHERE id = ?`,
    )
    .get(id) as AccountStorageRow | undefined
  if (!row) throw notFound('账号')
  return row
}

export function createAccount(
  db: AppDatabase,
  vault: CredentialVault,
  input: AccountInput,
): Account {
  const normalized = normalizedInput(input)
  const encrypted = vault.encrypt(normalized.password)
  const now = nowIso()
  const id = `acc-${nextSequence(db, 'account', 1)}`

  const duplicate = db
    .prepare('SELECT id FROM accounts WHERE platform = ? AND username = ?')
    .get(normalized.platform, normalized.username) as { id: string } | undefined
  if (duplicate) throw conflict('该平台账号已绑定，请勿重复添加')

  db.prepare(
    `INSERT INTO accounts
      (id, platform, username, label, service_url, secret_ciphertext, secret_iv, secret_tag, secret_hint, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    id,
    normalized.platform,
    normalized.username,
    normalized.label,
    normalized.serviceUrl,
    encrypted.ciphertext,
    encrypted.iv,
    encrypted.tag,
    vault.hint(normalized.password),
    now,
    now,
  )

  return {
    id,
    platform: normalized.platform,
    username: normalized.username,
    label: normalized.label,
    serviceUrl: normalized.serviceUrl,
    secretHint: vault.hint(normalized.password),
    status: 'active',
    createdAt: now.slice(0, 10),
  }
}

export function importAccounts(
  db: AppDatabase,
  vault: CredentialVault,
  inputs: unknown,
): { accounts: Account[]; skipped: number } {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw unprocessable('批量导入账号不能为空')
  }
  if (inputs.length > 500) throw unprocessable('单次最多导入 500 个账号')

  const rows = inputs.map((input) => normalizedInput(input as AccountInput))
  const created: Account[] = []
  let skipped = 0

  db.transaction(() => {
    for (const row of rows) {
      const duplicate = db
        .prepare('SELECT id FROM accounts WHERE platform = ? AND username = ?')
        .get(row.platform, row.username) as { id: string } | undefined
      if (duplicate) {
        skipped += 1
        continue
      }

      const encrypted = vault.encrypt(row.password)
      const now = nowIso()
      const id = `acc-${nextSequence(db, 'account', 1)}`
      db.prepare(
        `INSERT INTO accounts
          (id, platform, username, label, service_url, secret_ciphertext, secret_iv, secret_tag, secret_hint, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        id,
        row.platform,
        row.username,
        row.label,
        row.serviceUrl,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        vault.hint(row.password),
        now,
        now,
      )
      created.push({
        id,
        platform: row.platform,
        username: row.username,
        label: row.label,
        serviceUrl: row.serviceUrl,
        secretHint: vault.hint(row.password),
        status: 'active',
        createdAt: now.slice(0, 10),
      })
    }
  })()

  return { accounts: created, skipped }
}

export function updateAccount(
  db: AppDatabase,
  vault: CredentialVault,
  id: string,
  input: AccountUpdateInput,
): Account {
  const current = getAccountRow(db, id)
  const platform = input.platform === undefined
    ? current.platform
    : oneOf(input.platform, '平台', platforms)
  const username = input.username === undefined
    ? current.username
    : requiredText(input.username, '账号', { max: 200 })
  const label = input.label === undefined
    ? current.label
    : optionalText(input.label, '账号标签', 100) ?? '平台账号'
  const serviceUrl = normalizedServiceUrl(input.serviceUrl, current.service_url)
  const password =
    input.password === undefined ||
    input.password === null ||
    (typeof input.password === 'string' && !input.password.trim())
      ? undefined
      : requiredText(input.password, '密码', { max: 2_000 })

  const duplicate = db
    .prepare('SELECT id FROM accounts WHERE platform = ? AND username = ? AND id <> ?')
    .get(platform, username, id) as { id: string } | undefined
  if (duplicate) throw conflict('该平台账号已绑定，请勿重复添加')

  const encrypted = password
    ? vault.encrypt(password)
    : {
        ciphertext: current.secret_ciphertext,
        iv: current.secret_iv,
        tag: current.secret_tag,
      }
  const secretHint = password ? vault.hint(password) : current.secret_hint
  const now = nowIso()

  db.prepare(
    `UPDATE accounts
     SET platform = ?, username = ?, label = ?, service_url = ?,
         secret_ciphertext = ?, secret_iv = ?, secret_tag = ?, secret_hint = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    platform,
    username,
    label,
    serviceUrl,
    encrypted.ciphertext,
    encrypted.iv,
    encrypted.tag,
    secretHint,
    now,
    id,
  )

  return {
    id,
    platform,
    username,
    label,
    serviceUrl,
    secretHint,
    status: current.status,
    createdAt: current.created_at.slice(0, 10),
  }
}

export function deleteAccount(db: AppDatabase, id: string): void {
  getAccountRow(db, id)
  const repository = db
    .prepare('SELECT id, name FROM repositories WHERE account_id = ? LIMIT 1')
    .get(id) as { id: string; name: string } | undefined
  if (repository) {
    throw conflict(`账号正在为仓库「${repository.name}」提供凭据，请先调整仓库账号后再删除`)
  }
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
}

export function getAccountSecret(
  db: AppDatabase,
  vault: CredentialVault,
  id: string,
): string {
  const row = db
    .prepare(
      `SELECT secret_ciphertext, secret_iv, secret_tag FROM accounts WHERE id = ?`,
    )
    .get(id) as
    | { secret_ciphertext: string; secret_iv: string; secret_tag: string }
    | undefined
  if (!row) throw new Error('账号不存在')
  return vault.decrypt({
    ciphertext: row.secret_ciphertext,
    iv: row.secret_iv,
    tag: row.secret_tag,
  })
}
