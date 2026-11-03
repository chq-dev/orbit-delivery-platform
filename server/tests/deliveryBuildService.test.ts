import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createDatabase } from '../db/database.js'
import { AppError } from '../domain/errors.js'
import { CredentialVault } from '../security/vault.js'
import { createAccount } from '../services/accountService.js'
import { triggerDeliveryBuild } from '../services/deliveryBuildService.js'
import { createRepository } from '../services/repositoryService.js'
import { createWorkItem } from '../services/workItemService.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function fixture(withBuildAccount: boolean) {
  const db = createDatabase({ filename: ':memory:' })
  const vault = new CredentialVault('delivery-build-service-test-key')
  const gitAccount = createAccount(db, vault, {
    platform: 'git',
    username: 'delivery.git',
    password: 'delivery-git-secret',
    label: 'Git 账号',
  })
  const repository = createRepository(db, {
    name: 'sme-main',
    url: 'https://git.example.com/sme/sme-main.git',
    branch: 'develop',
    language: 'Vue 3 + Lua',
    accountId: gitAccount.id,
  })
  const workItem = createWorkItem(db, {
    type: 'requirement',
    title: '交付流程内部编译',
    description: '验证交付流水线编译阶段触发 Jenkins',
    priority: '中',
    repoId: repository.id,
    owner: '测试员',
  })
  if (withBuildAccount) {
    createAccount(db, vault, {
      platform: 'build',
      username: 'jenkins.user',
      password: 'jenkins-token',
      label: 'Jenkins 编译账号',
      serviceUrl: 'https://jenkins.example.com/job/SME_DELIVERY/',
    })
  }
  return { db, vault, repository, workItem }
}

test('交付流程编译阶段复用内部编译并返回 Jenkins 队列', async () => {
  const { db, vault, repository, workItem } = fixture(true)
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/api/json')) {
      return Response.json({
        name: 'SME_DELIVERY',
        buildable: true,
        property: [
          {
            parameterDefinitions: [
              {
                name: 'BRANCHES',
                type: 'StringParameterDefinition',
                defaultParameterValue: { value: 'develop' },
              },
            ],
          },
        ],
      })
    }
    if (url.pathname === '/crumbIssuer/api/json') {
      return Response.json({ crumb: 'crumb', crumbRequestField: 'Jenkins-Crumb' })
    }
    if (init?.method === 'POST' && url.pathname.endsWith('/buildWithParameters')) {
      return new Response(null, { status: 201, headers: { location: '/queue/item/99/' } })
    }
    return new Response('unexpected request', { status: 500 })
  }) as typeof fetch

  const result = await triggerDeliveryBuild(db, vault, {
    workItemId: workItem.id,
    repoId: repository.id,
  })
  assert.equal(result.configured, true)
  assert.equal(result.triggered, true)
  assert.equal(result.build?.jobName, 'SME_DELIVERY')
  assert.equal(result.build?.queueUrl, 'https://jenkins.example.com/queue/item/99/')
  assert.match(result.message, /Jenkins 内部编译/)
  db.close()
})

test('未配置编译账号时交付流程保留编译阶段未执行', async () => {
  const { db, vault, repository, workItem } = fixture(false)
  const result = await triggerDeliveryBuild(db, vault, {
    workItemId: workItem.id,
    repoId: repository.id,
  })
  assert.deepEqual(result, {
    configured: false,
    triggered: false,
    message: '未配置带 Jenkins 服务地址的编译系统账号，编译阶段保持未执行',
  })
  db.close()
})

test('交付流程内部编译会校验工作项与仓库', async () => {
  const { db, vault, repository, workItem } = fixture(false)
  await assert.rejects(
    () => triggerDeliveryBuild(db, vault, { workItemId: 'REQ-MISSING', repoId: repository.id }),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  )
  await assert.rejects(
    () => triggerDeliveryBuild(db, vault, { workItemId: workItem.id, repoId: 'repo-missing' }),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  )
  db.close()
})
