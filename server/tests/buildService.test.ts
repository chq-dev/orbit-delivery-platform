import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { createDatabase, type AppDatabase } from '../db/database.js'
import { AppError } from '../domain/errors.js'
import { CredentialVault } from '../security/vault.js'
import { createAccount } from '../services/accountService.js'
import { getBuildJob, triggerBuild } from '../services/buildService.js'

const originalFetch = globalThis.fetch
let db: AppDatabase
let vault: CredentialVault
let buildAccountId: string

before(() => {
  db = createDatabase({ filename: ':memory:' })
  vault = new CredentialVault('build-service-test-vault-key')
  buildAccountId = createAccount(db, vault, {
    platform: 'build',
    username: 'jenkins.user',
    password: 'jenkins-api-token',
    label: 'Jenkins 编译账号',
    serviceUrl:
      'https://jenkins.example.com/view/%E3%80%90SME%E3%80%91%E5%B7%A5%E7%A8%8B/job/SME_%E6%B5%81%E6%B0%B4%E7%BA%BF_%E8%AE%BE%E5%A4%87EWEB/',
  }).id
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

after(() => {
  db.close()
})

function jobResponse() {
  return {
    name: 'SME_流水线_设备EWEB',
    url: 'https://jenkins.example.com/job/SME_%E6%B5%81%E6%B0%B4%E7%BA%BF_%E8%AE%BE%E5%A4%87EWEB/',
    buildable: true,
    property: [
      {
        parameterDefinitions: [
          {
            name: 'SERIES',
            type: 'ChoiceParameterDefinition',
            description: '设备系列',
            choices: ['AP', 'SWITCH', 'GATEWAY', 'AC'],
            defaultParameterValue: { value: 'AP' },
          },
          {
            name: 'BRANCHES',
            type: 'StringParameterDefinition',
            description: '编译分支',
            defaultParameterValue: { value: 'main' },
          },
        ],
      },
    ],
  }
}

test('读取 Jenkins 参数并规范化视图地址中的任务路径', async () => {
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    calls.push(url.pathname)
    assert.equal(url.pathname, '/job/SME_%E6%B5%81%E6%B0%B4%E7%BA%BF_%E8%AE%BE%E5%A4%87EWEB/api/json')
    return Response.json(jobResponse())
  }) as typeof fetch

  const job = await getBuildJob(db, vault, buildAccountId)
  assert.equal(job.name, 'SME_流水线_设备EWEB')
  assert.equal(job.parameters.length, 2)
  assert.deepEqual(job.parameters.map((parameter) => parameter.name), ['SERIES', 'BRANCHES'])
  assert.equal(job.parameters[0].defaultValue, 'AP')
  assert.deepEqual(calls, ['/job/SME_%E6%B5%81%E6%B0%B4%E7%BA%BF_%E8%AE%BE%E5%A4%87EWEB/api/json'])
})

test('内部编译按参数默认值触发 buildWithParameters 并返回构建队列地址', async () => {
  const requests: Array<{ url: URL; method: string; body?: string; authorization?: string }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      authorization: headers.get('authorization') ?? undefined,
    })

    if (url.pathname.endsWith('/api/json')) return Response.json(jobResponse())
    if (url.pathname === '/crumbIssuer/api/json') {
      return Response.json({ crumb: 'crumb-value', crumbRequestField: 'Jenkins-Crumb' })
    }
    if (url.pathname.endsWith('/buildWithParameters')) {
      return new Response(null, { status: 201, headers: { location: '/queue/item/42/' } })
    }
    return new Response('unexpected request', { status: 500 })
  }) as typeof fetch

  const result = await triggerBuild(db, vault, buildAccountId, { SERIES: 'AC' })
  assert.equal(result.jobName, 'SME_流水线_设备EWEB')
  assert.equal(result.queueUrl, 'https://jenkins.example.com/queue/item/42/')
  assert.deepEqual(result.parameters, ['SERIES', 'BRANCHES'])

  const trigger = requests.find((request) => request.method === 'POST')
  assert.ok(trigger)
  assert.equal(
    trigger.url.pathname,
    '/job/SME_%E6%B5%81%E6%B0%B4%E7%BA%BF_%E8%AE%BE%E5%A4%87EWEB/buildWithParameters',
  )
  assert.equal(new URLSearchParams(trigger.body).get('SERIES'), 'AC')
  assert.equal(new URLSearchParams(trigger.body).get('BRANCHES'), 'main')
  assert.match(trigger.authorization ?? '', /^Basic /)
  assert.equal(trigger.body?.includes('jenkins-api-token'), false)
})

test('非法编译参数和认证失败会返回明确错误', async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/api/json')) return Response.json(jobResponse())
    return new Response('unauthorized', { status: 401 })
  }) as typeof fetch

  await assert.rejects(
    () => triggerBuild(db, vault, buildAccountId, { SERIES: 'UNKNOWN' }),
    (error: unknown) => error instanceof AppError && error.statusCode === 422,
  )

  globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch
  await assert.rejects(
    () => getBuildJob(db, vault, buildAccountId),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 502 &&
      error.code === 'BUILD_AUTH_FAILED',
  )
})

test('非编译系统账号不能触发内部编译', async () => {
  const gitAccount = createAccount(db, vault, {
    platform: 'git',
    username: 'git.user',
    password: 'git-secret',
    label: 'Git 账号',
  })
  await assert.rejects(
    () => getBuildJob(db, vault, gitAccount.id),
    (error: unknown) => error instanceof AppError && error.statusCode === 422,
  )
})
