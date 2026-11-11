import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from '../app.js'
import { createDatabase, type AppDatabase } from '../db/database.js'
import { SCHEMA_VERSION } from '../db/schema.js'
import { CredentialVault } from '../security/vault.js'
import { createAccount } from '../services/accountService.js'
import {
  getFeishuAgentBridgeStatus,
  recordFeishuAgentHeartbeat,
} from '../services/feishuAgentBridgeService.js'
import { connectFeishu, getFeishuStatus } from '../services/feishuIntegrationService.js'
import { recordLocalDelivery } from '../services/localDeliveryService.js'
import { createTestReport } from '../services/reportService.js'
import { createRepository } from '../services/repositoryService.js'
import { issueFeishuAgentCredential } from '../services/feishuSyncTokenService.js'

interface Session {
  cookie: string
  userId: string
}

async function startServer(db: AppDatabase) {
  const app = createApp(db, new CredentialVault('ownership-route-test-vault-key'))
  const server = app.listen(0)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function register(base: string, username: string): Promise<Session> {
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'OwnershipPass123' }),
  })
  assert.equal(response.status, 200)
  const payload = (await response.json()) as { user: { id: string } }
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  return { cookie, userId: payload.user.id }
}

async function apiJson<T>(
  base: string,
  cookie: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}/api${path}`, {
    ...init,
    headers: {
      cookie,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  return { status: response.status, body: (await response.json()) as T }
}

function insertOwnedFeishuIntegration(
  db: AppDatabase,
  input: { id: string; ownerUserId: string; repoId: string; projectKey: string },
): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO feishu_integrations
      (id, owner_user_id, project_key, plugin_id, plugin_secret_ciphertext,
       plugin_secret_iv, plugin_secret_tag, plugin_secret_hint, user_key,
       default_repo_id, requirement_type_key, defect_type_key, default_owner,
       status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ciphertext', 'iv', 'tag', 'hint', 'user-key',
             ?, 'story', 'issue', '飞书同步', 'active', ?, ?)`,
  ).run(
    input.id,
    input.ownerUserId,
    input.projectKey,
    `${input.projectKey}-plugin`,
    input.repoId,
    now,
    now,
  )
}

