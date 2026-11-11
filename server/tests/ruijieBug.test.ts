import assert from 'node:assert/strict'
import { createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createDatabase, type AppDatabase } from '../db/database.js'
import { SCHEMA_VERSION } from '../db/schema.js'
import { CredentialVault } from '../security/vault.js'
import { createAccount } from '../services/accountService.js'
import { createRepository } from '../services/repositoryService.js'
import {
  syncRuijieBugs,
  testRuijieBugConnection,
} from '../services/ruijieBugService.js'
import { upsertRuijieWorkItems } from '../services/workItemService.js'

const LOGIN_KEY = randomBytes(16).toString('base64')
const BUG_ID = '123456'
let db: AppDatabase
let vault: CredentialVault
let server: ReturnType<typeof createServer>
let baseUrl = ''
let accountId = ''
let repoId = ''

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function decryptPassword(value: string): string {
  const decipher = createDecipheriv(
    'aes-128-ecb',
    Buffer.from(LOGIN_KEY, 'base64'),
    null,
  )
  return Buffer.concat([decipher.update(value, 'base64'), decipher.final()]).toString('utf8')
}

function hasSession(request: IncomingMessage): boolean {
  return (request.headers.cookie ?? '').includes('JSESSIONID=ruijie-session')
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location })
  response.end()
}

async function handleMockBugSystem(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', baseUrl)

  if (url.pathname === '/bug_switch/bug/main') {
    if (!hasSession(request)) {
      redirect(response, '/login?service=%2Fbug_switch%2Fshiro-cas')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<html><head><title>锐捷 BUG 系统</title></head><body>main</body></html>')
    return
  }

  if (url.pathname === '/login' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>统一身份认证平台</title></head><body>
      <p id="current-login-type">UsernamePassword</p>
      <p id="login-croypto">${LOGIN_KEY}</p>
      <p id="login-page-flowkey">flow-ruijie-test</p>
    </body></html>`)
    return
  }

  if (url.pathname === '/login' && request.method === 'POST') {
    const form = new URLSearchParams(await readBody(request))
    const valid =
      form.get('username') === 'bug.user' &&
      decryptPassword(form.get('password') ?? '') === 'bug-password' &&
      decryptPassword(form.get('captcha_payload') ?? '') === '' &&
      form.get('execution') === 'flow-ruijie-test' &&
      form.get('croypto') === LOGIN_KEY
    if (!valid) {
      response.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body><p>用户名或密码错误</p></body></html>')
      return
    }
    response.setHeader('Set-Cookie', [
      'JSESSIONID=ruijie-session; Path=/; HttpOnly',
      'SESSION=ruijie-cas-session; Path=/; HttpOnly',
    ])
    redirect(response, '/bug_switch/shiro-cas')
    return
  }

  if (url.pathname === '/bug_switch/shiro-cas') {
    redirect(response, '/bug_switch/bug/main')
    return
  }

  if (url.pathname === '/bug_switch/bug/bug_info') {
    if (!hasSession(request)) {
      redirect(response, '/login?service=%2Fbug_switch%2Fshiro-cas')
      return
    }
    if (url.searchParams.get('bugId') !== BUG_ID) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not found"}')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({
      data: {
        bugId: BUG_ID,
        bugTitle: 'WLAN 漫游切换后终端短暂断流',
        bugDesc: '跨 AP 漫游时终端出现约 2 秒断流，需要检查漫游组播与缓存配置。',
        bugPriority: '高',
        bugHandler: '张三',
        bugProduct: 'SME',
        bugModule: 'WLAN',
        updateTime: '2026-11-11 10:00:00',
      },
    }))
    return
  }

  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('not found')
}

before(async () => {
  server = createServer((request, response) => {
    void handleMockBugSystem(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`

  db = createDatabase({ filename: ':memory:' })
  vault = new CredentialVault('ruijie-bug-test-vault-key')
  const gitAccount = createAccount(db, vault, {
    platform: 'git',
    username: 'repo.user',
    password: 'repo-password',
    label: '仓库账号',
  })
  const ruijieAccount = createAccount(db, vault, {
    platform: 'ruijie',
    username: 'bug.user',
    password: 'bug-password',
    label: 'BUG 系统账号',
    serviceUrl: `${baseUrl}/bug_switch/bug/main`,
  })
  accountId = ruijieAccount.id
  repoId = createRepository(db, {
    name: 'ruijie-bug-test',
    url: 'https://git.example.com/sme/ruijie-bug-test.git',
    branch: 'dev-harvey',
    language: 'TypeScript',
    accountId: gitAccount.id,
  }).id
})

after(async () => {
  db.close()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
})

test('锐捷 BUG 通过 CAS 账号密码登录并按 BUG 编号幂等导入', async () => {
  const connection = await testRuijieBugConnection(db, vault, accountId)
  assert.equal(connection.username, 'bug.user')
  assert.equal(connection.baseUrl, `${baseUrl}/bug_switch`)

  const first = await syncRuijieBugs(db, vault, {
    accountId,
    repoId,
    bugIds: BUG_ID,
    limit: 10,
  })
  assert.equal(first.fetched, 1)
  assert.equal(first.created, 1)
  assert.equal(first.updated, 0)
  assert.equal(first.bugs[0]?.bugId, BUG_ID)
  assert.equal(first.bugs[0]?.priority, '高')
  assert.equal(
    first.bugs[0]?.url,
    `${baseUrl}/bug_switch/bug/main?bugId=${BUG_ID}`,
  )

  const rows = db
    .prepare(
      `SELECT id, title, source, external_id, project_line, owner
       FROM work_items WHERE source = 'ruijie'`,
    )
    .all() as Array<{
      id: string
      title: string
      source: string
      external_id: string
      project_line: string
      owner: string
    }>
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, 'WLAN 漫游切换后终端短暂断流')
  assert.equal(rows[0].external_id, `ruijie:${BUG_ID}`)
  assert.equal(rows[0].project_line, 'SME / WLAN')
  assert.equal(rows[0].owner, '张三')

  const second = await syncRuijieBugs(db, vault, {
    accountId,
    repoId,
    bugIds: `http://bugs.ruijie.com.cn/bug_switch/bug/main?bugId=${BUG_ID}`,
    limit: 10,
  })
  assert.equal(second.created, 0)
  assert.equal(second.updated, 1)
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM work_items WHERE source = 'ruijie'").get() as {
      count: number
    }).count,
    1,
  )
})

