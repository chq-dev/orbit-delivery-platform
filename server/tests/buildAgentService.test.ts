import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createDatabase } from '../db/database.js'
import { AppError } from '../domain/errors.js'
import { CredentialVault } from '../security/vault.js'
import { createAccount } from '../services/accountService.js'
import {
  getBuildJobWithFallback,
  resolveBuildAgentClientId,
  triggerBuildWithFallback,
} from '../services/buildAgentService.js'
import {
  completeFeishuAgentCommand,
  recordFeishuAgentHeartbeat,
} from '../services/feishuAgentBridgeService.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function health() {
  return {
    ok: true,
    version: 1,
    config: { configured: true, projectKey: 'rjcloud', repoPaths: {} },
    meegle: { available: true, authenticated: true },
    running: false,
    lastRun: null,
    pendingLogin: null,
  }
}

function fixture() {
  const db = createDatabase({ filename: ':memory:' })
  const vault = new CredentialVault('build-agent-service-test-key')
  const account = createAccount(db, vault, {
    platform: 'build',
    username: 'agent.jenkins',
    password: 'jenkins-secret',
    label: 'Agent Jenkins 账号',
    serviceUrl: 'https://jenkins.example.com/job/AGENT_TEST/',
  })
  recordFeishuAgentHeartbeat(db, {
    clientId: 'agent-1',
    clientName: '测试客户端',
    health: health(),
    runningCommandIds: [],
  })
  return { db, vault, account }
}

async function waitForCommand(db: ReturnType<typeof fixture>['db'], type: string) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const row = db
      .prepare(
        `SELECT id FROM feishu_agent_commands
         WHERE client_id = 'agent-1' AND command_type = ? AND status = 'pending'
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(type) as { id: string } | undefined
    if (row) return row.id
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('代理命令未入队')
}

test('平台直连 Jenkins 超时后改为本机客户端读取任务，且凭据不写入命令表', async () => {
  const { db, vault, account } = fixture()
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed', {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error' },
    })
  }) as typeof fetch

  const pending = getBuildJobWithFallback(db, vault, account.id, 'agent-1')
  const commandId = await waitForCommand(db, 'build_job_read')
  const heartbeat = recordFeishuAgentHeartbeat(db, {
    clientId: 'agent-1',
    clientName: '测试客户端',
    health: health(),
    runningCommandIds: [commandId],
  }, vault)
  const claimed = heartbeat.commands.find((command) => command.id === commandId)
  assert.ok(claimed)
  const payload = claimed.payload as {
    accountId: string
    spec: { jobUrl: string; username: string; secret: string }
  }
  assert.equal(payload.accountId, account.id)
  assert.equal(payload.spec.username, 'agent.jenkins')
  assert.equal(payload.spec.secret, 'jenkins-secret')
  assert.match(payload.spec.jobUrl, /\/job\/AGENT_TEST\/$/)

  const stored = db
    .prepare('SELECT payload_json FROM feishu_agent_commands WHERE id = ?')
    .get(commandId) as { payload_json: string }
  assert.equal(stored.payload_json.includes('jenkins-secret'), false)
  assert.match(stored.payload_json, /accountId/)

  completeFeishuAgentCommand(db, commandId, {
    result: {
      job: {
        accountId: account.id,
        name: 'AGENT_TEST',
        jobUrl: 'https://jenkins.example.com/job/AGENT_TEST/',
        buildable: true,
        parameters: [],
      },
    },
  }, 'agent-1')
  const job = await pending
  assert.equal(job.name, 'AGENT_TEST')
  db.close()
})

test('平台直连失败后由本机客户端触发 Jenkins 并返回队列地址', async () => {
  const { db, vault, account } = fixture()
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed', {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error' },
    })
  }) as typeof fetch

  const pending = triggerBuildWithFallback(
    db,
    vault,
    account.id,
    { SERIES: 'AP' },
    'agent-1',
  )
  const commandId = await waitForCommand(db, 'build_trigger')
  const heartbeat = recordFeishuAgentHeartbeat(db, {
    clientId: 'agent-1',
    clientName: '测试客户端',
    health: health(),
    runningCommandIds: [commandId],
  }, vault)
  const claimed = heartbeat.commands.find((command) => command.id === commandId)
  assert.ok(claimed)
  assert.deepEqual((claimed.payload as { parameters?: unknown }).parameters, { SERIES: 'AP' })

  completeFeishuAgentCommand(db, commandId, {
    result: {
      build: {
        ok: true,
        accountId: account.id,
        jobName: 'AGENT_TEST',
        jobUrl: 'https://jenkins.example.com/job/AGENT_TEST/',
        queueUrl: 'https://jenkins.example.com/queue/item/7/',
        triggeredAt: new Date().toISOString(),
        parameters: ['SERIES'],
      },
    },
  }, 'agent-1')
  const build = await pending
  assert.equal(build.jobName, 'AGENT_TEST')
  assert.equal(build.queueUrl, 'https://jenkins.example.com/queue/item/7/')
  db.close()
})

test('未指定客户端时仅在唯一在线客户端下自动选择，多客户端时要求明确选择', () => {
  const { db } = fixture()
  assert.equal(resolveBuildAgentClientId(db), 'agent-1')
  recordFeishuAgentHeartbeat(db, {
    clientId: 'agent-2',
    clientName: '第二客户端',
    health: health(),
    runningCommandIds: [],
  })
  assert.throws(
    () => resolveBuildAgentClientId(db),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 422 &&
      /多个在线执行客户端/.test(error.message),
  )
  db.close()
})