test('不同登录账号的账号、仓库、需求、交付和报告完全隔离', async () => {
  const db = createDatabase({ filename: ':memory:' })
  const server = await startServer(db)
  try {
    const userA = await register(server.base, 'owner.a')
    const accountA = await apiJson<{ id: string }>(server.base, userA.cookie, '/accounts', {
      method: 'POST',
      body: JSON.stringify({
        platform: 'git',
        username: 'shared.git.user',
        password: 'SharedSecret123',
        label: 'A Git',
        serviceUrl: 'https://git.example.com',
      }),
    })
    assert.equal(accountA.status, 201)
    const repoA = await apiJson<{ id: string }>(server.base, userA.cookie, '/repositories', {
      method: 'POST',
      body: JSON.stringify({
        name: 'repo-a',
        url: 'https://git.example.com/shared/repository.git',
        branch: 'main',
        language: 'TypeScript',
        accountId: accountA.body.id,
      }),
    })
    assert.equal(repoA.status, 201)
    const itemA = await apiJson<{ id: string }>(server.base, userA.cookie, '/work-items', {
      method: 'POST',
      body: JSON.stringify({
        type: 'defect',
        title: 'A 的缺陷',
        description: '仅 A 可见',
        priority: '高',
        repoId: repoA.body.id,
        owner: 'A',
      }),
    })
    assert.equal(itemA.status, 201)

    const userB = await register(server.base, 'owner.b')
    const accountB = await apiJson<{ id: string }>(server.base, userB.cookie, '/accounts', {
      method: 'POST',
      body: JSON.stringify({
        platform: 'git',
        username: 'shared.git.user',
        password: 'SharedSecret123',
        label: 'B Git',
        serviceUrl: 'https://git.example.com',
      }),
    })
    assert.equal(accountB.status, 201)
    const repoB = await apiJson<{ id: string }>(server.base, userB.cookie, '/repositories', {
      method: 'POST',
      body: JSON.stringify({
        name: 'repo-b',
        url: 'https://git.example.com/shared/repository.git',
        branch: 'main',
        language: 'TypeScript',
        accountId: accountB.body.id,
      }),
    })
    assert.equal(repoB.status, 201)
    const itemB = await apiJson<{ id: string }>(server.base, userB.cookie, '/work-items', {
      method: 'POST',
      body: JSON.stringify({
        type: 'defect',
        title: 'B 的缺陷',
        description: '仅 B 可见',
        priority: '高',
        repoId: repoB.body.id,
        owner: 'B',
      }),
    })
    assert.equal(itemB.status, 201)

    const crossRepo = await apiJson(server.base, userA.cookie, '/repositories', {
      method: 'POST',
      body: JSON.stringify({
        name: 'cross-account',
        url: 'https://git.example.com/cross.git',
        branch: 'main',
        language: 'TypeScript',
        accountId: accountB.body.id,
      }),
    })
    assert.equal(crossRepo.status, 404)

    const pipelineA = recordLocalDelivery(db, {
      workItemId: itemA.body.id,
      repoId: repoA.body.id,
      outcome: 'failed',
      error: 'A 执行失败',
    })
    const pipelineB = recordLocalDelivery(db, {
      workItemId: itemB.body.id,
      repoId: repoB.body.id,
      outcome: 'failed',
      error: 'B 执行失败',
    })
    const reportA = createTestReport(db, {
      pipelineId: pipelineA.id,
      project: 'repo-a',
      version: 'v1',
    })
    const reportB = createTestReport(db, {
      pipelineId: pipelineB.id,
      project: 'repo-b',
      version: 'v1',
    })

    const bootstrapA = await apiJson<{
      accounts: Array<{ id: string }>
      repositories: Array<{ id: string }>
      workItems: Array<{ id: string }>
      pipelines: Array<{ id: string }>
      reports: Array<{ id: string }>
    }>(server.base, userA.cookie, '/bootstrap')
    assert.deepEqual(bootstrapA.body.accounts.map((entry) => entry.id), [accountA.body.id])
    assert.deepEqual(bootstrapA.body.repositories.map((entry) => entry.id), [repoA.body.id])
    assert.deepEqual(bootstrapA.body.workItems.map((entry) => entry.id), [itemA.body.id])
    assert.deepEqual(bootstrapA.body.pipelines.map((entry) => entry.id), [pipelineA.id])
    assert.deepEqual(bootstrapA.body.reports.map((entry) => entry.id), [reportA.id])

    const bootstrapB = await apiJson<{
      accounts: Array<{ id: string }>
      repositories: Array<{ id: string }>
      workItems: Array<{ id: string }>
      pipelines: Array<{ id: string }>
      reports: Array<{ id: string }>
    }>(server.base, userB.cookie, '/bootstrap')
    assert.deepEqual(bootstrapB.body.accounts.map((entry) => entry.id), [accountB.body.id])
    assert.deepEqual(bootstrapB.body.repositories.map((entry) => entry.id), [repoB.body.id])
    assert.deepEqual(bootstrapB.body.workItems.map((entry) => entry.id), [itemB.body.id])
    assert.deepEqual(bootstrapB.body.pipelines.map((entry) => entry.id), [pipelineB.id])
    assert.deepEqual(bootstrapB.body.reports.map((entry) => entry.id), [reportB.id])

    assert.equal(
      (await apiJson(server.base, userA.cookie, `/work-items/${itemB.body.id}`)).status,
      404,
    )
    assert.equal(
      (await apiJson(server.base, userA.cookie, `/pipelines/${pipelineB.id}`)).status,
      404,
    )
    assert.equal(
      (await apiJson(server.base, userA.cookie, `/reports/${reportB.id}`)).status,
      404,
    )
    assert.equal(
      (await apiJson(server.base, userA.cookie, `/accounts/${accountB.body.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ label: '越权修改' }),
      })).status,
      404,
    )
    assert.equal(
      (await apiJson(server.base, userA.cookie, '/pipelines/local', {
        method: 'POST',
        body: JSON.stringify({
          workItemId: itemB.body.id,
          repoId: repoB.body.id,
          outcome: 'failed',
          error: '越权执行',
        }),
      })).status,
      404,
    )
  } finally {
    await server.close()
    db.close()
  }
})

test('飞书集成、代理交付状态和代理命令按登录账号隔离', async () => {
  const db = createDatabase({ filename: ':memory:' })
  const server = await startServer(db)
  try {
    const userA = await register(server.base, 'feishu.owner.a')
    const userB = await register(server.base, 'feishu.owner.b')

    const createGitRepo = async (cookie: string, suffix: string) => {
      const account = await apiJson<{ id: string }>(server.base, cookie, '/accounts', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'git',
          username: `git.${suffix}`,
          password: 'SharedSecret123',
          label: `Git ${suffix}`,
        }),
      })
      assert.equal(account.status, 201)
      const repo = await apiJson<{ id: string }>(server.base, cookie, '/repositories', {
        method: 'POST',
        body: JSON.stringify({
          name: `repo-${suffix}`,
          url: `https://git.example.com/${suffix}/repository.git`,
          branch: 'main',
          language: 'TypeScript',
          accountId: account.body.id,
        }),
      })
      assert.equal(repo.status, 201)
      const item = await apiJson<{ id: string }>(server.base, cookie, '/work-items', {
        method: 'POST',
        body: JSON.stringify({
          type: 'defect',
          title: `${suffix} 的缺陷`,
          description: `${suffix} 的交付上下文`,
          priority: '高',
          repoId: repo.body.id,
          owner: suffix,
        }),
      })
      assert.equal(item.status, 201)
      return { repoId: repo.body.id, itemId: item.body.id }
    }

    const targetA = await createGitRepo(userA.cookie, 'a')
    const targetB = await createGitRepo(userB.cookie, 'b')
    insertOwnedFeishuIntegration(db, {
      id: `feishu-main:${userA.userId}`,
      ownerUserId: userA.userId,
      repoId: targetA.repoId,
      projectKey: 'project-a',
    })
    insertOwnedFeishuIntegration(db, {
      id: `feishu-main:${userB.userId}`,
      ownerUserId: userB.userId,
      repoId: targetB.repoId,
      projectKey: 'project-b',
    })

    const statusA = await apiJson<{ connected: boolean; projectKey?: string }>(
      server.base,
      userA.cookie,
      '/integrations/feishu/status',
    )
    const statusB = await apiJson<{ connected: boolean; projectKey?: string }>(
      server.base,
      userB.cookie,
      '/integrations/feishu/status',
    )
    assert.deepEqual(
      { connected: statusA.body.connected, projectKey: statusA.body.projectKey },
      { connected: true, projectKey: 'project-a' },
    )
    assert.deepEqual(
      { connected: statusB.body.connected, projectKey: statusB.body.projectKey },
      { connected: true, projectKey: 'project-b' },
    )

    recordFeishuAgentHeartbeat(db, {
      clientId: 'primary',
      clientName: 'owner-a-agent',
      machineName: 'owner-a-machine',
      health: {
        config: { configured: true, projectKey: 'project-a' },
        meegle: { available: true, authenticated: true },
        running: true,
        lastRun: null,
        delivery: {
          id: 'job-a',
          status: 'running',
          stage: '业务编码',
          workItemId: targetA.itemId,
          repoId: targetA.repoId,
          steps: [],
        },
      },
    })
    issueFeishuAgentCredential(db, 'owner-b-client', userB.userId)
    recordFeishuAgentHeartbeat(db, {
      clientId: 'owner-b-client',
      clientName: 'owner-b-agent',
      machineName: 'owner-b-machine',
      health: {
        config: { configured: true, projectKey: 'project-b' },
        meegle: { available: true, authenticated: true },
        running: true,
        lastRun: null,
        delivery: {
          id: 'job-b',
          status: 'running',
          stage: '业务编码',
          workItemId: targetB.itemId,
          repoId: targetB.repoId,
          steps: [],
        },
      },
    })

    const agentA = await apiJson<{
      health?: { running: boolean; delivery?: { workItemId?: string } | null }
      clients: { clientId: string }[]
    }>(server.base, userA.cookie, '/integrations/feishu/agent/status?clientId=primary')
    const agentB = await apiJson<{
      health?: { running: boolean; delivery?: { workItemId?: string } | null }
      clients: { clientId: string }[]
      clientId?: string
    }>(server.base, userB.cookie, '/integrations/feishu/agent/status?clientId=primary')
    const agentBOwn = await apiJson<{
      health?: { running: boolean; delivery?: { workItemId?: string } | null }
      clients: { clientId: string }[]
      clientId?: string
    }>(server.base, userB.cookie, '/integrations/feishu/agent/status?clientId=owner-b-client')
    assert.equal(agentA.body.health?.running, true)
    assert.equal(agentA.body.health?.delivery?.workItemId, targetA.itemId)
    assert.deepEqual(
      new Set(agentA.body.clients.map((client) => client.clientId)),
      new Set(['primary', 'owner-b-client']),
    )
    assert.deepEqual(agentB.body.clients.map((client) => client.clientId), ['owner-b-client'])
    assert.equal(agentB.body.health, undefined)
    assert.equal(agentBOwn.body.clientId, 'owner-b-client')
    assert.equal(agentBOwn.body.health?.running, true)
    assert.equal(agentBOwn.body.health?.delivery?.workItemId, targetB.itemId)

    const buildAccountA = await apiJson<{ id: string }>(server.base, userA.cookie, '/accounts', {
      method: 'POST',
      body: JSON.stringify({
        platform: 'build',
        username: 'build.a',
        password: 'BuildSecret123',
        label: 'A 编译账号',
        serviceUrl: 'https://jenkins.example.com/job/a/',
      }),
    })
    assert.equal(buildAccountA.status, 201)
    const crossBuild = await apiJson(server.base, userB.cookie, '/integrations/feishu/agent/commands', {
      method: 'POST',
      body: JSON.stringify({
        type: 'build_trigger',
        clientId: 'primary',
        payload: { accountId: buildAccountA.body.id, parameters: {} },
      }),
    })
    assert.equal(crossBuild.status, 404)

    const crossDelivery = await apiJson(
      server.base,
      userB.cookie,
      '/integrations/feishu/agent/commands',
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'delivery_start',
          clientId: 'primary',
          payload: {
            workItemId: targetA.itemId,
            repoId: targetA.repoId,
            autoCommit: true,
            pushAfterAcceptance: false,
            runBuild: false,
            autoClose: false,
          },
        }),
      },
    )
    assert.equal(crossDelivery.status, 404)

    const disconnectB = await apiJson(server.base, userB.cookie, '/integrations/feishu/disconnect', {
      method: 'POST',
    })
    assert.equal(disconnectB.status, 200)
    const statusAAfter = await apiJson<{ connected: boolean; projectKey?: string }>(
      server.base,
      userA.cookie,
      '/integrations/feishu/status',
    )
    assert.equal(statusAAfter.body.connected, true)
    assert.equal(statusAAfter.body.projectKey, 'project-a')
  } finally {
    await server.close()
    db.close()
  }
})

