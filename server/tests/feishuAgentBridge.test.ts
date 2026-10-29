import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDatabase } from '../db/database.js'
import { AppError } from '../domain/errors.js'
import {
  completeFeishuAgentCommand,
  enqueueFeishuAgentCommand,
  getFeishuAgentBridgeStatus,
  recordFeishuAgentHeartbeat,
  sanitizeFeishuAgentHealth,
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
      staleAfterSeconds: 45,
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
      new Date(Date.now() - 60_000).toISOString(),
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
