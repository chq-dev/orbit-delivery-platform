import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDatabase } from '../db/database.js'
import { AppError } from '../domain/errors.js'
import {
  completeFeishuAgentCommand,
  enqueueFeishuAgentCommand,
  getFeishuAgentBridgeStatus,
  recordFeishuAgentHeartbeat,
  sanitizeFeishuAgentHealth,
  updateFeishuAgentCommandProgress,
} from '../services/feishuAgentBridgeService.js'

const TEST_CLIENT_ID = 'client-test'

const health = {
  ok: true,
  version: 3,
  config: {
    configured: true,
    platformBaseUrl: 'http://8.145.45.84:8787',
    projectKey: 'rjcloud',
    repoId: 'repo-1',
    repoPaths: {
      'repo-1': '/Users/shinya/Documents/workspace/SME/basic-component-cloud',
      'bad key': '/tmp/ignored',
    },
    syncToken: 'must-not-be-stored-in-public-state',
  },
  meegle: {
    available: true,
    authenticated: true,
    host: 'project.feishu.cn',
    accessToken: 'must-not-be-stored-in-public-state',
  },
  feishuMcp: {
    enabled: true,
    configured: true,
    available: true,
    authenticated: false,
    command: '/usr/local/bin/lark-mcp',
    appSecret: 'must-not-be-stored-in-public-state',
  },
  meegleMcp: {
    enabled: true,
    configured: true,
    available: true,
    command: '/usr/local/bin/tsx',
    accessToken: 'must-not-be-stored-in-public-state',
  },
  running: false,
  lastRun: null,
  pendingLogin: null,
  cookie: 'must-not-be-stored-in-public-state',
}

const testClient = {
  clientId: TEST_CLIENT_ID,
  clientName: '测试客户端',
  machineName: 'test-machine',
  health,
}

test('代理心跳只保存脱敏状态并据此判断在线', () => {
  const db = createDatabase({ filename: ':memory:' })
  try {
    assert.deepEqual(getFeishuAgentBridgeStatus(db), {
      clientId: undefined,
      online: false,
      staleAfterSeconds: 90,
      activeCommand: null,
      lastCommand: null,
      commands: [],
      clients: [],
    })

    const sanitized = sanitizeFeishuAgentHealth(health)
    assert.equal(
      JSON.stringify(sanitized).includes('must-not-be-stored-in-public-state'),
      false,
    )
    assert.equal(sanitized.config.configured, true)
    assert.equal(sanitized.meegle.authenticated, true)
    assert.equal(sanitized.feishuMcp?.configured, true)
    assert.equal(sanitized.feishuMcp?.available, true)
    assert.equal(sanitized.feishuMcp?.authenticated, false)
    assert.equal(sanitized.meegleMcp?.configured, true)
    assert.equal(sanitized.meegleMcp?.available, true)

    const heartbeat = recordFeishuAgentHeartbeat(db, {
      health,
      machineName: 'machine-primary',
    })
    assert.ok(heartbeat.lastSeenAt)
    assert.equal(heartbeat.machineName, 'machine-primary')
    const status = getFeishuAgentBridgeStatus(db)
    assert.equal(status.online, true)
    assert.equal(status.machineName, 'machine-primary')
    assert.equal(status.health?.config.repoId, 'repo-1')
    assert.deepEqual(status.health?.config.repoPaths, {
      'repo-1': '/Users/shinya/Documents/workspace/SME/basic-component-cloud',
    })
    assert.equal(
      JSON.stringify(status).includes('must-not-be-stored-in-public-state'),
      false,
    )

    db.prepare('UPDATE feishu_agent_state SET last_seen_at = ? WHERE id = ?').run(
      new Date(Date.now() - 120_000).toISOString(),
      'primary',
    )
    assert.equal(getFeishuAgentBridgeStatus(db).online, false)
  } finally {
    db.close()
  }
})

