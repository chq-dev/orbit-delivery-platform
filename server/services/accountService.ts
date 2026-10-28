import type { AppDatabase } from '../db/database.js'
import { nextSequence } from '../db/sequences.js'
import { conflict, unprocessable } from '../domain/errors.js'
import { nowIso } from '../domain/time.js'
import type { Account, AccountStatus, PlatformKey } from '../domain/types.js'
import { oneOf, optionalText, requiredText } from '../domain/validation.js'
import type { CredentialVault } from '../security/vault.js'

const platforms = ['git', 'feishu', 'build', 'device'] as const

interface AccountRow {
  id: string
  platform: PlatformKey
  username: string
  label: string
  secret_hint: string
  status: AccountStatus
  created_at: string
}

export interface AccountInput {
  platform: unknown
  username: unknown
  password: unknown
  label?: unknown
}

function rowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    platform: row.platform,
    username: row.username,
    label: row.label,
    secretHint: row.secret_hint,
    status: row.status,
    createdAt: row.created_at.slice(0, 10),
  }
}

export function listAccounts(db: AppDatabase): Account[] {
  const rows = db
    .prepare(
      `SELECT id, platform, username, label, secret_hint, status, created_at
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
  return { platform, username, password, label }
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
      (id, platform, username, label, secret_ciphertext, secret_iv, secret_tag, secret_hint, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    id,
    normalized.platform,
    normalized.username,
    normalized.label,
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
          (id, platform, username, label, secret_ciphertext, secret_iv, secret_tag, secret_hint, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        id,
        row.platform,
        row.username,
        row.label,
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
        secretHint: vault.hint(row.password),
        status: 'active',
        createdAt: now.slice(0, 10),
      })
    }
  })()

  return { accounts: created, skipped }
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
