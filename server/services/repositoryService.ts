import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { AppDatabase } from '../db/database.js'
import { nextSequence } from '../db/sequences.js'
import { conflict, notFound, unprocessable } from '../domain/errors.js'
import { formatDisplayTime, nowIso } from '../domain/time.js'
import type { Repository, RepositoryStatus } from '../domain/types.js'
import { httpUrl, optionalText, requiredText } from '../domain/validation.js'

interface RepositoryRow {
  id: string
  name: string
  url: string
  branch: string
  local_path: string
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
  language: unknown
  accountId: unknown
}

export interface RepositoryUpdateInput {
  branch?: unknown
  localPath?: unknown
}

function rowToRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    branch: row.branch,
    localPath: row.local_path,
    language: row.language,
    accountId: row.account_id,
    lastSync: formatDisplayTime(row.last_sync),
    status: row.status,
    latestVersion: row.latest_version,
  }
}

export function listRepositories(db: AppDatabase): Repository[] {
  const rows = db
    .prepare(
      `SELECT id, name, url, branch, local_path, language, account_id, last_sync, status, latest_version
       FROM repositories ORDER BY created_at ASC, id ASC`,
    )
    .all() as RepositoryRow[]
  return rows.map(rowToRepository)
}

export function getRepository(db: AppDatabase, id: string): Repository {
  const row = db
    .prepare(
      `SELECT id, name, url, branch, local_path, language, account_id, last_sync, status, latest_version
       FROM repositories WHERE id = ?`,
    )
    .get(id) as RepositoryRow | undefined
  if (!row) throw notFound('代码仓库')
  return rowToRepository(row)
}

export function createRepository(db: AppDatabase, input: RepositoryInput): Repository {
  const name = requiredText(input.name, '仓库名称', { max: 200 })
  const url = httpUrl(input.url, '仓库地址')
  const branch = requiredText(input.branch, '默认分支', { max: 200 })
  const localPath = normalizeLocalPath(input.localPath)
  const language = optionalText(input.language, '开发语言', 100) ?? 'Vue 3 + Lua'
  const accountId = requiredText(input.accountId, 'Git 账号', { max: 200 })

  const account = db
    .prepare('SELECT platform FROM accounts WHERE id = ?')
    .get(accountId) as { platform: string } | undefined
  if (!account) throw notFound('Git 账号')
  if (account.platform !== 'git') throw conflict('仓库只能关联 Git 平台账号')

  const duplicate = db.prepare('SELECT id FROM repositories WHERE url = ?').get(url) as
    | { id: string }
    | undefined
  if (duplicate) throw conflict('该仓库地址已接入')

  const now = nowIso()
  const id = `repo-${nextSequence(db, 'repository', 1)}`
  db.prepare(
    `INSERT INTO repositories
      (id, name, url, branch, local_path, language, account_id, last_sync, status, latest_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'healthy', '待构建', ?, ?)`,
  ).run(id, name, url, branch, localPath, language, accountId, now, now, now)

  return getRepository(db, id)
}

export function updateRepositorySettings(
  db: AppDatabase,
  id: string,
  input: RepositoryUpdateInput,
): Repository {
  const repository = db
    .prepare('SELECT id, branch, local_path FROM repositories WHERE id = ?')
    .get(id) as { id: string; branch: string; local_path: string } | undefined
  if (!repository) throw notFound('代码仓库')

  const branch = input.branch === undefined
    ? repository.branch
    : requiredText(input.branch, '默认管理分支', { max: 200 })
  const localPath = input.localPath === undefined
    ? repository.local_path
    : normalizeLocalPath(input.localPath)

  db.transaction(() => {
    db.prepare(
      'UPDATE repositories SET branch = ?, local_path = ?, updated_at = ? WHERE id = ?',
    ).run(
      branch,
      localPath,
      nowIso(),
      id,
    )
    db.prepare('UPDATE work_items SET branch = ? WHERE repo_id = ?').run(branch, id)
  })()

  return getRepository(db, id)
}

function normalizeLocalPath(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  const localPath = requiredText(value, '本地代码路径', { max: 1_000 })
  if (!isAbsolute(localPath)) throw unprocessable('本地代码路径必须是绝对路径')
  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
    throw unprocessable('本地代码路径不存在或不是目录')
  }
  return localPath
}