test('代理命令去重、领取和完成结果可被页面查询', () => {
  const db = createDatabase({ filename: ':memory:' })
  try {
    recordFeishuAgentHeartbeat(db, testClient)
    const first = enqueueFeishuAgentCommand(db, 'sync', undefined, TEST_CLIENT_ID)
    const duplicate = enqueueFeishuAgentCommand(db, 'sync', undefined, TEST_CLIENT_ID)
    assert.equal(first.id, duplicate.id)
    assert.equal(first.status, 'pending')

    const heartbeat = recordFeishuAgentHeartbeat(db, testClient)
    assert.equal(heartbeat.commands.length, 1)
    assert.equal(heartbeat.commands[0]?.id, first.id)
    assert.equal(heartbeat.commands[0]?.status, 'running')
    assert.equal(getFeishuAgentBridgeStatus(db).activeCommand?.id, first.id)

    const completed = completeFeishuAgentCommand(db, first.id, {
      result: { fetched: 57, upserted: 57, archived: 1, skipped: 0 },
    }, TEST_CLIENT_ID)
    assert.equal(completed.status, 'succeeded')
    assert.deepEqual(completed.result, {
      fetched: 57,
      upserted: 57,
      archived: 1,
      skipped: 0,
    })
    const status = getFeishuAgentBridgeStatus(db)
    assert.equal(status.activeCommand, null)
    assert.equal(status.lastCommand?.id, first.id)
    assert.equal(status.lastCommand?.status, 'succeeded')

    const failed = enqueueFeishuAgentCommand(db, 'login_start', undefined, TEST_CLIENT_ID)
    completeFeishuAgentCommand(db, failed.id, { error: '授权服务不可用' }, TEST_CLIENT_ID)
    assert.equal(getFeishuAgentBridgeStatus(db).lastCommand?.status, 'failed')
    assert.equal(getFeishuAgentBridgeStatus(db).lastCommand?.error, '授权服务不可用')
  } finally {
    db.close()
  }
})

test('长命令心跳续租后不会被重复领取，停止续租后才允许重新领取', () => {
  const db = createDatabase({ filename: ':memory:' })
  try {
    recordFeishuAgentHeartbeat(db, testClient)
    const command = enqueueFeishuAgentCommand(db, 'sync', undefined, TEST_CLIENT_ID)
    const claimed = recordFeishuAgentHeartbeat(db, testClient)
    assert.equal(claimed.commands[0]?.id, command.id)

    const staleAt = new Date(Date.now() - 16 * 60_000).toISOString()
    const expireLease = () => {
      db.prepare(
        'UPDATE feishu_agent_commands SET claimed_at = ?, updated_at = ? WHERE id = ?',
      ).run(staleAt, staleAt, command.id)
    }

    expireLease()
    const renewed = recordFeishuAgentHeartbeat(db, {
      ...testClient,
      runningCommandIds: [command.id, command.id, '  '],
    })
    assert.deepEqual(renewed.commands, [])
    const row = db
      .prepare('SELECT status, claimed_at FROM feishu_agent_commands WHERE id = ?')
      .get(command.id) as { status: string; claimed_at: string }
    assert.equal(row.status, 'running')
    assert.ok(Date.parse(row.claimed_at) > Date.now() - 60_000)

    expireLease()
    const stillRenewed = recordFeishuAgentHeartbeat(db, {
      ...testClient,
      runningCommandIds: [command.id],
    })
    assert.deepEqual(stillRenewed.commands, [])
    assert.equal(getFeishuAgentBridgeStatus(db).activeCommand?.id, command.id)

    expireLease()
    const reclaimed = recordFeishuAgentHeartbeat(db, testClient)
    assert.equal(reclaimed.commands.length, 1)
    assert.equal(reclaimed.commands[0]?.id, command.id)
    assert.equal(reclaimed.commands[0]?.status, 'running')
  } finally {
    db.close()
  }
})

