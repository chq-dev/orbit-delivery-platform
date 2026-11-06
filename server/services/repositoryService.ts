import { isAbsolute } from 'node:path'
import type { AppDatabase } from '../db/database.js'
import { defaultOwnerUserId } from '../db/ownership.js'
import { nextSequence } from '../db/sequences.js'
import { conflict, notFound, unprocessable } from '../domain/errors.js'
import { formatDisplayTime, nowIso } from '../domain/time.js'
import type { Repository, RepositoryStatus } from '../domain/types.js'
import { booleanValue, httpUrl, optionalText, requiredText } from '../domain/validation.js'

interface RepositoryRow {
  id: string
  name: string
  url: string
  branch: string
  local_path: string
  build_enabled: number
  build_account_id: string
  language: string
  account_id: string
  last_sync: string
  status: RepositoryStatus
  latest_version: string
}

export interface RepositoryInput {
  name: unknown
  url: unknown
  branch: unknown
  localPath?: unknown
  buildEnabled?: unknown
  buildAccountId?: unknown
  language: unknown
  accountId: unknown
}

export interface RepositoryUpdateInput {
  branch?: unknown
  localPath?: unknown
  buildEnabled?: unknown
  buildAccountId?: unknown
}

function rowToRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    branch: row.branch,
    localPath: row.local_path,
    buildEnabled: row.build_enabled === 1,
    buildAccountId: row.build_account_id,
    language: row.language,
    accountId: row.account_id,
    lastSync: formatDisplayTime(row.last_sync),
    status: row.status,
    latestVersion: row.latest_version,
  }
}

export function listRepositories(db: AppDatabase, ownerUserId?: string): Repository[] {
  const select = `SELECT id, name, url, branch, local_path, build_enabled, build_account_id,
                         language, account_id, last_sync, status, latest_version
                  FROM repositories`
  const rows = (ownerUserId === undefined
    ? db.prepare(`${select} ORDER BY created_at ASC, id ASC`).all()
    : db
        .prepare(`${select} WHERE owner_user_id = ? ORDER BY created_at ASC, id ASC`)
        .all(ownerUserId)) as RepositoryRow[]
  return rows.map(rowToRepository)
}

export function getRepository(
  db: AppDatabase,
  id: string,
  ownerUserId?: string,
): Repository {
  const select = `SELECT id, name, url, branch, local_path, build_enabled, build_account_id,
                         language, account_id, last_sync, status, latest_version
                  FROM repositories WHERE id = ?`
  const row = (ownerUserId === undefined
    ? db.prepare(select).get(id)
    : db.prepare(`${select} AND owner_user_id = ?`).get(id, ownerUserId)) as
    | RepositoryRow
    | undefined
  if (!row) throw notFound('代码仓库')
  return rowToRepository(row)
}

