import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createDatabase, type AppDatabase } from '../db/database.js'
import { AppError } from '../domain/errors.js'
import { CredentialVault } from '../security/vault.js'
import { createAccount, listAccounts } from '../services/accountService.js'
import {
  advancePipeline,
  getPipeline,
  startPipeline,
} from '../services/pipelineService.js'
import { listTestReports } from '../services/reportService.js'
import {
  createRepository,
  listRepositories,
} from '../services/repositoryService.js'
import { createWorkItem, getWorkItem } from '../services/workItemService.js'

const vaultKey = 'test-vault-key-with-enough-length'
const tempDir = mkdtempSync(join(tmpdir(), 'orbit-test-'))
let db: AppDatabase
let vault: CredentialVault
let accountId: string
let repositoryId: string
let workItemId: string

before(() => {
  db = createDatabase({
    filename: join(tempDir, 'orbit.db'),
  })
  vault = new CredentialVault(vaultKey)
})

after(() => {
  db.close()
  rmSync(tempDir, { recursive: true, force: true })
})

test('新数据库只建表，不包含预置业务数据', () => {
  const emptyDb = createDatabase({ filename: ':memory:' })
  const tables = ['accounts', 'repositories', 'work_items', 'pipelines', 'test_reports', 'feishu_inbox']
  for (const table of tables) {
    const row = emptyDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
    assert.equal(row.count, 0, `${table} 应为空`)
  }
  emptyDb.close()
})

test('账号凭据加密存储且列表不泄露密文', () => {
  const account = createAccount(db, vault, {
    platform: 'git',
    username: 'test.user',
    password: 'super-secret-7K2m',
    label: '测试账号',
  })
  accountId = account.id

  assert.equal(account.secretHint, '••••••••7K2m')
  assert.equal('password' in account, false)

  const raw = db
    .prepare('SELECT secret_ciphertext, secret_iv, secret_tag FROM accounts WHERE id = ?')
    .get(account.id) as { secret_ciphertext: string; secret_iv: string; secret_tag: string }
  assert.notEqual(raw.secret_ciphertext, 'super-secret-7K2m')
  assert.ok(raw.secret_iv)
  assert.ok(raw.secret_tag)

  const listed = listAccounts(db)
  assert.equal(listed[0].username, 'test.user')
  assert.equal(Object.keys(listed[0]).includes('secretCiphertext'), false)
})

test('重复账号与重复仓库会被业务规则拦截', () => {
  assert.throws(
    () =>
      createAccount(db, vault, {
        platform: 'git',
        username: 'test.user',
        password: 'another-secret',
        label: '重复账号',
      }),
    (error: unknown) => error instanceof AppError && error.statusCode === 409,
  )

  const repository = createRepository(db, {
    name: 'sme-main',
    url: 'http://cloudgit.rj.link/sme/sme-main.git',
    branch: 'develop',
    language: 'Vue 3 + Lua',
    accountId,
  })
  repositoryId = repository.id

  assert.throws(
    () =>
      createRepository(db, {
        name: 'duplicate',
        url: 'http://cloudgit.rj.link/sme/sme-main.git',
        branch: 'develop',
        language: 'Vue 3 + Lua',
        accountId,
      }),
    (error: unknown) => error instanceof AppError && error.statusCode === 409,
  )
  assert.equal(listRepositories(db).length, 1)
})

test('缺陷交付完成九个阶段并自动关闭、归档三类报告', () => {
  const workItem = createWorkItem(db, {
    type: 'defect',
    title: '升级后端口掉电',
    description: '验证流水线状态机与事务更新',
    priority: '紧急',
    repoId: repositoryId,
    owner: '测试员',
  })
  workItemId = workItem.id

  const started = startPipeline(db, {
    workItemId,
    repoId: repositoryId,
    autoCommit: true,
    autoClose: true,
    triggeredBy: '测试员',
  })
  assert.equal(started.status, 'running')
  assert.equal(started.progress, 8)
  assert.equal(started.stages.filter((stage) => stage.status === 'running').length, 1)
  assert.equal(getWorkItem(db, workItemId).status, '进行中')

  assert.throws(
    () => startPipeline(db, { workItemId, repoId: repositoryId }),
    (error: unknown) => error instanceof AppError && error.statusCode === 409,
  )

  for (let index = 0; index < 9; index += 1) advancePipeline(db, started.id)

  const completed = getPipeline(db, started.id)
  assert.equal(completed.status, 'success')
  assert.equal(completed.progress, 100)
  assert.equal(completed.currentStage, 9)
  assert.equal(completed.stages.every((stage) => stage.status === 'success'), true)
  assert.ok(completed.designReport)
  assert.ok(completed.integrationReport)
  assert.equal(completed.designReport?.sections.length, 4)
  assert.equal(completed.integrationReport?.sections.length, 4)

  const reports = listTestReports(db)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].pipelineId, started.id)
  assert.equal(reports[0].total, 426)
  assert.equal(reports[0].suites.length, 4)
  assert.equal(getWorkItem(db, workItemId).status, '已关闭')

  const repository = listRepositories(db)[0]
  assert.equal(repository.latestVersion, completed.version)
})

test('流水线记录可在数据库重启后恢复', () => {
  const completed = listTestReports(db)[0]
  assert.ok(completed)

  const reopened = createDatabase({
    filename: join(tempDir, 'orbit.db'),
  })
  const restored = listTestReports(reopened)
  assert.equal(restored[0].id, completed.id)
  reopened.close()
})