test('版本 26 数据库升级后保留旧工作项并允许写入锐捷来源', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-ruijie-migration-'))
  const filename = join(directory, 'orbit.db')
  try {
    const seeded = createDatabase({ filename })
    const seededVault = new CredentialVault('ruijie-migration-vault-key')
    const now = '2026-11-11T00:00:00.000Z'
    seeded.prepare(
      `INSERT INTO users (id, username, username_normalized, password_hash, created_at, updated_at)
       VALUES ('ruijie-migration-user', 'Ruijie.Migration', 'ruijie.migration', 'hash', ?, ?)`,
    ).run(now, now)
    const gitAccount = createAccount(
      seeded,
      seededVault,
      {
        platform: 'git',
        username: 'migration.repo.user',
        password: 'migration-repo-password',
        label: '迁移仓库账号',
      },
      'ruijie-migration-user',
    )
    const repository = createRepository(
      seeded,
      {
        name: 'ruijie-migration-repo',
        url: 'https://git.example.com/sme/ruijie-migration.git',
        branch: 'main',
        language: 'TypeScript',
        accountId: gitAccount.id,
      },
      'ruijie-migration-user',
    )
    seeded.prepare(
      `INSERT INTO work_items
        (id, owner_user_id, type, title, description, priority, status, repo_id, branch,
         owner, source, external_id, created_at, updated_at)
       VALUES ('BUG-1', 'ruijie-migration-user', 'defect', '旧缺陷', '升级保留', '高',
               '待处理', ?, 'main', '旧负责人', 'local', NULL, ?, ?)`,
    ).run(repository.id, now, now)

    seeded.pragma('foreign_keys = OFF')
    seeded.exec(`
      CREATE TABLE accounts_ruijie_old (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL CHECK (platform IN ('git', 'figma', 'feishu', 'build', 'device')),
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
        UNIQUE (owner_user_id, platform, username)
      );
      INSERT INTO accounts_ruijie_old SELECT * FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_ruijie_old RENAME TO accounts;

      CREATE TABLE work_items_ruijie_old (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL DEFAULT '',
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
        defect_note TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner_user_id, source, external_id)
      );
      INSERT INTO work_items_ruijie_old SELECT * FROM work_items;
      DROP TABLE work_items;
      ALTER TABLE work_items_ruijie_old RENAME TO work_items;
      PRAGMA user_version = 26;
    `)
    seeded.close()

    const upgraded = createDatabase({ filename })
    assert.equal(upgraded.pragma('user_version', { simple: true }), SCHEMA_VERSION)
    const retained = upgraded
      .prepare("SELECT title, owner_user_id FROM work_items WHERE id = 'BUG-1'")
      .get() as { title: string; owner_user_id: string }
    assert.equal(retained.title, '旧缺陷')
    assert.equal(retained.owner_user_id, 'ruijie-migration-user')

    const ruijieAccount = createAccount(
      upgraded,
      seededVault,
      {
        platform: 'ruijie',
        username: 'migration.bug.user',
        password: 'migration-bug-password',
        label: '迁移后的 BUG 账号',
      },
      'ruijie-migration-user',
    )
    assert.equal(ruijieAccount.platform, 'ruijie')
    assert.equal(
      upsertRuijieWorkItems(upgraded, repository.id, [{
        externalId: 'ruijie:900001',
        type: 'defect',
        title: '迁移后可写入的 BUG',
        description: '来源约束已升级',
        priority: '中',
        owner: '锐捷 BUG 同步',
        updatedAt: now,
      }]).created,
      1,
    )
    upgraded.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
