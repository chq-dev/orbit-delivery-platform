import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDatabase } from '../db/database.js'
import { config } from '../config.js'
import { AppError } from '../domain/errors.js'
import { assertFeishuIngestAuthorized } from '../security/ingestAuth.js'
import { CredentialVault } from '../security/vault.js'
import { createAccount } from '../services/accountService.js'
import { bootstrapFeishuIntegration } from '../services/feishuBootstrapService.js'
import { ingestFeishuWorkItems } from '../services/feishuIngestService.js'
import { getFeishuStatus } from '../services/feishuIntegrationService.js'
import { createRepository } from '../services/repositoryService.js'
import { listWorkItems } from '../services/workItemService.js'

function setup() {
  const db = createDatabase({ filename: ':memory:' })
  const vault = new CredentialVault('ingest-test-vault-key-with-enough-length')
  const account = createAccount(db, vault, {
    platform: 'git',
    username: 'ingest-test',
    password: 'ingest-test-password',
    label: '同步测试账号',
  })
  const repository = createRepository(db, {
    name: 'sme-main',
    url: 'http://cloudgit.rj.link/sme/ingest-test.git',
    branch: 'dev-harvey',
    localPath: '',
    language: 'Vue 3 + Lua',
    accountId: account.id,
  })
  return { db, repository }
}

test('外部同步批量写入工作项并按 externalId 幂等更新', () => {
  const { db, repository } = setup()
  const first = ingestFeishuWorkItems(db, {
    projectKey: 'rjcloud',
    repoId: repository.id,
    items: [
      {
        externalId: 'rjcloud:story:101',
        type: 'requirement',
        title: '实时需求',
        description: '来自 Meegle CLI 的需求',
        priority: '高',
        owner: 'Alice',
        updatedAt: '2026-10-29T01:00:00.000Z',
      },
      {
        externalId: 'rjcloud:issue:201',
        type: 'defect',
        title: '实时缺陷',
        description: '来自 Meegle CLI 的缺陷',
        priority: '紧急',
        owner: 'Bob',
        updatedAt: '2026-10-29T02:00:00.000Z',
      },
    ],
  })

  assert.deepEqual(
    { fetched: first.fetched, created: first.created, updated: first.updated, skipped: first.skipped },
    { fetched: 2, created: 2, updated: 0, skipped: 0 },
  )
  assert.equal(listWorkItems(db).length, 2)
  assert.equal(listWorkItems(db).every((item) => item.source === 'feishu'), true)

  const second = ingestFeishuWorkItems(db, {
    projectKey: 'rjcloud',
    repoId: repository.id,
    items: [
      {
        externalId: 'rjcloud:story:101',
        type: 'requirement',
        title: '实时需求（已更新）',
        description: '更新后的描述',
        priority: '中',
        owner: 'Alice',
        updatedAt: '2026-10-29T03:00:00.000Z',
      },
    ],
  })

  assert.equal(second.created, 0)
  assert.equal(second.updated, 1)
  assert.equal(listWorkItems(db).length, 2)
  assert.equal(
    listWorkItems(db).find((item) => item.externalId === 'rjcloud:story:101')?.title,
    '实时需求（已更新）',
  )

  const status = getFeishuStatus(db)
  assert.equal(status.connected, true)
  assert.equal(status.authMode, 'cli')
  assert.equal(status.projectKey, 'rjcloud')
  assert.match(status.lastSyncMessage ?? '', /外部 Meegle CLI/)
  db.close()
})

test('外部同步拒绝非法工作项类型', () => {
  const { db, repository } = setup()
  assert.throws(
    () =>
      ingestFeishuWorkItems(db, {
        projectKey: 'rjcloud',
        repoId: repository.id,
        items: [
          {
            externalId: 'rjcloud:other:1',
            type: 'other',
            title: '非法类型',
            priority: '高',
            owner: 'Alice',
          },
        ],
      }),
    (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR',
  )
  db.close()
})

test('外部同步模式下启动流程不会误触发后端直连同步', async () => {
  const { db, repository } = setup()
  ingestFeishuWorkItems(db, {
    projectKey: 'rjcloud',
    repoId: repository.id,
    items: [
      {
        externalId: 'rjcloud:story:301',
        type: 'requirement',
        title: '启动回归需求',
        description: '用于验证外部同步不会被后端直连逻辑覆盖',
        priority: '中',
        owner: 'Alice',
        updatedAt: '2026-10-29T04:00:00.000Z',
      },
    ],
  })

  const originalConfig = { ...config }
  Object.assign(config, {
    feishuAutoSync: true,
    feishuAccessToken: '',
    feishuPluginId: '',
    feishuPluginSecret: '',
    feishuUserKey: '',
  })
  try {
    const result = await bootstrapFeishuIntegration(
      db,
      new CredentialVault('ingest-test-vault-key-with-enough-length'),
    )
    assert.equal(result.connected, true)
    assert.equal(result.configuredFromEnvironment, false)
    assert.equal(result.sync, undefined)
  } finally {
    Object.assign(config, originalConfig)
    db.close()
  }
})

test('Ingest 接口默认只允许本机回环，远程必须携带 Token', () => {
  assert.doesNotThrow(() =>
    assertFeishuIngestAuthorized({ headers: {}, ip: '127.0.0.1' }, ''),
  )
  assert.throws(
    () => assertFeishuIngestAuthorized({ headers: {}, ip: '10.0.0.8' }, ''),
    (error: unknown) =>
      error instanceof AppError && error.code === 'FEISHU_INGEST_TOKEN_NOT_CONFIGURED',
  )
  assert.throws(
    () =>
      assertFeishuIngestAuthorized(
        { headers: { authorization: 'Bearer wrong' }, ip: '10.0.0.8' },
        'correct-token',
      ),
    (error: unknown) => error instanceof AppError && error.code === 'FEISHU_INGEST_UNAUTHORIZED',
  )
  assert.throws(
    () =>
      assertFeishuIngestAuthorized(
        { headers: { 'x-forwarded-for': '10.0.0.8' }, ip: '127.0.0.1' },
        '',
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === 'FEISHU_INGEST_TOKEN_NOT_CONFIGURED',
  )
  assert.doesNotThrow(() =>
    assertFeishuIngestAuthorized(
      { headers: { authorization: 'Bearer correct-token' }, ip: '10.0.0.8' },
      'correct-token',
    ),
  )
})
