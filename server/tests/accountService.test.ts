import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, type AppDatabase } from '../db/database.js'
import { AppError } from '../domain/errors.js'
import { CredentialVault } from '../security/vault.js'
import {
  createAccount,
  deleteAccount,
  getAccountSecret,
  listAccounts,
  updateAccount,
} from '../services/accountService.js'
import { createRepository } from '../services/repositoryService.js'

let db: AppDatabase
let vault: CredentialVault

before(() => {
  db = createDatabase({ filename: ':memory:' })
  vault = new CredentialVault('account-service-test-vault-key')
})

after(() => {
  db.close()
})

test('账号支持保存与更新服务地址，编辑留空密码时保留原凭据', () => {
  const account = createAccount(db, vault, {
    platform: 'git',
    username: 'service.account',
    password: 'original-secret-7K2m',
    label: '服务账号',
    serviceUrl: '  https://git.example.com  ',
  })

  assert.equal(account.serviceUrl, 'https://git.example.com')
  assert.equal(listAccounts(db)[0].serviceUrl, 'https://git.example.com')

  const updated = updateAccount(db, vault, account.id, {
    label: 'Git 服务账号',
    serviceUrl: 'https://git.example.com/profile/service.account',
  })
  assert.equal(updated.label, 'Git 服务账号')
  assert.equal(updated.serviceUrl, 'https://git.example.com/profile/service.account')
  assert.equal(updated.secretHint, account.secretHint)
  assert.equal(getAccountSecret(db, vault, account.id), 'original-secret-7K2m')
})

test('编辑时传入新密码会重新加密并更新凭据提示', () => {
  const account = createAccount(db, vault, {
    platform: 'build',
    username: 'build.service',
    password: 'old-build-secret',
    label: '编译服务',
  })

  const updated = updateAccount(db, vault, account.id, {
    password: 'new-build-secret-9Q4x',
  })
  assert.notEqual(updated.secretHint, account.secretHint)
  assert.equal(getAccountSecret(db, vault, account.id), 'new-build-secret-9Q4x')
})

test('Figma 账号使用加密 Token 保存并支持服务地址', () => {
  const account = createAccount(db, vault, {
    platform: 'figma',
    username: 'designer@example.com',
    password: 'figd_readonly_token',
    label: 'Figma 设计账号',
    serviceUrl: 'https://www.figma.com/files/team/123456789',
  })

  assert.equal(account.platform, 'figma')
  assert.equal(account.serviceUrl, 'https://www.figma.com/files/team/123456789')
  assert.equal(getAccountSecret(db, vault, account.id), 'figd_readonly_token')
})

test('编辑账号会排除自身并拦截与其他账号的平台账号重复', () => {
  const first = createAccount(db, vault, {
    platform: 'device',
    username: 'device-one',
    password: 'device-secret-one',
    label: '设备一',
  })
  createAccount(db, vault, {
    platform: 'device',
    username: 'device-two',
    password: 'device-secret-two',
    label: '设备二',
  })

  assert.equal(updateAccount(db, vault, first.id, { label: '设备一（已更新）' }).label, '设备一（已更新）')
  assert.throws(
    () => updateAccount(db, vault, first.id, { username: 'device-two' }),
    (error: unknown) => error instanceof AppError && error.statusCode === 409,
  )
})

test('服务地址必须是合法的 http 或 https 链接', () => {
  assert.throws(
    () =>
      createAccount(db, vault, {
        platform: 'feishu',
        username: 'invalid-url',
        password: 'feishu-secret',
        label: '非法地址',
        serviceUrl: 'git.example.com',
      }),
    (error: unknown) => error instanceof AppError && error.statusCode === 422,
  )
})

test('账号被仓库引用时禁止删除，解除引用后可删除', () => {
  const account = createAccount(db, vault, {
    platform: 'git',
    username: 'referenced.account',
    password: 'referenced-secret',
    label: '仓库账号',
  })
  const repository = createRepository(db, {
    name: 'account-delete-test',
    url: 'https://git.example.com/account-delete-test.git',
    branch: 'develop',
    language: 'TypeScript',
    accountId: account.id,
  })

  assert.throws(
    () => deleteAccount(db, account.id),
    (error: unknown) => error instanceof AppError && error.statusCode === 409,
  )

  db.prepare('DELETE FROM repositories WHERE id = ?').run(repository.id)
  deleteAccount(db, account.id)
  assert.equal(listAccounts(db).some((item) => item.id === account.id), false)
  assert.throws(
    () => deleteAccount(db, account.id),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  )
})
