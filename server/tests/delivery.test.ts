import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createDatabase, type AppDatabase } from '../db/database.js'
import { AppError } from '../domain/errors.js'
import { CredentialVault } from '../security/vault.js'
import { createAccount, listAccounts } from '../services/accountService.js'
import {
  connectFeishu,
  getFeishuStatus,
  handleFeishuEvent,
  syncFeishu,
} from '../services/feishuIntegrationService.js'
import {
  advancePipeline,
  getPipeline,
  startPipeline,
} from '../services/pipelineService.js'
import { recordLocalDelivery } from '../services/localDeliveryService.js'
import { listTestReports } from '../services/reportService.js'
import {
  createRepository,
  listRepositories,
  updateRepositorySettings,
} from '../services/repositoryService.js'
import {
  createWorkItem,
  getWorkItem,
  importWorkItems,
  listWorkItems,
} from '../services/workItemService.js'

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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

test('新数据库只建表，不包含预置业务数据', () => {
  const emptyDb = createDatabase({ filename: ':memory:' })
  const tables = [
    'accounts',
    'repositories',
    'work_items',
    'pipelines',
    'test_reports',
    'feishu_inbox',
    'feishu_integrations',
    'feishu_sync_logs',
    'feishu_access_tokens',
    'feishu_event_dedup',
    'feishu_sync_credentials',
    'feishu_agent_state',
    'feishu_agent_commands',
    'feishu_outbox',
  ]
  for (const table of tables) {
    const row = emptyDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
    assert.equal(row.count, 0, `${table} 应为空`)
  }
  assert.deepEqual(getFeishuStatus(emptyDb), {
    connected: false,
    webhookConfigured: false,
    eventPath: '/api/integrations/feishu/events',
  })
  emptyDb.close()
})

test('旧版数据库升级后可使用抓包 Token 存储', () => {
  const filename = join(tempDir, 'upgrade-v2.db')
  const oldDb = createDatabase({ filename })
  oldDb.exec('DROP TABLE feishu_access_tokens; PRAGMA user_version = 2;')
  oldDb.close()

  const upgraded = createDatabase({ filename })
  assert.equal(upgraded.pragma('user_version', { simple: true }), 11)
  const table = upgraded
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get('feishu_access_tokens') as { count: number }
  assert.equal(table.count, 1)
  const repositoryColumns = upgraded.pragma('table_info(repositories)') as { name: string }[]
  const pipelineColumns = upgraded.pragma('table_info(pipelines)') as { name: string }[]
  const workItemColumns = upgraded.pragma('table_info(work_items)') as { name: string }[]
  const syncTokenTable = upgraded
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get('feishu_sync_credentials') as { count: number }
  assert.equal(repositoryColumns.some((column) => column.name === 'local_path'), true)
  assert.equal(pipelineColumns.some((column) => column.name === 'local_path'), true)
  assert.equal(workItemColumns.some((column) => column.name === 'archived_at'), true)
  assert.equal(workItemColumns.some((column) => column.name === 'project_line'), true)
  assert.equal(syncTokenTable.count, 1)
  upgraded.close()
})