test('多个执行客户端分别上报状态且命令不会跨客户端领取', () => {
  const db = createDatabase({ filename: ':memory:' })
  try {
    const healthFor = (path: string) => ({
      ...health,
      config: { ...health.config, repoPaths: { 'repo-1': path } },
    })
    const clientA = {
      clientId: 'client-mac-a',
      clientName: '设计 Mac',
      machineName: 'machine-a',
      health: healthFor('/Users/a/work/repo-1'),
    }
    const clientB = {
      clientId: 'client-mac-b',
      clientName: '交付 Mac',
      machineName: 'machine-b',
      health: healthFor('/Users/b/work/repo-1'),
    }
    recordFeishuAgentHeartbeat(db, clientA)
    recordFeishuAgentHeartbeat(db, clientB)

    const all = getFeishuAgentBridgeStatus(db)
    assert.equal(all.clients.length, 2)
    assert.deepEqual(
      new Set(all.clients.map((client) => client.clientName)),
      new Set(['设计 Mac', '交付 Mac']),
    )
    const selectedA = getFeishuAgentBridgeStatus(db, 'client-mac-a')
    const selectedB = getFeishuAgentBridgeStatus(db, 'client-mac-b')
    assert.equal(selectedA.clientId, 'client-mac-a')
    assert.equal(selectedA.machineName, 'machine-a')
    assert.equal(selectedA.health?.config.repoPaths['repo-1'], '/Users/a/work/repo-1')
    assert.equal(selectedB.health?.config.repoPaths['repo-1'], '/Users/b/work/repo-1')

    const syncA = enqueueFeishuAgentCommand(db, 'sync', undefined, 'client-mac-a')
    const syncB = enqueueFeishuAgentCommand(db, 'sync', undefined, 'client-mac-b')
    assert.notEqual(syncA.id, syncB.id)
    assert.equal(syncA.clientId, 'client-mac-a')
    assert.equal(syncB.clientId, 'client-mac-b')
    assert.equal(
      enqueueFeishuAgentCommand(db, 'sync', undefined, 'client-mac-a').id,
      syncA.id,
    )

    const claimedA = recordFeishuAgentHeartbeat(db, clientA)
    assert.deepEqual(claimedA.commands.map((command) => command.id), [syncA.id])
    const claimedB = recordFeishuAgentHeartbeat(db, clientB)
    assert.deepEqual(claimedB.commands.map((command) => command.id), [syncB.id])
    assert.throws(
      () => completeFeishuAgentCommand(db, syncA.id, {}, 'client-mac-b'),
      (error: unknown) => error instanceof AppError && error.statusCode === 422,
    )
    assert.throws(
      () => completeFeishuAgentCommand(db, syncA.id, {}),
      (error: unknown) =>
        error instanceof AppError && /必须携带执行客户端标识/.test(error.message),
    )
    completeFeishuAgentCommand(db, syncA.id, {}, 'client-mac-a')
    completeFeishuAgentCommand(db, syncB.id, {}, 'client-mac-b')
    assert.equal(getFeishuAgentBridgeStatus(db, 'client-mac-a').lastCommand?.status, 'succeeded')
    assert.equal(getFeishuAgentBridgeStatus(db, 'client-mac-b').lastCommand?.status, 'succeeded')
  } finally {
    db.close()
  }
})

test('多个客户端在线时必须明确选择执行目标', () => {
  const db = createDatabase({ filename: ':memory:' })
  try {
    recordFeishuAgentHeartbeat(db, { clientId: 'client-a', clientName: 'A', health })
    assert.throws(
      () => enqueueFeishuAgentCommand(db, 'sync'),
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === 422 &&
        /选择要执行任务的客户端/.test(error.message),
    )
    recordFeishuAgentHeartbeat(db, { clientId: 'client-b', clientName: 'B', health })
    assert.throws(
      () => enqueueFeishuAgentCommand(db, 'sync'),
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === 422 &&
        /选择要执行任务的客户端/.test(error.message),
    )
    assert.throws(
      () => enqueueFeishuAgentCommand(db, 'sync', undefined, 'client-offline'),
      (error: unknown) => error instanceof AppError && error.statusCode === 422,
    )
  } finally {
    db.close()
  }
})

test('复制同一客户端配置的两台机器不能竞争领取命令', () => {
  const db = createDatabase({ filename: ':memory:' })
  try {
    recordFeishuAgentHeartbeat(db, {
      clientId: 'shared-client-id',
      clientName: '交付 Mac',
      machineName: 'machine-a',
      health,
    })
    assert.throws(
      () =>
        recordFeishuAgentHeartbeat(db, {
          clientId: 'shared-client-id',
          clientName: '交付 Mac',
          machineName: 'machine-b',
          health,
        }),
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === 422 &&
        /已被机器 machine-a 使用/.test(error.message),
    )
    const status = getFeishuAgentBridgeStatus(db, 'shared-client-id')
    assert.equal(status.machineName, 'machine-a')
    assert.equal(status.clients.length, 1)
  } finally {
    db.close()
  }
})

