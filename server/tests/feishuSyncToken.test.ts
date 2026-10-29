import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { config } from '../config.js'
import { createDatabase } from '../db/database.js'
import { AppError } from '../domain/errors.js'
import { assertFeishuIngestAuthorized } from '../security/ingestAuth.js'
import {
  bootstrapFeishuSyncToken,
  getFeishuSyncTokenStatus,
  rotateFeishuSyncToken,
  verifyFeishuSyncToken,
} from '../services/feishuSyncTokenService.js'

function withDatabaseTokenEnvironment(run: () => void): void {
  const originalConfig = { ...config }
  Object.assign(config, { feishuIngestToken: '' })
  try {
    run()
  } finally {
    Object.assign(config, originalConfig)
  }
}

test('平台同步密钥只保存哈希，支持验证和轮换且旧密钥立即失效', () => {
  withDatabaseTokenEnvironment(() => {
    const db = createDatabase({ filename: ':memory:' })
    try {
      assert.deepEqual(getFeishuSyncTokenStatus(db), {
        configured: false,
        source: 'none',
      })

      const boot = bootstrapFeishuSyncToken(db)
      assert.match(boot.token, /^[a-f0-9]{64}$/)
      assert.equal(boot.status.source, 'database')
      assert.equal(boot.status.configured, true)
      assert.equal(verifyFeishuSyncToken(db, boot.token), true)
      assert.equal(verifyFeishuSyncToken(db, 'wrong-token'), false)

      const row = db
        .prepare(
          'SELECT token_hash, token_hint, created_at, updated_at FROM feishu_sync_credentials WHERE id = ?',
        )
        .get('feishu-ingest') as {
        token_hash: string
        token_hint: string
        created_at: string
        updated_at: string
      }
      assert.equal(row.token_hash, createHash('sha256').update(boot.token).digest('hex'))
      assert.notEqual(row.token_hash, boot.token)
      assert.equal(row.token_hint, `••••${boot.token.slice(-4)}`)
      assert.equal(JSON.stringify(row).includes(boot.token), false)
      assert.equal(row.updated_at, row.created_at)

      assert.throws(
        () => bootstrapFeishuSyncToken(db),
        (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
      )
      assert.throws(
        () => rotateFeishuSyncToken(db, 'wrong-token'),
        (error: unknown) =>
          error instanceof AppError && error.code === 'FEISHU_INGEST_UNAUTHORIZED',
      )

      const rotated = rotateFeishuSyncToken(db, boot.token)
      assert.match(rotated.token, /^[a-f0-9]{64}$/)
      assert.notEqual(rotated.token, boot.token)
      assert.equal(verifyFeishuSyncToken(db, boot.token), false)
      assert.equal(verifyFeishuSyncToken(db, rotated.token), true)
      const rotatedRow = db
        .prepare('SELECT token_hash, token_hint FROM feishu_sync_credentials WHERE id = ?')
        .get('feishu-ingest') as { token_hash: string; token_hint: string }
      assert.equal(
        rotatedRow.token_hash,
        createHash('sha256').update(rotated.token).digest('hex'),
      )
      assert.equal(rotatedRow.token_hint, `••••${rotated.token.slice(-4)}`)
      assert.equal(JSON.stringify(rotatedRow).includes(rotated.token), false)

      const table = db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('feishu_sync_credentials') as { count: number }
      assert.equal(table.count, 1)
      assert.equal(db.pragma('user_version', { simple: true }), 9)
    } finally {
      db.close()
    }
  })
})

test('Ingest 鉴权可使用数据库中的哈希密钥验证远端请求', () => {
  withDatabaseTokenEnvironment(() => {
    const db = createDatabase({ filename: ':memory:' })
    try {
      const boot = bootstrapFeishuSyncToken(db)
      const verifyStoredToken = (token: string) => verifyFeishuSyncToken(db, token)
      assert.doesNotThrow(() =>
        assertFeishuIngestAuthorized(
          {
            headers: { authorization: `Bearer ${boot.token}` },
            ip: '10.0.0.8',
          },
          '',
          verifyStoredToken,
        ),
      )
      assert.throws(
        () =>
          assertFeishuIngestAuthorized(
            {
              headers: { authorization: 'Bearer wrong-token' },
              ip: '10.0.0.8',
            },
            '',
            verifyStoredToken,
          ),
        (error: unknown) =>
          error instanceof AppError && error.code === 'FEISHU_INGEST_UNAUTHORIZED',
      )
    } finally {
      db.close()
    }
  })
})

test('环境变量管理的密钥优先且不允许在页面轮换', () => {
  const originalConfig = { ...config }
  Object.assign(config, { feishuIngestToken: 'environment-managed-sync-token' })
  const db = createDatabase({ filename: ':memory:' })
  try {
    const status = getFeishuSyncTokenStatus(db)
    assert.equal(status.configured, true)
    assert.equal(status.source, 'env')
    assert.equal(status.hint, '••••oken')
    assert.throws(
      () => rotateFeishuSyncToken(db, 'environment-managed-sync-token'),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    )
  } finally {
    Object.assign(config, originalConfig)
    db.close()
  }
})