test('版本 6 数据库升级后会创建飞书同步密钥表', () => {
  const filename = join(tempDir, 'upgrade-v6-sync-token.db')
  const oldDb = createDatabase({ filename })
  oldDb.exec('DROP TABLE feishu_sync_credentials; PRAGMA user_version = 6;')
  oldDb.close()

  const upgraded = createDatabase({ filename })
  assert.equal(upgraded.pragma('user_version', { simple: true }), 11)
  const table = upgraded
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get('feishu_sync_credentials') as { count: number }
  assert.equal(table.count, 1)
  upgraded.close()
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

test('仓库分支与本地路径可修改并同步到关联工作项', () => {
  const item = createWorkItem(db, {
    type: 'requirement',
    title: '分支修改回归',
    description: '验证默认分支修改后工作项同步更新',
    priority: '中',
    repoId: repositoryId,
    owner: '测试员',
  })

  const updated = updateRepositorySettings(db, repositoryId, { branch: 'release/v12.0' })
  assert.equal(updated.branch, 'release/v12.0')
  assert.equal(getWorkItem(db, item.id).branch, 'release/v12.0')

  assert.throws(
    () => updateRepositorySettings(db, repositoryId, { branch: '   ' }),
    (error: unknown) => error instanceof AppError && error.statusCode === 422,
  )
  assert.throws(
    () => updateRepositorySettings(db, 'repo-missing', { branch: 'develop' }),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  )

  const withPath = updateRepositorySettings(db, repositoryId, { localPath: tempDir })
  assert.equal(withPath.localPath, tempDir)
  assert.throws(
    () => updateRepositorySettings(db, repositoryId, { localPath: 'relative/path' }),
    (error: unknown) => error instanceof AppError && error.statusCode === 422,
  )
  const clientPath = join(tempDir, 'missing-client-checkout')
  const withClientPath = updateRepositorySettings(db, repositoryId, { localPath: clientPath })
  assert.equal(withClientPath.localPath, clientPath)

  updateRepositorySettings(db, repositoryId, { branch: 'develop', localPath: '' })
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
  assert.equal(started.clientExecuted, false)
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

test('配置本地路径后执行真实提交并在验收通过后推送分支', () => {
  const gitRoot = mkdtempSync(join(tempDir, 'git-fixture-'))
  const remotePath = join(gitRoot, 'remote.git')
  const workPath = join(gitRoot, 'work')

  git(gitRoot, ['init', '--bare', remotePath])
  git(gitRoot, ['init', '-b', 'main', workPath])
  git(workPath, ['config', 'user.name', 'Orbit Test'])
  git(workPath, ['config', 'user.email', 'orbit-test@example.com'])
  writeFileSync(join(workPath, 'README.md'), '# fixture\n')
  git(workPath, ['add', '-A'])
  git(workPath, ['commit', '-m', 'initial commit'])
  git(workPath, ['remote', 'add', 'origin', remotePath])
  git(workPath, ['push', '-u', 'origin', 'main'])

  const repository = createRepository(db, {
    name: 'local-git-fixture',
    url: 'http://cloudgit.rj.link/sme/local-git-fixture.git',
    branch: 'main',
    localPath: workPath,
    language: 'TypeScript',
    accountId,
  })
  const item = createWorkItem(db, {
    type: 'requirement',
    title: '本地路径真实提交',
    description: '验证流水线使用配置的本地路径提交并推送',
    priority: '高',
    repoId: repository.id,
    owner: '测试员',
  })

  const initialHead = git(workPath, ['rev-parse', 'HEAD'])
  const started = startPipeline(db, {
    workItemId: item.id,
    repoId: repository.id,
    autoCommit: true,
    autoClose: true,
    triggeredBy: '测试员',
  })
  assert.equal(started.localPath, workPath)
  assert.equal(started.simulation, false)
  assert.equal(started.commit, initialHead.slice(0, 8))

  writeFileSync(join(workPath, 'feature.txt'), 'delivery change\n')
  for (let index = 0; index < 9; index += 1) advancePipeline(db, started.id)

  const completed = getPipeline(db, started.id)
  assert.equal(completed.status, 'success')
  assert.equal(completed.simulation, false)
  assert.notEqual(completed.commit, initialHead.slice(0, 8))
  assert.equal(git(workPath, ['rev-parse', 'HEAD']), completed.commit)
  assert.equal(git(workPath, ['log', '-1', '--format=%s']), `${item.id}: ${item.title}`)
  assert.equal(
    execFileSync('git', ['--git-dir', remotePath, 'rev-parse', 'main'], {
      encoding: 'utf8',
    }).trim(),
    completed.commit,
  )
  assert.match(completed.stages[8].log ?? '', /已推送至 origin\/main/)
})

test('客户端本地交付结果可回写平台并更新工作项', () => {
  const item = createWorkItem(db, {
    type: 'requirement',
    title: '客户端本地交付回写',
    description: '验证客户端脚本完成后回写真实 commit',
    priority: '中',
    repoId: repositoryId,
    owner: '测试员',
  })
  const commit = 'abcdef1234567890abcdef1234567890abcdef12'
  const run = recordLocalDelivery(db, {
    workItemId: item.id,
    repoId: repositoryId,
    branch: 'develop',
    localPath: '/Users/chenhuaqu/sme/sme-main',
    commit,
    autoClose: false,
    pushed: true,
    summary: '客户端验证与测试完成',
    stageResults: [
      { index: 0, status: 'success', log: '真实解析需求' },
      { index: 1, status: 'success', log: '真实生成设计报告' },
      { index: 2, status: 'success', log: '真实修改代码' },
      { index: 3, status: 'success', log: '真实完成集成验证' },
      { index: 4, status: 'success', log: '真实创建提交' },
    ],
  })

  assert.equal(run.status, 'success')
  assert.equal(run.progress, 100)
  assert.equal(run.commit, commit)
  assert.equal(run.localPath, '/Users/chenhuaqu/sme/sme-main')
  assert.equal(run.simulation, false)
  assert.equal(run.clientExecuted, true)
  assert.equal(run.stages.length, 9)
  assert.equal(run.stages.slice(0, 5).every((stage) => stage.status === 'success'), true)
  assert.equal(run.stages.slice(5).every((stage) => stage.status === 'pending'), true)
  assert.match(run.stages[4].log ?? '', /已推送至 origin\/develop/)
  assert.equal(getWorkItem(db, item.id).status, '已交付')
})

test('拒绝缺少真实代码与提交证据的本地交付回写', () => {
  const item = createWorkItem(db, {
    type: 'requirement',
    title: '拒绝伪造交付',
    description: '验证平台不会默认把未执行阶段记为成功',
    priority: '中',
    repoId: repositoryId,
    owner: '测试员',
  })
  assert.throws(
    () =>
      recordLocalDelivery(db, {
        workItemId: item.id,
        repoId: repositoryId,
        branch: 'develop',
        localPath: '/Users/chenhuaqu/sme/sme-main',
        commit: 'fedcba9876543210fedcba9876543210fedcba98',
      }),
    (error: unknown) => error instanceof AppError && error.statusCode === 422,
  )
  assert.throws(
    () =>
      recordLocalDelivery(db, {
        workItemId: item.id,
        repoId: repositoryId,
        branch: 'develop',
        localPath: '/Users/chenhuaqu/sme/sme-main',
        commit: 'fedcba9876543210fedcba9876543210fedcba98',
        stageResults: [
          { index: 0, status: 'success', log: '解析' },
          { index: 2, status: 'pending', log: '没有代码变更' },
          { index: 4, status: 'success', log: '提交' },
        ],
      }),
    (error: unknown) => error instanceof AppError && error.statusCode === 422,
  )
})

test('客户端本地交付只记录实际证据并保存真实报告', () => {
  const item = createWorkItem(db, {
    type: 'requirement',
    title: '客户端证据回写',
    description: '验证阶段状态与报告来自本机真实执行结果',
    priority: '中',
    repoId: repositoryId,
    owner: '测试员',
  })
  const run = recordLocalDelivery(db, {
    workItemId: item.id,
    repoId: repositoryId,
    branch: 'develop',
    localPath: '/Users/chenhuaqu/sme/sme-main',
    commit: '1234567890abcdef1234567890abcdef12345678',
    pushed: false,
    stageResults: [
      { index: 0, status: 'success', log: '真实完成需求分析' },
      { index: 1, status: 'success', log: '真实生成设计报告' },
      { index: 2, status: 'success', log: '真实修改 3 个代码文件' },
      { index: 3, status: 'success', log: '真实执行集成检查' },
      { index: 4, status: 'success', log: '真实创建提交' },
      { index: 5, status: 'pending', log: '未执行构建' },
      { index: 6, status: 'pending', log: '未执行升级' },
      { index: 7, status: 'success', log: '真实执行测试' },
      { index: 8, status: 'success', log: '真实归档测试报告' },
    ],
    reports: {
      design: {
        title: '开发设计报告',
        summary: '真实设计摘要',
        content: '# 设计\n\n真实内容',
      },
    },
  })

  assert.equal(run.stages[2].log, '真实修改 3 个代码文件')
  assert.equal(run.stages[5].status, 'pending')
  assert.equal(run.designReport?.summary, '真实设计摘要')
  assert.match(run.designReport?.sections[0].content ?? '', /真实内容/)
})

test('飞书绑定状态、Webhook 验签和缺陷关闭回写队列', () => {
  const pluginSecret = 'feishu-plugin-secret-test'
  const webhookSecret = 'feishu-webhook-secret-test'
  const encryptedPlugin = vault.encrypt(pluginSecret)
  const encryptedWebhook = vault.encrypt(webhookSecret)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO feishu_integrations
      (id, project_key, plugin_id, plugin_secret_ciphertext, plugin_secret_iv,
       plugin_secret_tag, plugin_secret_hint, user_key, default_repo_id,
       requirement_type_key, defect_type_key, default_owner, close_transition_id,
       webhook_secret_ciphertext, webhook_secret_iv, webhook_secret_tag,
       webhook_secret_hint, status, created_at, updated_at)
     VALUES ('feishu-main', 'rjcloud', 'plug-test', ?, ?, ?, ?, 'user-test', ?,
             'story', 'issue', '飞书同步', '123456', ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    encryptedPlugin.ciphertext,
    encryptedPlugin.iv,
    encryptedPlugin.tag,
    vault.hint(pluginSecret),
    repositoryId,
    encryptedWebhook.ciphertext,
    encryptedWebhook.iv,
    encryptedWebhook.tag,
    vault.hint(webhookSecret),
    now,
    now,
  )

  const status = getFeishuStatus(db)
  assert.equal(status.connected, true)
  assert.equal(status.projectKey, 'rjcloud')
  assert.equal(status.pluginSecretHint, '••••••••test')
  assert.equal(status.webhookConfigured, true)
  assert.equal('pluginSecret' in status, false)
  assert.equal('webhookSecret' in status, false)

  const requestTime = Date.now()
  const signature = createHash('sha256')
    .update(`plug-test${requestTime}${webhookSecret}`)
    .digest('hex')
  const challengeBody = {
    challenge: 'feishu-challenge',
    request_time: requestTime,
    signature,
  }
  const rawBody = Buffer.from(JSON.stringify(challengeBody))
  const challenge = handleFeishuEvent(db, vault, challengeBody, rawBody, {})
  assert.equal(challenge.challenge, 'feishu-challenge')

  const invalidBody = { ...challengeBody, signature: 'invalid-signature' }
  assert.throws(
    () =>
      handleFeishuEvent(
        db,
        vault,
        invalidBody,
        Buffer.from(JSON.stringify(invalidBody)),
        {},
      ),
    (error: unknown) => error instanceof AppError && error.statusCode === 401,
  )

  const imported = importWorkItems(db, [
    {
      type: 'defect',
      title: '飞书缺陷关闭回写',
      description: '验证交付完成后写入飞书回写队列',
      priority: '高',
      repoId: repositoryId,
      owner: '飞书同步',
      source: 'feishu',
      externalId: 'rjcloud:issue:9001',
    },
  ])
  const feishuDefect = imported.items[0]
  const started = startPipeline(db, {
    workItemId: feishuDefect.id,
    repoId: repositoryId,
    autoCommit: true,
    autoClose: true,
    triggeredBy: '测试员',
  })
  for (let index = 0; index < 9; index += 1) advancePipeline(db, started.id)

  assert.equal(getWorkItem(db, feishuDefect.id).status, '已关闭')
  const outbox = db
    .prepare('SELECT external_id, action, status FROM feishu_outbox WHERE work_item_id = ?')
    .get(feishuDefect.id) as { external_id: string; action: string; status: string } | undefined
  assert.deepEqual(outbox, {
    external_id: 'rjcloud:issue:9001',
    action: 'close',
    status: 'pending',
  })
})

test('飞书连接配置会校验权限并加密保存凭据', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/open_api/authen/plugin_token')) {
      return new Response(
        JSON.stringify({ data: { token: 'connect-token', expire_time: 7200 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.endsWith('/open_api/projects/detail')) {
      return new Response(
        JSON.stringify({
          data: {
            rjcloud: { project_key: 'rjcloud', simple_name: 'rjcloud', name: 'RJ Cloud' },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('/open_api/rjcloud/work_item/') && url.endsWith('/meta')) {
      return new Response(JSON.stringify({ data: { fields: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.endsWith('/open_api/rjcloud/work_item/filter')) {
      const requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      const typeKey = Array.isArray(requestBody.work_item_type_keys)
        ? requestBody.work_item_type_keys[0]
        : ''
      return new Response(
        JSON.stringify({
          data:
            typeKey === 'story'
              ? [{ id: 101, name: '飞书需求' }]
              : [{ id: 201, name: '飞书缺陷' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.endsWith('/open_api/rjcloud/work_item/story/query')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 101,
              name: '飞书需求',
              description: '同步后的需求描述',
              priority: '高',
              owner: { user_key: 'alice' },
              updated_at: Date.now(),
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.endsWith('/open_api/rjcloud/work_item/issue/query')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 201,
              name: '飞书缺陷',
              fields: [
                { field_key: 'description', field_value: '同步后的缺陷描述' },
                { field_key: 'priority', field_value: 'P0' },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ error: { code: 404, msg: url } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const connected = await connectFeishu(db, vault, {
      pluginId: 'plug-connect',
      pluginSecret: 'connect-plugin-secret',
      userKey: 'connect-user',
      projectKey: 'rjcloud',
      defaultRepoId: repositoryId,
      requirementTypeKey: 'story',
      defectTypeKey: 'issue',
      defaultOwner: '飞书连接测试',
      closeTransitionId: '654321',
      webhookSecret: 'connect-callback-token',
    })
    assert.equal(connected.connected, true)
    assert.equal(connected.projectKey, 'rjcloud')
    assert.equal(connected.pluginSecretHint, '••••••••cret')
    assert.equal(connected.webhookConfigured, true)

    const row = db
      .prepare(
        `SELECT plugin_secret_ciphertext, webhook_secret_ciphertext, close_transition_id
         FROM feishu_integrations WHERE id = 'feishu-main'`,
      )
      .get() as {
      plugin_secret_ciphertext: string
      webhook_secret_ciphertext: string
      close_transition_id: string
    }
    assert.notEqual(row.plugin_secret_ciphertext, 'connect-plugin-secret')
    assert.notEqual(row.webhook_secret_ciphertext, 'connect-callback-token')
    assert.equal(row.close_transition_id, '654321')

    const updatedWithoutWebhookSecret = await connectFeishu(db, vault, {
      pluginId: 'plug-connect',
      pluginSecret: 'connect-plugin-secret',
      userKey: 'connect-user',
      projectKey: 'rjcloud',
      defaultRepoId: repositoryId,
      requirementTypeKey: 'story',
      defectTypeKey: 'issue',
      defaultOwner: '飞书连接测试',
      closeTransitionId: '654321',
      webhookSecret: '',
    })
    const preserved = db
      .prepare('SELECT webhook_secret_ciphertext FROM feishu_integrations WHERE id = ?')
      .get('feishu-main') as { webhook_secret_ciphertext: string }
    assert.equal(updatedWithoutWebhookSecret.webhookConfigured, true)
    assert.equal(preserved.webhook_secret_ciphertext, row.webhook_secret_ciphertext)

    const syncResult = await syncFeishu(db, vault, 'manual')
    assert.equal(syncResult.fetched, 2)
    assert.equal(syncResult.upserted, 2)
    assert.equal(syncResult.skipped, 0)

    const inbox = db
      .prepare('SELECT external_id, type, priority, owner FROM feishu_inbox ORDER BY external_id')
      .all() as Array<{
      external_id: string
      type: string
      priority: string
      owner: string
    }>
    assert.deepEqual(inbox, [
      { external_id: 'rjcloud:issue:201', type: 'defect', priority: '紧急', owner: '飞书连接测试' },
      {
        external_id: 'rjcloud:story:101',
        type: 'requirement',
        priority: '高',
        owner: 'alice',
      },
    ])
    const syncedWorkItems = listWorkItems(db).filter(
      (item) =>
        item.externalId === 'rjcloud:issue:201' || item.externalId === 'rjcloud:story:101',
    )
    assert.equal(syncedWorkItems.length, 2)
    assert.equal(syncedWorkItems.every((item) => item.source === 'feishu'), true)

    await syncFeishu(db, vault, 'manual')
    const afterRepeat = listWorkItems(db).filter(
      (item) =>
        item.externalId === 'rjcloud:issue:201' || item.externalId === 'rjcloud:story:101',
    )
    assert.equal(afterRepeat.length, 2)
    assert.equal(getFeishuStatus(db).lastSyncStatus, 'success')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('抓包访问 Token 可直接绑定、加密保存并同步工作项', async () => {
  const originalFetch = globalThis.fetch
  let tokenExchangeCalled = false
  const authorizationHeaders: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    if (headers.get('x-plugin-token')) authorizationHeaders.push(headers.get('x-plugin-token') ?? '')
    if (url.endsWith('/open_api/authen/plugin_token')) {
      tokenExchangeCalled = true
      return new Response(JSON.stringify({ error: { code: 500, msg: '不应换取 Token' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.endsWith('/open_api/projects/detail')) {
      return new Response(
        JSON.stringify({ data: { rjcloud: { project_key: 'rjcloud', name: 'RJ Cloud' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('/open_api/rjcloud/work_item/') && url.endsWith('/meta')) {
      return new Response(JSON.stringify({ data: { fields: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.endsWith('/open_api/rjcloud/work_item/filter')) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      const typeKey = Array.isArray(body.work_item_type_keys) ? body.work_item_type_keys[0] : ''
      return new Response(
        JSON.stringify({
          data: { work_items: typeKey === 'story' ? [{ id: 301, name: '抓包需求' }] : [] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.endsWith('/open_api/rjcloud/work_item/story/query')) {
      return new Response(
        JSON.stringify({
          data: { work_items: [{ id: 301, name: '抓包需求', priority: '中' }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ error: { code: 404, msg: url } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const connected = await connectFeishu(db, vault, {
      accessToken: 'captured-plugin-token',
      userKey: 'captured-user-key',
      projectKey: 'rjcloud',
      defaultRepoId: repositoryId,
      requirementTypeKey: 'story',
      defectTypeKey: 'issue',
      defaultOwner: '抓包同步',
    })
    assert.equal(connected.connected, true)
    assert.equal(connected.authMode, 'token')
    assert.equal(connected.accessTokenHint, '••••••••oken')
    assert.equal(connected.pluginSecretHint, undefined)
    assert.equal(tokenExchangeCalled, false)

    const raw = db
      .prepare('SELECT token_ciphertext FROM feishu_access_tokens WHERE integration_id = ?')
      .get('feishu-main') as { token_ciphertext: string }
    assert.notEqual(raw.token_ciphertext, 'captured-plugin-token')
    assert.ok(authorizationHeaders.length > 0)
    assert.ok(authorizationHeaders.every((value) => value === 'captured-plugin-token'))

    importWorkItems(db, [
      {
        type: 'requirement',
        title: '飞书侧已删除的旧需求',
        description: '用于验证每次同步都会独立执行删除对账',
        priority: '中',
        repoId: repositoryId,
        owner: '旧负责人',
        source: 'feishu',
        externalId: 'rjcloud:story:299',
      },
    ])
    const synced = await syncFeishu(db, vault, 'manual')
    assert.equal(synced.fetched, 1)
    assert.equal(synced.upserted, 1)
    assert.ok(synced.archived >= 1)
    assert.equal(tokenExchangeCalled, false)
    assert.equal(
      listWorkItems(db).some((item) => item.externalId === 'rjcloud:story:301'),
      true,
    )
    assert.equal(
      listWorkItems(db).some((item) => item.externalId === 'rjcloud:story:299'),
      false,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