test('拒绝未知代理命令且代理状态表随数据库升级创建', () => {
  const db = createDatabase({ filename: ':memory:' })
  try {
    assert.throws(
      () => enqueueFeishuAgentCommand(db, 'shell'),
      (error: unknown) => error instanceof AppError && error.statusCode === 422,
    )
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('feishu_agent_state', 'feishu_agent_commands')
         ORDER BY name`,
      )
      .all() as { name: string }[]
    assert.deepEqual(
      tables.map((table) => table.name),
      ['feishu_agent_commands', 'feishu_agent_state'],
    )
  } finally {
    db.close()
  }
})

test('交付命令携带受控参数并通过进度接口回传七步状态', () => {
  const db = createDatabase({ filename: ':memory:' })
  try {
    recordFeishuAgentHeartbeat(db, testClient)
    const command = enqueueFeishuAgentCommand(db, 'delivery_start', {
      workItemId: 'REQ-1082',
      repoId: 'repo-1',
      autoCommit: true,
      pushAfterAcceptance: false,
      autoClose: false,
    }, TEST_CLIENT_ID)
    assert.equal(command.type, 'delivery_start')
    assert.equal(command.status, 'pending')
    assert.deepEqual(command.payload, {
      workItemId: 'REQ-1082',
      repoId: 'repo-1',
      autoCommit: true,
      pushAfterAcceptance: false,
      autoClose: false,
    })

    const claimed = recordFeishuAgentHeartbeat(db, testClient)
    assert.equal(claimed.commands[0]?.id, command.id)
    assert.deepEqual(claimed.commands[0]?.payload, command.payload)
    const running = completeFeishuAgentCommand(db, command.id, {
      result: { job: { id: 'delivery-test', status: 'running' } },
    }, TEST_CLIENT_ID)
    assert.equal(running.status, 'running')
    assert.equal(getFeishuAgentBridgeStatus(db).activeCommand?.id, command.id)

    const steps = [
      'connectivity',
      'analysis',
      'ldd',
      'coding',
      'evidence',
      'commit',
      'writeback',
    ].map((key) => ({
      key,
      name: key,
      description: key,
      status: 'success',
    }))
    const updated = updateFeishuAgentCommandProgress(db, command.id, {
      job: {
        id: 'delivery-test',
        commandId: command.id,
        status: 'succeeded',
        stage: '本机交付完成',
        workItemId: 'REQ-1082',
        repoId: 'repo-1',
        steps,
        startedAt: new Date().toISOString(),
        result: { commit: 'abcdef1234567', changedFiles: ['src/a.ts'] },
      },
    }, TEST_CLIENT_ID)
    assert.equal(updated.status, 'succeeded')
    assert.equal(
      (updated.result as { job: { steps: unknown[] } }).job.steps.length,
      7,
    )
  } finally {
    db.close()
  }
})

test('交付进度成功时会将运行中的命令收口为成功', () => {
  const db = createDatabase({ filename: ':memory:' })
  try {
    recordFeishuAgentHeartbeat(db, testClient)
    const command = enqueueFeishuAgentCommand(db, 'delivery_start', {
      workItemId: 'REQ-1083',
      repoId: 'repo-1',
      autoCommit: true,
      pushAfterAcceptance: false,
      autoClose: false,
    }, TEST_CLIENT_ID)
    const claimed = recordFeishuAgentHeartbeat(db, testClient)
    assert.equal(claimed.commands[0]?.id, command.id)

    const updated = updateFeishuAgentCommandProgress(db, command.id, {
      job: {
        id: 'delivery-progress-only',
        commandId: command.id,
        status: 'succeeded',
        stage: '本机交付完成',
        workItemId: 'REQ-1083',
        repoId: 'repo-1',
        steps: [],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        result: { commit: 'abcdef1234567' },
      },
    }, TEST_CLIENT_ID)
    assert.equal(updated.status, 'succeeded')
    assert.equal(getFeishuAgentBridgeStatus(db).activeCommand, null)
  } finally {
    db.close()
  }
})

test('版本 10 的代理命令表升级后保留旧命令并支持交付命令', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-agent-command-upgrade-'))
  const filename = join(directory, 'orbit.db')
  try {
    const oldDb = createDatabase({ filename })
    oldDb.exec(`
      DROP INDEX IF EXISTS idx_feishu_agent_commands_status;
      DROP TABLE feishu_agent_commands;
      CREATE TABLE feishu_agent_commands (
        id TEXT PRIMARY KEY,
        command_type TEXT NOT NULL CHECK (command_type IN ('login_start', 'sync', 'rotate_token')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT
      );
      INSERT INTO feishu_agent_commands
        (id, command_type, status, created_at, updated_at)
      VALUES ('legacy-command', 'sync', 'succeeded', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      PRAGMA user_version = 10;
    `)
    oldDb.close()

    const upgraded = createDatabase({ filename })
    const table = upgraded
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'feishu_agent_commands'",
      )
      .get() as { sql: string }
    assert.match(table.sql, /delivery_start/)
    assert.match(table.sql, /payload_json/)
    const legacy = upgraded
      .prepare('SELECT command_type, status FROM feishu_agent_commands WHERE id = ?')
      .get('legacy-command') as { command_type: string; status: string }
    assert.deepEqual(legacy, { command_type: 'sync', status: 'succeeded' })
    recordFeishuAgentHeartbeat(upgraded, testClient)
    assert.equal(
      enqueueFeishuAgentCommand(upgraded, 'delivery_start', {
        workItemId: 'REQ-1082',
        repoId: 'repo-1',
        autoCommit: true,
        pushAfterAcceptance: false,
        autoClose: false,
      }, TEST_CLIENT_ID).type,
      'delivery_start',
    )
    upgraded.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('版本 14 的代理命令升级后旧命令归属默认客户端', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-agent-client-upgrade-'))
  const filename = join(directory, 'orbit.db')
  try {
    const oldDb = createDatabase({ filename })
    oldDb.exec(`
      DROP INDEX IF EXISTS idx_feishu_agent_commands_status;
      DROP INDEX IF EXISTS idx_feishu_agent_commands_client_status;
      DROP TABLE feishu_agent_commands;
      CREATE TABLE feishu_agent_commands (
        id TEXT PRIMARY KEY,
        command_type TEXT NOT NULL CHECK (command_type IN ('login_start', 'sync', 'rotate_token', 'delivery_start')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
        payload_json TEXT,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT
      );
      INSERT INTO feishu_agent_commands
        (id, command_type, status, created_at, updated_at)
      VALUES ('legacy-v14-command', 'sync', 'succeeded', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      PRAGMA user_version = 14;
    `)
    oldDb.close()

    const upgraded = createDatabase({ filename })
    const columns = upgraded.pragma('table_info(feishu_agent_commands)') as { name: string }[]
    assert.equal(columns.some((column) => column.name === 'client_id'), true)
    const legacy = upgraded
      .prepare('SELECT client_id, status FROM feishu_agent_commands WHERE id = ?')
      .get('legacy-v14-command') as { client_id: string; status: string }
    assert.deepEqual(legacy, { client_id: 'primary', status: 'succeeded' })
    upgraded.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('版本 15 的代理状态升级后记录机器名并支持身份冲突校验', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-agent-machine-upgrade-'))
  const filename = join(directory, 'orbit.db')
  try {
    const oldDb = createDatabase({ filename })
    oldDb.exec(`
      DROP TABLE feishu_agent_state;
      CREATE TABLE feishu_agent_state (
        id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL DEFAULT '',
        health_json TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO feishu_agent_state
        (id, client_name, health_json, last_seen_at, created_at, updated_at)
      VALUES ('legacy-client', '旧客户端', '{}', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      PRAGMA user_version = 15;
    `)
    oldDb.close()

    const upgraded = createDatabase({ filename })
    const columns = upgraded.pragma('table_info(feishu_agent_state)') as { name: string }[]
    assert.equal(columns.some((column) => column.name === 'machine_name'), true)
    const legacy = upgraded
      .prepare('SELECT machine_name FROM feishu_agent_state WHERE id = ?')
      .get('legacy-client') as { machine_name: string }
    assert.equal(legacy.machine_name, '')
    recordFeishuAgentHeartbeat(upgraded, {
      clientId: 'legacy-client',
      clientName: '旧客户端',
      machineName: 'machine-upgraded',
      health,
    })
    assert.equal(
      getFeishuAgentBridgeStatus(upgraded, 'legacy-client').machineName,
      'machine-upgraded',
    )
    upgraded.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
