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

const health = {
  ok: true,
  version: 3,
  config: {
    configured: true,
    platformBaseUrl: 'http://8.145.45.84:8787',
    projectKey: 'rjcloud',
    repoId: 'repo-1',
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

test('代理心跳只保存脱敏状态并据此判断在线', () => {
  const db = createDatabase({ filename: ':memory:' })
  try {
    assert.deepEqual(getFeishuAgentBridgeStatus(db), {
      online: false,
      lastSeenAt: undefined,
      staleAfterSeconds: 90,
      health: undefined,
      activeCommand: null,
      lastCommand: null,
      commands: [],
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

    const heartbeat = recordFeishuAgentHeartbeat(db, { health })
    assert.ok(heartbeat.lastSeenAt)
    const status = getFeishuAgentBridgeStatus(db)
    assert.equal(status.online, true)
    assert.equal(status.health?.config.repoId, 'repo-1')
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
    const first = enqueueFeishuAgentCommand(db, 'sync')
    const duplicate = enqueueFeishuAgentCommand(db, 'sync')
    assert.equal(first.id, duplicate.id)
    assert.equal(first.status, 'pending')

    const heartbeat = recordFeishuAgentHeartbeat(db, { health })
    assert.equal(heartbeat.commands.length, 1)
    assert.equal(heartbeat.commands[0]?.id, first.id)
    assert.equal(heartbeat.commands[0]?.status, 'running')
    assert.equal(getFeishuAgentBridgeStatus(db).activeCommand?.id, first.id)

    const completed = completeFeishuAgentCommand(db, first.id, {
      result: { fetched: 57, upserted: 57, archived: 1, skipped: 0 },
    })
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

    const failed = enqueueFeishuAgentCommand(db, 'login_start')
    completeFeishuAgentCommand(db, failed.id, { error: '授权服务不可用' })
    assert.equal(getFeishuAgentBridgeStatus(db).lastCommand?.status, 'failed')
    assert.equal(getFeishuAgentBridgeStatus(db).lastCommand?.error, '授权服务不可用')
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
    const command = enqueueFeishuAgentCommand(db, 'delivery_start', {
      workItemId: 'REQ-1082',
      repoId: 'repo-1',
      autoCommit: true,
      pushAfterAcceptance: false,
      autoClose: false,
    })
    assert.equal(command.type, 'delivery_start')
    assert.equal(command.status, 'pending')
    assert.deepEqual(command.payload, {
      workItemId: 'REQ-1082',
      repoId: 'repo-1',
      autoCommit: true,
      pushAfterAcceptance: false,
      autoClose: false,
    })

    const claimed = recordFeishuAgentHeartbeat(db, { health })
    assert.equal(claimed.commands[0]?.id, command.id)
    assert.deepEqual(claimed.commands[0]?.payload, command.payload)
    completeFeishuAgentCommand(db, command.id, {
      result: { job: { id: 'delivery-test', status: 'running' } },
    })

    const steps = [
      'platform',
      'contract',
      'checkout',
      'codex',
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
    })
    assert.equal(updated.status, 'succeeded')
    assert.equal(
      (updated.result as { job: { steps: unknown[] } }).job.steps.length,
      7,
    )
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
    assert.equal(
      enqueueFeishuAgentCommand(upgraded, 'delivery_start', {
        workItemId: 'REQ-1082',
        repoId: 'repo-1',
        autoCommit: true,
        pushAfterAcceptance: false,
        autoClose: false,
      }).type,
      'delivery_start',
    )
    upgraded.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