test('飞书连接配置按登录账号分别保存且不能引用其他账号仓库', async () => {
  const db = createDatabase({ filename: ':memory:' })
  const vault = new CredentialVault('feishu-owner-connect-vault-key')
  const originalFetch = globalThis.fetch
  try {
    const now = new Date().toISOString()
    for (const id of ['connect-owner-a', 'connect-owner-b']) {
      db.prepare(
        `INSERT INTO users (id, username, username_normalized, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, 'hash', ?, ?)`,
      ).run(id, id, id, now, now)
    }
    const accountA = createAccount(
      db,
      vault,
      { platform: 'git', username: 'connect.git.a', password: 'ConnectPass123', label: 'A' },
      'connect-owner-a',
    )
    const accountB = createAccount(
      db,
      vault,
      { platform: 'git', username: 'connect.git.b', password: 'ConnectPass123', label: 'B' },
      'connect-owner-b',
    )
    const repoA = createRepository(
      db,
      {
        name: 'connect-repo-a',
        url: 'https://git.example.com/connect/a.git',
        branch: 'main',
        language: 'TypeScript',
        accountId: accountA.id,
      },
      'connect-owner-a',
    )
    const repoB = createRepository(
      db,
      {
        name: 'connect-repo-b',
        url: 'https://git.example.com/connect/b.git',
        branch: 'main',
        language: 'TypeScript',
        accountId: accountB.id,
      },
      'connect-owner-b',
    )

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/open_api/authen/plugin_token')) {
        return new Response(JSON.stringify({ data: { token: 'plugin-token', expire_time: 3600 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/open_api/projects/detail')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        const projectKey =
          Array.isArray(body.project_keys) && typeof body.project_keys[0] === 'string'
            ? body.project_keys[0]
            : 'project-a'
        return new Response(
          JSON.stringify({ data: { project_key: projectKey, name: projectKey } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes('/work_item/') && url.endsWith('/meta')) {
        return new Response(JSON.stringify({ data: { fields: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ error: { code: 404, msg: url } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    await assert.rejects(
      connectFeishu(
        db,
        vault,
        {
          pluginId: 'plugin-a',
          pluginSecret: 'secret-a',
          userKey: 'user-a',
          projectKey: 'project-a',
          defaultRepoId: repoA.id,
          requirementTypeKey: 'story',
          defectTypeKey: 'issue',
        },
        'connect-owner-b',
      ),
      /默认仓库不存在/,
    )

    await connectFeishu(
      db,
      vault,
      {
        pluginId: 'plugin-a',
        pluginSecret: 'secret-a',
        userKey: 'user-a',
        projectKey: 'project-a',
        defaultRepoId: repoA.id,
        requirementTypeKey: 'story',
        defectTypeKey: 'issue',
      },
      'connect-owner-a',
    )
    await connectFeishu(
      db,
      vault,
      {
        pluginId: 'plugin-b',
        pluginSecret: 'secret-b',
        userKey: 'user-b',
        projectKey: 'project-b',
        defaultRepoId: repoB.id,
        requirementTypeKey: 'story',
        defectTypeKey: 'issue',
      },
      'connect-owner-b',
    )

    assert.equal(getFeishuStatus(db, 'connect-owner-a').projectKey, 'project-a')
    assert.equal(getFeishuStatus(db, 'connect-owner-b').projectKey, 'project-b')
    const owners = db
      .prepare('SELECT id, owner_user_id FROM feishu_integrations ORDER BY owner_user_id')
      .all() as Array<{ id: string; owner_user_id: string }>
    assert.deepEqual(owners, [
      { id: 'feishu-main:connect-owner-a', owner_user_id: 'connect-owner-a' },
      { id: 'feishu-main:connect-owner-b', owner_user_id: 'connect-owner-b' },
    ])
  } finally {
    globalThis.fetch = originalFetch
    db.close()
  }
})

test('版本 21 数据库升级后保留旧数据并回填首个用户归属', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-ownership-migration-'))
  const filename = join(directory, 'orbit.db')
  try {
    const seeded = createDatabase({ filename })
    seeded.pragma('foreign_keys = OFF')
    seeded.exec(`
      DROP TABLE feishu_inbox;
      DROP TABLE work_items;
      DROP TABLE repositories;
      DROP TABLE accounts;

      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL CHECK (platform IN ('git', 'feishu', 'build', 'device')),
        username TEXT NOT NULL,
        label TEXT NOT NULL,
        service_url TEXT NOT NULL DEFAULT '',
        secret_ciphertext TEXT NOT NULL,
        secret_iv TEXT NOT NULL,
        secret_tag TEXT NOT NULL,
        secret_hint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'expiring')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (platform, username)
      );

      CREATE TABLE repositories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL,
        local_path TEXT NOT NULL DEFAULT '',
        build_enabled INTEGER NOT NULL DEFAULT 1 CHECK (build_enabled IN (0, 1)),
        build_account_id TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        last_sync TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('healthy', 'warning')),
        latest_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE work_items (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('requirement', 'defect')),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('紧急', '高', '中', '低')),
        status TEXT NOT NULL CHECK (status IN ('待处理', '进行中', '已交付', '已关闭')),
        repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
        branch TEXT NOT NULL,
        owner TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('local', 'feishu')),
        external_id TEXT,
        feishu_status TEXT,
        project_line TEXT,
        design_reference TEXT,
        requirement_breakdown TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (source, external_id)
      );

      CREATE TABLE feishu_inbox (
        external_id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('requirement', 'defect')),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('紧急', '高', '中', '低')),
        repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
        owner TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    const now = '2026-01-01T00:00:00.000Z'
    seeded.prepare(
      `INSERT INTO users (id, username, username_normalized, password_hash, created_at, updated_at)
       VALUES ('legacy-owner', 'Legacy.Owner', 'legacy.owner', 'hash', ?, ?)`,
    ).run(now, now)
    seeded.prepare(
      `INSERT INTO accounts
        (id, platform, username, label, service_url, secret_ciphertext, secret_iv, secret_tag,
         secret_hint, status, created_at, updated_at)
       VALUES ('legacy-account', 'git', 'legacy.user', '旧账号', '', 'c', 'i', 't', 'h',
               'active', ?, ?)`,
    ).run(now, now)
    seeded.prepare(
      `INSERT INTO repositories
        (id, name, url, branch, local_path, build_enabled, build_account_id, language,
         account_id, last_sync, status, latest_version, created_at, updated_at)
       VALUES ('legacy-repo', 'legacy', 'https://git.example.com/legacy.git', 'main', '', 1, '',
               'TypeScript', 'legacy-account', ?, 'healthy', 'v1.0.0', ?, ?)`,
    ).run(now, now, now)
    seeded.prepare(
      `INSERT INTO work_items
        (id, type, title, description, priority, status, repo_id, branch, owner, source,
         external_id, created_at, updated_at)
       VALUES ('BUG-1', 'defect', '旧缺陷', '升级保留', '高', '待处理', 'legacy-repo', 'main',
               '旧负责人', 'local', NULL, ?, ?)`,
    ).run(now, now)
    seeded.prepare(
      `INSERT INTO feishu_inbox
        (external_id, type, title, description, priority, repo_id, owner, updated_at)
       VALUES ('rjcloud:issue:1', 'defect', '旧收件箱', '升级保留', '高', 'legacy-repo',
               '旧负责人', ?)`,
    ).run(now)
    seeded.pragma('user_version = 21')
    seeded.close()

    const upgraded = createDatabase({ filename })
    assert.equal(upgraded.pragma('user_version', { simple: true }), SCHEMA_VERSION)
    assert.equal(
      (upgraded.prepare("SELECT owner_user_id FROM accounts WHERE id = 'legacy-account'").get() as {
        owner_user_id: string
      }).owner_user_id,
      'legacy-owner',
    )
    assert.equal(
      (upgraded.prepare("SELECT owner_user_id FROM repositories WHERE id = 'legacy-repo'").get() as {
        owner_user_id: string
      }).owner_user_id,
      'legacy-owner',
    )
    assert.equal(
      (upgraded.prepare("SELECT owner_user_id FROM work_items WHERE id = 'BUG-1'").get() as {
        owner_user_id: string
      }).owner_user_id,
      'legacy-owner',
    )
    assert.equal(
      (upgraded.prepare(
        "SELECT owner_user_id FROM feishu_inbox WHERE external_id = 'rjcloud:issue:1'",
      ).get() as { owner_user_id: string }).owner_user_id,
      'legacy-owner',
    )

    const nowUpgraded = '2026-01-02T00:00:00.000Z'
    upgraded.prepare(
      `INSERT INTO users (id, username, username_normalized, password_hash, created_at, updated_at)
       VALUES ('second-owner', 'Second.Owner', 'second.owner', 'hash', ?, ?)`,
    ).run(nowUpgraded, nowUpgraded)
    const vault = new CredentialVault('ownership-migration-vault-key')
    const secondAccount = createAccount(
      upgraded,
      vault,
      {
        platform: 'git',
        username: 'legacy.user',
        password: 'SecondSecret123',
        label: '第二个用户同名账号',
      },
      'second-owner',
    )
    assert.equal(secondAccount.label, '第二个用户同名账号')
    upgraded.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('版本 22 数据库升级后为飞书集成补列并回填所属用户', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-integration-ownership-'))
  const filename = join(directory, 'orbit.db')
  try {
    const seeded = createDatabase({ filename })
    const vault = new CredentialVault('integration-ownership-vault-key')
    const now = '2026-01-01T00:00:00.000Z'
    seeded.prepare(
      `INSERT INTO users (id, username, username_normalized, password_hash, created_at, updated_at)
       VALUES ('integration-owner', 'Integration.Owner', 'integration.owner', 'hash', ?, ?)`,
    ).run(now, now)
    const account = createAccount(
      seeded,
      vault,
      {
        platform: 'git',
        username: 'integration.git',
        password: 'IntegrationPass123',
        label: '集成归属账号',
      },
      'integration-owner',
    )
    const repository = createRepository(
      seeded,
      {
        name: 'integration-repo',
        url: 'https://git.example.com/integration/repository.git',
        branch: 'main',
        language: 'TypeScript',
        accountId: account.id,
      },
      'integration-owner',
    )
    insertOwnedFeishuIntegration(seeded, {
      id: `feishu-main:integration-owner`,
      ownerUserId: 'integration-owner',
      repoId: repository.id,
      projectKey: 'integration-project',
    })
    seeded.exec(
      'DROP INDEX IF EXISTS idx_feishu_integrations_owner; ALTER TABLE feishu_integrations DROP COLUMN owner_user_id; PRAGMA user_version = 22;',
    )
    seeded.close()

    const upgraded = createDatabase({ filename })
    assert.equal(upgraded.pragma('user_version', { simple: true }), SCHEMA_VERSION)
    const integration = upgraded
      .prepare(
        "SELECT owner_user_id FROM feishu_integrations WHERE id = 'feishu-main:integration-owner'",
      )
      .get() as { owner_user_id: string }
    assert.equal(integration.owner_user_id, 'integration-owner')
    upgraded.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('版本 25 数据库升级后客户端绑定归属首个用户', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-agent-ownership-'))
  const filename = join(directory, 'orbit.db')
  try {
    const seeded = createDatabase({ filename })
    const now = '2026-01-01T00:00:00.000Z'
    seeded.prepare(
      `INSERT INTO users (id, username, username_normalized, password_hash, created_at, updated_at)
       VALUES ('agent-owner-a', 'Agent.Owner.A', 'agent.owner.a', 'hash', ?, ?)`,
    ).run(now, now)
    seeded.prepare(
      `INSERT INTO users (id, username, username_normalized, password_hash, created_at, updated_at)
       VALUES ('agent-owner-b', 'Agent.Owner.B', 'agent.owner.b', 'hash', ?, ?)`,
    ).run('2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    seeded.prepare(
      `INSERT INTO feishu_agent_credentials
        (client_id, token_hash, token_hint, created_at, updated_at)
       VALUES ('legacy-client', 'legacy-token-hash', '••••test', ?, ?)`,
    ).run(now, now)
    seeded.prepare(
      `INSERT INTO feishu_agent_state
        (id, client_name, machine_name, health_json, last_seen_at, created_at, updated_at)
       VALUES ('legacy-client', '旧客户端', 'legacy-machine', '{}', ?, ?, ?)`,
    ).run(now, now, now)
    seeded.prepare(
      `INSERT INTO feishu_agent_pairings
        (client_id, pairing_secret_hash, client_name, machine_name, platform_base_url,
         project_key, public_key, source_ip, status, config_ciphertext,
         created_at, updated_at, expires_at)
       VALUES ('legacy-client', 'secret-hash', '旧客户端', 'legacy-machine',
         'https://orbit.example.com', 'rjcloud', 'public-key', '', 'pending', NULL, ?, ?, ?)`,
    ).run(now, now, '2026-01-01T00:30:00.000Z')
    seeded.exec(`
      DROP INDEX IF EXISTS idx_feishu_agent_state_owner;
      DROP INDEX IF EXISTS idx_feishu_agent_credentials_owner;
      DROP INDEX IF EXISTS idx_feishu_agent_pairings_owner;
      ALTER TABLE feishu_agent_state DROP COLUMN owner_user_id;
      ALTER TABLE feishu_agent_credentials DROP COLUMN owner_user_id;
      ALTER TABLE feishu_agent_pairings DROP COLUMN owner_user_id;
      PRAGMA user_version = 25;
    `)
    seeded.close()

    const upgraded = createDatabase({ filename })
    assert.equal(upgraded.pragma('user_version', { simple: true }), SCHEMA_VERSION)
    for (const [table, idColumn, idValue] of [
      ['feishu_agent_state', 'id', 'legacy-client'],
      ['feishu_agent_credentials', 'client_id', 'legacy-client'],
      ['feishu_agent_pairings', 'client_id', 'legacy-client'],
    ] as const) {
      const row = upgraded
        .prepare(`SELECT owner_user_id FROM ${table} WHERE ${idColumn} = ?`)
        .get(idValue) as { owner_user_id: string }
      assert.equal(row.owner_user_id, 'agent-owner-a')
    }
    assert.deepEqual(
      getFeishuAgentBridgeStatus(upgraded, undefined, 'agent-owner-b').clients,
      [],
    )
    assert.deepEqual(
      getFeishuAgentBridgeStatus(upgraded, undefined, 'agent-owner-a').clients.map(
        (client) => client.clientId,
      ),
      ['legacy-client'],
    )
    upgraded.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
