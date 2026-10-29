import assert from 'node:assert/strict'
import { test } from 'node:test'
import { config } from '../config.js'
import { createDatabase } from '../db/database.js'
import { CredentialVault } from '../security/vault.js'
import { bootstrapFeishuIntegration } from '../services/feishuBootstrapService.js'
import { listRepositories } from '../services/repositoryService.js'
import { listWorkItems } from '../services/workItemService.js'

test('部署环境凭证可在启动时自动绑定并同步真实工作项', async () => {
  const originalFetch = globalThis.fetch
  const originalConfig = { ...config }
  Object.assign(config, {
    feishuAutoSync: true,
    feishuBaseUrl: 'https://project.feishu.cn',
    feishuProjectKey: 'rjcloud',
    feishuAccessToken: 'bootstrap-access-token',
    feishuPluginId: '',
    feishuPluginSecret: '',
    feishuUserKey: 'bootstrap-user',
    feishuRequirementTypeKey: 'story',
    feishuDefectTypeKey: 'issue',
    feishuDefaultOwner: '自动同步',
    feishuCloseTransitionId: '',
    feishuDefaultRepoId: '',
    feishuDefaultRepoUrl: 'http://cloudgit.rj.link/sme/bootstrap-test.git',
    feishuDefaultRepoBranch: 'dev-harvey',
    feishuDefaultRepoLocalPath: '',
  })
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/open_api/projects/detail')) {
      return new Response(
        JSON.stringify({
          data: { rjcloud: { project_key: 'rjcloud', name: 'RJ Cloud' } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.endsWith('/meta')) {
      return new Response(JSON.stringify({ data: { fields: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.endsWith('/open_api/rjcloud/work_item/filter')) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      const typeKey = Array.isArray(body.work_item_type_keys) ? body.work_item_type_keys[0] : ''
      const items =
        typeKey === 'story'
          ? [{ id: 401, name: '实时需求' }]
          : [{ id: 501, name: '实时缺陷' }]
      return new Response(JSON.stringify({ data: { work_items: items } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.endsWith('/open_api/rjcloud/work_item/story/query')) {
      return new Response(
        JSON.stringify({
          data: { work_items: [{ id: 401, name: '实时需求', priority: '高' }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.endsWith('/open_api/rjcloud/work_item/issue/query')) {
      return new Response(
        JSON.stringify({
          data: { work_items: [{ id: 501, name: '实时缺陷', priority: '紧急' }] },
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
    const db = createDatabase({ filename: ':memory:' })
    const vault = new CredentialVault('bootstrap-test-vault-key-with-enough-length')
    const result = await bootstrapFeishuIntegration(db, vault)

    assert.equal(result.connected, true)
    assert.equal(result.configuredFromEnvironment, true)
    assert.equal(result.sync?.upserted, 2)
    assert.equal(listRepositories(db).length, 1)
    assert.equal(listRepositories(db)[0].branch, 'dev-harvey')

    const items = listWorkItems(db)
    assert.equal(items.length, 2)
    assert.equal(items.some((item) => item.type === 'requirement' && item.title === '实时需求'), true)
    assert.equal(items.some((item) => item.type === 'defect' && item.title === '实时缺陷'), true)
    assert.equal(items.every((item) => item.source === 'feishu'), true)
    db.close()
  } finally {
    Object.assign(config, originalConfig)
    globalThis.fetch = originalFetch
  }
})
