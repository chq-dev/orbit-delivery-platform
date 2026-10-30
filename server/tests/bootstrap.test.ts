import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { createApp } from '../app.js'
import { createDatabase } from '../db/database.js'
import { CredentialVault } from '../security/vault.js'
import { createAccount } from '../services/accountService.js'
import { createRepository } from '../services/repositoryService.js'
import { createWorkItem } from '../services/workItemService.js'

test('bootstrap 默认兼容完整数据，传 includeWorkItems=0 时跳过工作项大列表', async () => {
  const db = createDatabase({ filename: ':memory:' })
  const app = createApp(db, new CredentialVault('bootstrap-route-test-vault-key'))
  let server: ReturnType<typeof app.listen> | undefined
  try {
    const vault = new CredentialVault('bootstrap-route-test-account-key')
    const account = createAccount(db, vault, {
      platform: 'git',
      username: 'bootstrap.user',
      password: 'bootstrap-secret',
      label: 'Bootstrap 测试账号',
    })
    const repository = createRepository(db, {
      name: 'sme-main',
      url: 'http://cloudgit.rj.link/sme/sme-main.git',
      branch: 'develop',
      language: 'Vue 3 + Lua',
      accountId: account.id,
    })
    createWorkItem(db, {
      type: 'requirement',
      title: 'Bootstrap 轻量响应测试',
      description: '描述'.repeat(1_000),
      priority: '中',
      repoId: repository.id,
      owner: '测试负责人',
    })
    db.prepare(
      `INSERT INTO feishu_inbox
        (external_id, type, title, description, priority, repo_id, owner, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'rjcloud:story:9001',
      'requirement',
      'Bootstrap 收件箱测试',
      '收件箱描述',
      '中',
      repository.id,
      '测试负责人',
      '2026-10-29T00:00:00.000Z',
    )

    server = app.listen(0)
    await new Promise<void>((resolve, reject) => {
      server?.once('listening', resolve)
      server?.once('error', reject)
    })
    const { port } = server.address() as AddressInfo
    const base = `http://127.0.0.1:${port}`
    const health = (await fetch(`http://127.0.0.1:${port}/api/health`).then((response) =>
      response.json(),
    )) as { deliveryContractVersion?: number }
    assert.equal(health.deliveryContractVersion, 3)
    const registered = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'bootstrap.user', password: 'Bootstrap123' }),
    })
    assert.equal(registered.status, 200)
    const cookie = registered.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    const light = (await fetch(
      `${base}/api/bootstrap?includeWorkItems=0&includeFeishuInbox=0`,
      { headers: { cookie: cookie ?? '' } },
    ).then((response) => response.json())) as {
      workItems: unknown[]
      feishuInbox: unknown[]
      repositories: unknown[]
    }
    assert.deepEqual(light.workItems, [])
    assert.deepEqual(light.feishuInbox, [])
    assert.equal(light.repositories.length, 1)

    const full = (await fetch(`${base}/api/bootstrap`, {
      headers: { cookie: cookie ?? '' },
    }).then((response) => response.json())) as { workItems: unknown[]; feishuInbox: unknown[] }
    assert.equal(full.workItems.length, 1)
    assert.equal(full.feishuInbox.length, 1)
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
    db.close()
  }
})
