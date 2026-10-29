import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDatabase } from '../db/database.js'
import { CredentialVault } from '../security/vault.js'
import { createAccount } from '../services/accountService.js'
import { createRepository } from '../services/repositoryService.js'
import {
  createWorkItem,
  getWorkItem,
  listWorkItems,
  listWorkItemSummaries,
} from '../services/workItemService.js'

test('工作项列表使用轻量摘要，详情保留完整描述', () => {
  const db = createDatabase({ filename: ':memory:' })
  try {
    const vault = new CredentialVault('test-vault-key-with-enough-length')
    const account = createAccount(db, vault, {
      platform: 'git',
      username: 'summary.user',
      password: 'summary-secret',
      label: '摘要测试账号',
    })
    const repository = createRepository(db, {
      name: 'sme-main',
      url: 'http://cloudgit.rj.link/sme/sme-main.git',
      branch: 'develop',
      language: 'Vue 3 + Lua',
      accountId: account.id,
    })
    const description = '需求描述'.repeat(1_000)
    const item = createWorkItem(db, {
      type: 'requirement',
      title: '列表摘要测试',
      description,
      priority: '高',
      repoId: repository.id,
      owner: '测试负责人',
    })

    const summaries = listWorkItemSummaries(db)
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0]?.description, '')
    assert.equal(summaries[0]?.title, '列表摘要测试')

    assert.equal(listWorkItems(db)[0]?.description, description)
    assert.equal(getWorkItem(db, item.id).description, description)
  } finally {
    db.close()
  }
})
