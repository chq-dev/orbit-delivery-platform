import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect, type AddressInfo } from 'node:net'
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

test('网络不可达时返回底层原因，便于定位 DNS、路由或 TLS 问题', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed', {
      cause: { code: 'ENOTFOUND', hostname: 'ops.rj.link', syscall: 'getaddrinfo' },
    })
  }) as typeof fetch

  await assert.rejects(
    () => getBuildJob(db, vault, buildAccountId),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 502 &&
      error.code === 'BUILD_SYSTEM_UNREACHABLE' &&
      /无法连接编译系统 https:\/\/jenkins\.example\.com/.test(error.message) &&
      /DNS 解析失败（ENOTFOUND）/.test(error.message) &&
      /ops\.rj\.link/.test(error.message),
  )
})

test('BUILD_PROXY_URL 非法时返回明确的代理配置错误', async () => {
  process.env.BUILD_PROXY_URL = 'not-a-url'
  try {
    await assert.rejects(
      () => getBuildJob(db, vault, buildAccountId),
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === 500 &&
        error.code === 'BUILD_PROXY_INVALID' &&
        /BUILD_PROXY_URL 配置无效/.test(error.message),
    )
  } finally {
    delete process.env.BUILD_PROXY_URL
  }
})

test('配置 BUILD_PROXY_URL 后通过 HTTP 代理访问 Jenkins', async () => {
  const jenkins = createServer((request, response) => {
    if (request.url?.startsWith('/job/PROXY_TEST/api/json')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ name: 'PROXY_TEST', buildable: true, property: [] }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  const proxied: string[] = []
  const proxy = createServer((request, response) => {
    if (!request.url) {
      response.writeHead(400)
      response.end()
      return
    }
    proxied.push(request.url)
    const upstream = httpRequest(
      new URL(request.url),
      { method: request.method, headers: request.headers },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      },
    )
    upstream.on('error', () => {
      response.writeHead(502)
      response.end('proxy error')
    })
    request.pipe(upstream)
  })
  proxy.on('connect', (request, clientSocket, head) => {
    proxied.push(request.url ?? '')
    const [host, port] = (request.url ?? '').split(':')
    const upstream = netConnect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
  })
  const listen = (server: typeof jenkins) =>
    new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
    })

  try {
    const jenkinsPort = await listen(jenkins)
    const proxyPort = await listen(proxy)
    const accountId = createAccount(db, vault, {
      platform: 'build',
      username: 'proxy.jenkins',
      password: 'proxy-token',
      label: '代理 Jenkins 账号',
      serviceUrl: `http://127.0.0.1:${jenkinsPort}/job/PROXY_TEST/`,
    }).id
    process.env.BUILD_PROXY_URL = `http://127.0.0.1:${proxyPort}`

    const job = await getBuildJob(db, vault, accountId)
    assert.equal(job.name, 'PROXY_TEST')
    assert.equal(proxied.length, 1)
    assert.match(proxied[0], /^(?:http:\/\/127\.0\.0\.1:\d+\/job\/PROXY_TEST\/api\/json|127\.0\.0\.1:\d+)/)
  } finally {
    delete process.env.BUILD_PROXY_URL
    await new Promise<void>((resolve) => jenkins.close(() => resolve()))
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
  }
})
