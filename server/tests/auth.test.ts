import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { createApp } from '../app.js'
import { createDatabase } from '../db/database.js'
import { hashPassword, passwordValidationError, verifyPassword } from '../security/password.js'
import { bootstrapFeishuSyncToken } from '../services/feishuSyncTokenService.js'
import { CredentialVault } from '../security/vault.js'

test('密码使用加盐 scrypt 哈希且可安全校验', async () => {
  const first = await hashPassword('SecurePass123')
  const second = await hashPassword('SecurePass123')
  assert.notEqual(first, second)
  assert.match(first, /^scrypt\$16384\$8\$1\$/)
  assert.equal(first.includes('SecurePass123'), false)
  assert.equal(await verifyPassword('SecurePass123', first), true)
  assert.equal(await verifyPassword('WrongPass123', first), false)
  assert.equal(await verifyPassword('SecurePass123', 'invalid-hash'), false)
  assert.equal(passwordValidationError('short1'), '密码至少需要 8 个字符')
  assert.match(passwordValidationError('onlyletters') ?? '', /字母和数字/)
  assert.equal(passwordValidationError('ValidPass123'), undefined)
})

test('注册、登录、会话保护和退出登录形成完整认证链路', async () => {
  const db = createDatabase({ filename: ':memory:' })
  const app = createApp(db, new CredentialVault('auth-route-test-vault-key'))
  let server: ReturnType<typeof app.listen> | undefined
  try {
    server = app.listen(0)
    await new Promise<void>((resolve, reject) => {
      server?.once('listening', resolve)
      server?.once('error', reject)
    })
    const { port } = server.address() as AddressInfo
    const base = `http://127.0.0.1:${port}`
    const credentials = { username: 'Auth.User', password: 'SecurePass123' }

    const unauthenticated = await fetch(`${base}/api/bootstrap`)
    assert.equal(unauthenticated.status, 401)

    const registered = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials),
    })
    assert.equal(registered.status, 200)
    const registration = (await registered.json()) as {
      authenticated: boolean
      user: { username: string }
    }
    assert.equal(registration.authenticated, true)
    assert.equal(registration.user.username, 'Auth.User')
    const cookie = registered.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    assert.match(registered.headers.get('set-cookie') ?? '', /HttpOnly/)
    assert.match(registered.headers.get('set-cookie') ?? '', /SameSite=Lax/)

    const stored = db
      .prepare('SELECT password_hash FROM users WHERE username_normalized = ?')
      .get('auth.user') as { password_hash: string }
    assert.equal(stored.password_hash.includes(credentials.password), false)
    assert.match(stored.password_hash, /^scrypt\$/)
    const session = db.prepare('SELECT token_hash FROM user_sessions').get() as { token_hash: string }
    assert.equal(session.token_hash.includes(cookie?.split('=')[1] ?? ''), false)

    const protectedResponse = await fetch(`${base}/api/bootstrap`, {
      headers: { cookie: cookie ?? '' },
    })
    assert.equal(protectedResponse.status, 200)

    const duplicate = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, username: 'auth.user' }),
    })
    assert.equal(duplicate.status, 409)

    const wrongPassword = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, password: 'WrongPass123' }),
    })
    assert.equal(wrongPassword.status, 401)

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials),
    })
    assert.equal(login.status, 200)
    const loginCookie = login.headers.get('set-cookie')?.split(';')[0]
    assert.ok(loginCookie)

    const sessionResponse = await fetch(`${base}/api/auth/session`, {
      headers: { cookie: loginCookie ?? '' },
    })
    assert.equal(((await sessionResponse.json()) as { authenticated: boolean }).authenticated, true)

    const logout = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: loginCookie ?? '' },
    })
    assert.equal(logout.status, 200)
    const afterLogout = await fetch(`${base}/api/bootstrap`, {
      headers: { cookie: loginCookie ?? '' },
    })
    assert.equal(afterLogout.status, 401)
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
    db.close()
  }
})

test('同步 Token 只能访问服务白名单接口', async () => {
  const db = createDatabase({ filename: ':memory:' })
  const app = createApp(db, new CredentialVault('auth-service-token-test-vault-key'))
  let server: ReturnType<typeof app.listen> | undefined
  try {
    server = app.listen(0)
    await new Promise<void>((resolve, reject) => {
      server?.once('listening', resolve)
      server?.once('error', reject)
    })
    const { port } = server.address() as AddressInfo
    const base = `http://127.0.0.1:${port}`
    const token = bootstrapFeishuSyncToken(db).token
    const headers = { authorization: `Bearer ${token}` }

    const bootstrap = await fetch(`${base}/api/bootstrap`, { headers })
    assert.equal(bootstrap.status, 200)
    const repositories = await fetch(`${base}/api/repositories`, { headers })
    assert.equal(repositories.status, 200)

    const workItems = await fetch(`${base}/api/work-items`, { headers })
    assert.equal(workItems.status, 401)
    const createRepository = await fetch(`${base}/api/repositories`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(createRepository.status, 401)
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
    db.close()
  }
})
