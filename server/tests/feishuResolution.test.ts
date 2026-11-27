import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDatabase } from '../db/database.js'
import { nowIso } from '../domain/time.js'
import { CredentialVault } from '../security/vault.js'
import { createAccount } from '../services/accountService.js'
import {
  enqueueFeishuCloseOutbox,
  processFeishuOutbox,
} from '../services/feishuIntegrationService.js'
import { createRepository } from '../services/repositoryService.js'
import {
  importWorkItems,
  saveWorkItemDeliveryContext,
} from '../services/workItemService.js'

test('飞书缺陷关闭回写会携带五项解决信息并流转到已解决', async () => {
  const db = createDatabase({ filename: ':memory:' })
  const vault = new CredentialVault('feishu-resolution-test-vault-key')
  const originalFetch = globalThis.fetch
  let transitionBody: Record<string, unknown> | undefined
  try {
    const account = createAccount(db, vault, {
      platform: 'git',
      username: 'feishu.resolution',
      password: 'feishu-resolution-secret',
      label: '飞书写回测试账号',
    })
    const repository = createRepository(db, {
      name: 'sme-main',
      url: 'http://cloudgit.rj.link/sme/sme-main.git',
      branch: 'develop',
      language: 'Vue 3 + Lua',
      accountId: account.id,
    })
    const encryptedPlugin = vault.encrypt('plugin-secret')
    const now = nowIso()
    db.prepare(
      `INSERT INTO feishu_integrations
        (id, project_key, plugin_id, plugin_secret_ciphertext, plugin_secret_iv,
         plugin_secret_tag, plugin_secret_hint, user_key, default_repo_id,
         requirement_type_key, defect_type_key, default_owner, close_transition_id,
         status, created_at, updated_at)
       VALUES ('feishu-main', 'rjcloud', 'plug-test', ?, ?, ?, ?, 'user-test', ?,
               'story', 'issue', '飞书同步', '123456', 'active', ?, ?)`,
    ).run(
      encryptedPlugin.ciphertext,
      encryptedPlugin.iv,
      encryptedPlugin.tag,
      vault.hint('plugin-secret'),
      repository.id,
      now,
      now,
    )
    const defect = importWorkItems(db, [{
      type: 'defect',
      title: '飞书写回缺陷',
      description: '验证关闭时写入解决信息',
      priority: '高',
      repoId: repository.id,
      owner: '飞书同步',
      source: 'feishu',
      externalId: 'rjcloud:issue:9001',
    }]).items[0]
    saveWorkItemDeliveryContext(db, defect.id, {
      defectResolution: {
        legacyBug: false,
        introduced: true,
        solution: '修复状态同步',
        rootCause: '状态机遗漏重连分支',
        impact: '影响 AP 漫游场景',
      },
    })

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/open_api/authen/plugin_token')) {
        return new Response(
          JSON.stringify({ data: { token: 'plugin-token', expire_time: 3600 } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/open_api/rjcloud/work_item/issue/meta')) {
        return new Response(JSON.stringify({
          data: {
            fields: [
              {
                field_key: 'field_880d7e',
                field_name: '是否遗留BUG',
                field_type: 'select',
                option: [
                  { option_id: 'legacy-yes', option_name: '是' },
                  { option_id: 'legacy-no', option_name: '否' },
                ],
              },
              {
                field_key: 'field_e34974',
                field_name: '是否修订引入',
                field_type: 'select',
                option: [
                  { option_id: 'introduced-yes', option_name: '是' },
                  { option_id: 'introduced-no', option_name: '否' },
                ],
              },
              { field_key: 'field_953b68', field_name: '解决方案', field_type: 'multi-text' },
              { field_key: 'field_462c75', field_name: '根因分析', field_type: 'multi-text' },
              { field_key: 'field_b70e69', field_name: '影响面分析', field_type: 'multi-text' },
            ],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/open_api/rjcloud/workflow/issue/9001/node/state_change')) {
        transitionBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ error: { msg: `unexpected ${url}` } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    enqueueFeishuCloseOutbox(db, defect.id)
    assert.equal(await processFeishuOutbox(db, vault), 1)
    assert.equal(transitionBody?.transition_id, 123456)
    assert.deepEqual(transitionBody?.fields, [
      { field_key: 'field_880d7e', field_value: { label: '否', value: 'legacy-no' } },
      {
        field_key: 'field_e34974',
        field_value: { label: '是', value: 'introduced-yes' },
      },
      { field_key: 'field_953b68', field_value: '修复状态同步' },
      { field_key: 'field_462c75', field_value: '状态机遗漏重连分支' },
      { field_key: 'field_b70e69', field_value: '影响 AP 漫游场景' },
    ])
    assert.equal(
      (db.prepare('SELECT status FROM feishu_outbox WHERE work_item_id = ?').get(defect.id) as {
        status: string
      }).status,
      'sent',
    )
  } finally {
    globalThis.fetch = originalFetch
    db.close()
  }
})
