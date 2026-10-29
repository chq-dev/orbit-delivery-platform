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
import { readFeishuSnapshotFromDatabase } from '../services/feishuSnapshotService.js'
import { importWorkItems, listWorkItems } from '../services/workItemService.js'

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

  const snapshot = readFeishuSnapshotFromDatabase(db, 'rjcloud')
  assert.ok(snapshot)
  assert.equal(snapshot.items.length, 2)
  assert.equal(
    snapshot.items.find((item) => item.externalId === 'rjcloud:story:101')?.title,
    '实时需求（已更新）',
  )
  db.close()
})

test('不同 project key 前缀的同一飞书工作项不会重复写入', () => {
  const { db, repository } = setup()
  importWorkItems(db, [
    {
      type: 'requirement',
      title: '旧格式需求',
      description: '旧格式 externalId',
      priority: '中',
      repoId: repository.id,
      owner: 'Alice',
      source: 'feishu',
      externalId: '66e039485659e0b44ce1d589:story:6955195522',
    },
  ])

  const result = ingestFeishuWorkItems(db, {
    projectKey: 'rjcloud',
    repoId: repository.id,
    items: [
      {
        externalId: 'rjcloud:story:6955195522',
        type: 'requirement',
        title: '实时同步后的需求',
        description: '相同工作项 ID，不同 project key 前缀',
        priority: '高',
        owner: 'Alice',
        updatedAt: '2026-10-29T02:00:00.000Z',
      },
    ],
  })

  assert.equal(result.created, 0)
  assert.equal(result.updated, 1)
  const items = listWorkItems(db)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '实时同步后的需求')
  db.close()
})

test('外部同步映射飞书状态并保留平台交付状态', () => {
  const { db, repository } = setup()
  const item = {
    externalId: 'rjcloud:story:301',
    type: 'requirement',
    title: '状态同步需求',
    description: '状态同步描述',
    priority: '高',
    owner: 'Alice',
    updatedAt: '2026-10-29T01:00:00.000Z',
    status: '已交付',
    feishuStatus: '已测试',
  }
  ingestFeishuWorkItems(db, {
    projectKey: 'rjcloud',
    repoId: repository.id,
    items: [item],
  })

  const first = listWorkItems(db).find((entry) => entry.externalId === item.externalId)
  assert.equal(first?.status, '已交付')
  assert.equal(first?.feishuStatus, '已测试')

  ingestFeishuWorkItems(db, {
    projectKey: 'rjcloud',
    repoId: repository.id,
    items: [{ ...item, status: '进行中', feishuStatus: '测试中' }],
  })
  const preserved = listWorkItems(db).find((entry) => entry.externalId === item.externalId)
  assert.equal(preserved?.status, '已交付')
  assert.equal(preserved?.feishuStatus, '测试中')

  ingestFeishuWorkItems(db, {
    projectKey: 'rjcloud',
    repoId: repository.id,
    items: [{ ...item, status: '已关闭', feishuStatus: '已拒绝' }],
  })
  const closed = listWorkItems(db).find((entry) => entry.externalId === item.externalId)
  assert.equal(closed?.status, '已关闭')
  assert.equal(closed?.feishuStatus, '已拒绝')

  ingestFeishuWorkItems(db, {
    projectKey: 'rjcloud',
    repoId: repository.id,
    items: [
      {
        ...item,
        externalId: 'rjcloud:issue:302',
        type: 'defect',
        status: '进行中',
        feishuStatus: '接受处理',
      },
    ],
  })
  const inProgress = listWorkItems(db).find(
    (entry) => entry.externalId === 'rjcloud:issue:302',
  )
  assert.equal(inProgress?.status, '进行中')
  assert.equal(inProgress?.feishuStatus, '接受处理')
  db.close()
})

test('完整同步对账会归档飞书已删除项，并在重新出现时恢复', () => {
  const { db, repository } = setup()
  ingestFeishuWorkItems(db, {
    projectKey: 'rjcloud',
    repoId: repository.id,
    items: [
      {
        externalId: 'rjcloud:story:401',
        type: 'requirement',
        title: '保留的需求',
        description: '仍存在于飞书',
        priority: '高',
        owner: 'Alice',
        updatedAt: '2026-10-29T01:00:00.000Z',
      },
      {
        externalId: 'rjcloud:story:402',
        type: 'requirement',
        title: '已删除的需求',
        description: '已经从飞书删除',
        priority: '中',
        owner: 'Bob',
        updatedAt: '2026-10-29T02:00:00.000Z',
      },
    ],
  })

  const reconciled = ingestFeishuWorkItems(db, {
    projectKey: 'rjcloud',
    repoId: repository.id,
    items: [],
    reconcile: true,
    activeExternalIds: ['rjcloud:story:401'],
  })
  assert.equal(reconciled.archived, 1)
  assert.equal(listWorkItems(db).length, 1)
  assert.equal(
    listWorkItems(db).some((item) => item.externalId === 'rjcloud:story:402'),
    false,
  )
  const archived = db
    .prepare(
      "SELECT archived_at FROM work_items WHERE external_id = 'rjcloud:story:402'",
    )
    .get() as { archived_at: string | null }
  assert.equal(typeof archived.archived_at, 'string')
  assert.equal(readFeishuSnapshotFromDatabase(db, 'rjcloud')?.items.length, 1)

  const restored = ingestFeishuWorkItems(db, {
    projectKey: 'rjcloud',
    repoId: repository.id,
    items: [
      {
        externalId: 'rjcloud:story:402',
        type: 'requirement',
        title: '重新出现的数据',
        description: '飞书恢复或重新创建',
        priority: '紧急',
        owner: 'Bob',
        updatedAt: '2026-10-29T03:00:00.000Z',
      },
    ],
    reconcile: true,
    activeExternalIds: ['rjcloud:story:401', 'rjcloud:story:402'],
  })
  assert.equal(restored.archived, 0)
  assert.equal(listWorkItems(db).length, 2)
  const active = db
    .prepare(
      "SELECT archived_at, title FROM work_items WHERE external_id = 'rjcloud:story:402'",
    )
    .get() as { archived_at: string | null; title: string }
  assert.equal(active.archived_at, null)
  assert.equal(active.title, '重新出现的数据')
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