export function createRepository(
  db: AppDatabase,
  input: RepositoryInput,
  ownerUserId?: string,
): Repository {
  const name = requiredText(input.name, '仓库名称', { max: 200 })
  const url = httpUrl(input.url, '仓库地址')
  const branch = requiredText(input.branch, '默认分支', { max: 200 })
  const localPath = normalizeClientPath(input.localPath)
  const buildEnabled = booleanValue(input.buildEnabled, '系统编译开关', true)
  const buildAccountId = normalizeBuildAccountId(
    db,
    input.buildAccountId,
    '',
    ownerUserId,
  )
  const language = optionalText(input.language, '开发语言', 100) ?? 'Vue 3 + Lua'
  const accountId = requiredText(input.accountId, 'Git 账号', { max: 200 })

  const account = db
    .prepare(
      ownerUserId === undefined
        ? 'SELECT platform, owner_user_id FROM accounts WHERE id = ?'
        : 'SELECT platform, owner_user_id FROM accounts WHERE id = ? AND owner_user_id = ?',
    )
    .get(...(ownerUserId === undefined ? [accountId] : [accountId, ownerUserId])) as
    | { platform: string; owner_user_id: string }
    | undefined
  if (!account) throw notFound('Git 账号')
  if (account.platform !== 'git') throw conflict('仓库只能关联 Git 平台账号')
  const repositoryOwner = defaultOwnerUserId(db, account.owner_user_id || ownerUserId)

  const duplicate = db
    .prepare('SELECT id FROM repositories WHERE owner_user_id = ? AND url = ?')
    .get(repositoryOwner, url) as { id: string } | undefined
  if (duplicate) throw conflict('该仓库地址已接入')

  const now = nowIso()
  const id = `repo-${nextSequence(db, 'repository', 1)}`
  db.prepare(
    `INSERT INTO repositories
      (id, owner_user_id, name, url, branch, local_path, build_enabled, build_account_id,
       language, account_id, last_sync, status, latest_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'healthy', '待构建', ?, ?)`,
  ).run(
    id,
    repositoryOwner,
    name,
    url,
    branch,
    localPath,
    buildEnabled ? 1 : 0,
    buildAccountId,
    language,
    accountId,
    now,
    now,
    now,
  )

  return getRepository(db, id)
}

export function updateRepositorySettings(
  db: AppDatabase,
  id: string,
  input: RepositoryUpdateInput,
  ownerUserId?: string,
): Repository {
  const repository = (ownerUserId === undefined
    ? db
        .prepare(
          'SELECT id, branch, local_path, build_enabled, build_account_id FROM repositories WHERE id = ?',
        )
        .get(id)
    : db
        .prepare(
          `SELECT id, branch, local_path, build_enabled, build_account_id
           FROM repositories WHERE id = ? AND owner_user_id = ?`,
        )
        .get(id, ownerUserId)) as
    | {
        id: string
        branch: string
        local_path: string
        build_enabled: number
        build_account_id: string
      }
    | undefined
  if (!repository) throw notFound('代码仓库')

  const branch = input.branch === undefined
    ? repository.branch
    : requiredText(input.branch, '默认管理分支', { max: 200 })
  const localPath = input.localPath === undefined
    ? repository.local_path
    : normalizeClientPath(input.localPath)
  const buildEnabled = input.buildEnabled === undefined
    ? repository.build_enabled === 1
    : booleanValue(input.buildEnabled, '系统编译开关')
  const buildAccountId = normalizeBuildAccountId(
    db,
    input.buildAccountId,
    repository.build_account_id,
    ownerUserId,
  )

  db.transaction(() => {
    db.prepare(
      `UPDATE repositories
       SET branch = ?, local_path = ?, build_enabled = ?, build_account_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      branch,
      localPath,
      buildEnabled ? 1 : 0,
      buildAccountId,
      nowIso(),
      id,
    )
    db.prepare('UPDATE work_items SET branch = ? WHERE repo_id = ?').run(branch, id)
  })()

  return getRepository(db, id, ownerUserId)
}

function normalizeClientPath(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  const localPath = requiredText(value, '客户端代码路径', { max: 1_000 })
  if (!isAbsolute(localPath)) throw unprocessable('客户端代码路径必须是绝对路径')
  return localPath
}

function normalizeBuildAccountId(
  db: AppDatabase,
  value: unknown,
  fallback: string,
  ownerUserId?: string,
): string {
  if (value === undefined) return fallback
  if (value === null || value === '') return ''
  const id = requiredText(value, '编译系统账号', { max: 200 })
  const account = db
    .prepare(
      ownerUserId === undefined
        ? 'SELECT platform FROM accounts WHERE id = ?'
        : 'SELECT platform FROM accounts WHERE id = ? AND owner_user_id = ?',
    )
    .get(...(ownerUserId === undefined ? [id] : [id, ownerUserId])) as
    | { platform: string }
    | undefined
  if (!account) throw notFound('编译系统账号')
  if (account.platform !== 'build') throw conflict('仓库只能关联编译平台账号')
  return id
}
