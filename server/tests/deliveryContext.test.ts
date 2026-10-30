import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createApp } from '../app.js'
import { createDatabase } from '../db/database.js'
import { CredentialVault } from '../security/vault.js'
import { createAccount } from '../services/accountService.js'
import { createRepository } from '../services/repositoryService.js'
import {
  assertRequirementDeliveryContextReady,
  createWorkItem,
  getWorkItemDeliveryContext,
  listWorkItemSummaries,
  saveWorkItemDeliveryContext,
} from '../services/workItemService.js'

function setupWorkItems() {
  const db = createDatabase({ filename: ':memory:' })
  const vault = new CredentialVault('delivery-context-test-vault-key')
  const account = createAccount(db, vault, {
    platform: 'git',
    username: 'delivery.context',
    password: 'delivery-context-secret',
    label: '交付上下文测试账号',
  })
  const repository = createRepository(db, {
    name: 'sme-main',
    url: 'http://cloudgit.rj.link/sme/sme-main.git',
    branch: 'dev-harvey',
    language: 'Vue 3 + Lua',
    accountId: account.id,
  })
  const requirement = createWorkItem(db, {
    type: 'requirement',
    title: '需求交付上下文',
    description: '原始需求描述',
    priority: '高',
    repoId: repository.id,
    owner: '测试负责人',
  })
  return { db, repository, requirement }
}

function screenshot(bytes = Buffer.from('design screenshot')) {
  return {
    name: 'design.png',
    mimeType: 'image/png',
    sizeBytes: bytes.length,
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
  }
}

test('需求交付必须提供拆解、设计稿或截图之一', () => {
  const { db, requirement } = setupWorkItems()
  try {
    assert.throws(
      () => saveWorkItemDeliveryContext(db, requirement.id, {}),
      /需求交付前必须提供需求拆解/,
    )
    assert.throws(
      () =>
        saveWorkItemDeliveryContext(db, requirement.id, {
          requirementBreakdown: '太短',
        }),
      /需求交付前必须提供需求拆解/,
    )
  } finally {
    db.close()
  }
})

test('需求拆解、设计稿链接或截图任一存在即可启动交付', () => {
  const { db, requirement } = setupWorkItems()
  try {
    const breakdown = '目标：支持第三方私有指标；范围：列表和详情；验收：数据一致；影响模块：web 与 lua。'
    const withBreakdown = saveWorkItemDeliveryContext(db, requirement.id, {
      requirementBreakdown: breakdown,
      designReference: '',
      screenshots: [],
    })
    assert.equal(withBreakdown.workItem.requirementBreakdown, breakdown)
    assert.doesNotThrow(() => assertRequirementDeliveryContextReady(db, requirement.id))
    assert.equal(
      listWorkItemSummaries(db).find((item) => item.id === requirement.id)?.description,
      '',
    )

    const withDesign = saveWorkItemDeliveryContext(db, requirement.id, {
      requirementBreakdown: '',
      designReference: 'https://ruijie.feishu.cn/wiki/design-1082',
    })
    assert.equal(withDesign.requirementBreakdown, undefined)
    assert.equal(withDesign.designReference, 'https://ruijie.feishu.cn/wiki/design-1082')
    assert.doesNotThrow(() => assertRequirementDeliveryContextReady(db, requirement.id))

    const withScreenshot = saveWorkItemDeliveryContext(db, requirement.id, {
      requirementBreakdown: '',
      designReference: '',
      screenshots: [screenshot()],
    })
    assert.equal(withScreenshot.screenshots.length, 1)
    assert.equal(withScreenshot.workItem.requirementScreenshotCount, 1)
    assert.equal(
      listWorkItemSummaries(db).find((item) => item.id === requirement.id)
        ?.requirementScreenshotCount,
      1,
    )
    assert.doesNotThrow(() => assertRequirementDeliveryContextReady(db, requirement.id))
  } finally {
    db.close()
  }
})

test('缺陷不要求需求拆解、设计稿或截图', () => {
  const { db, repository } = setupWorkItems()
  try {
    const defect = createWorkItem(db, {
      type: 'defect',
      title: '缺陷交付',
      description: '复现条件和期望行为',
      priority: '中',
      repoId: repository.id,
      owner: '测试负责人',
    })
    assert.doesNotThrow(() => assertRequirementDeliveryContextReady(db, defect.id))
    assert.doesNotThrow(() => saveWorkItemDeliveryContext(db, defect.id, {}))
  } finally {
    db.close()
  }
})

test('截图类型、单张体积与数量受服务端限制', () => {
  const { db, requirement } = setupWorkItems()
  try {
    assert.throws(
      () =>
        saveWorkItemDeliveryContext(db, requirement.id, {
          screenshots: [{ ...screenshot(), mimeType: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,eA==' }],
        }),
      /仅支持 PNG、JPEG 或 WebP/,
    )
    assert.throws(
      () =>
        saveWorkItemDeliveryContext(db, requirement.id, {
          screenshots: [
            screenshot(Buffer.alloc(501 * 1024, 1)),
          ],
        }),
      /超过 500KB/,
    )
    assert.throws(
      () =>
        saveWorkItemDeliveryContext(db, requirement.id, {
          screenshots: [screenshot(), screenshot(), screenshot(), screenshot()],
        }),
      /最多上传 3 张/,
    )
  } finally {
    db.close()
  }
})

test('交付上下文详情返回可写入客户端文件的截图内容', () => {
  const { db, requirement } = setupWorkItems()
  try {
    saveWorkItemDeliveryContext(db, requirement.id, {
      screenshots: [screenshot(Buffer.from('image-content'))],
    })
    const context = getWorkItemDeliveryContext(db, requirement.id)
    assert.equal(context.workItem.description, '原始需求描述')
    assert.equal(context.screenshots[0]?.name, 'design.png')
    assert.equal(
      context.screenshots[0]?.dataUrl,
      `data:image/png;base64,${Buffer.from('image-content').toString('base64')}`,
    )
  } finally {
    db.close()
  }
})

test('需求交付命令下发前由服务端再次校验上下文', async () => {
  const { db, repository, requirement } = setupWorkItems()
  const app = createApp(db, new CredentialVault('delivery-context-route-vault-key'))
  let server: ReturnType<typeof app.listen> | undefined
  try {
    server = app.listen(0)
    await new Promise<void>((resolve, reject) => {
      server?.once('listening', resolve)
      server?.once('error', reject)
    })
    const { port } = server.address() as AddressInfo
    const base = `http://127.0.0.1:${port}`
    const registered = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'delivery.context', password: 'Delivery123' }),
    })
    assert.equal(registered.status, 200)
    const cookie = registered.headers.get('set-cookie')?.split(';')[0] ?? ''
    assert.ok(cookie)
    const payload = {
      workItemId: requirement.id,
      repoId: repository.id,
      autoCommit: true,
      pushAfterAcceptance: false,
      autoClose: false,
    }

    const rejected = await fetch(`${base}/api/integrations/feishu/agent/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'delivery_start', payload }),
    })
    assert.equal(rejected.status, 422)
    assert.match(await rejected.text(), /需求交付前必须提供需求拆解/)

    const saved = await fetch(
      `${base}/api/work-items/${encodeURIComponent(requirement.id)}/delivery-context`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          requirementBreakdown: '目标：完成需求；范围：前端与后端；验收：单测和构建通过。',
        }),
      },
    )
    assert.equal(saved.status, 200)

    const accepted = await fetch(`${base}/api/integrations/feishu/agent/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'delivery_start', payload }),
    })
    assert.equal(accepted.status, 202)
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
    db.close()
  }
})
