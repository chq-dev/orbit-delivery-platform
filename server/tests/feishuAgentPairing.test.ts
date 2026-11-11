import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { createDatabase, type AppDatabase } from '../db/database.js'
import { AppError } from '../domain/errors.js'
import {
  enqueueFeishuAgentCommand,
  getFeishuAgentBridgeStatus,
  recordFeishuAgentHeartbeat,
} from '../services/feishuAgentBridgeService.js'
import {
  approveFeishuAgentPairing,
  listFeishuAgentPairings,
  requestFeishuAgentPairing,
} from '../services/feishuAgentPairingService.js'

function insertUser(db: AppDatabase, id: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO users
      (id, username, username_normalized, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, 'hash', ?, ?)`,
  ).run(id, id, id, createdAt, createdAt)
}

function pairingRequest(clientId: string) {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return {
    clientId,
    clientName: `${clientId} 客户端`,
    machineName: `${clientId}-machine`,
    platformBaseUrl: 'https://orbit.example.com',
    projectKey: 'rjcloud',
    publicKey,
    pairingSecret: randomBytes(32).toString('hex'),
  }
}

function heartbeat(clientId: string) {
  return {
    clientId,
    clientName: `${clientId} 客户端`,
    machineName: `${clientId}-machine`,
    health: {
      ok: true,
      config: { configured: true, projectKey: 'rjcloud', repoPaths: {} },
      meegle: { available: true, authenticated: true },
      running: false,
      lastRun: null,
      pendingLogin: null,
    },
  }
}

test('客户端绑定归属审批账号，普通账号只能看到自己的客户端', () => {
  const db = createDatabase({ filename: ':memory:' })
  try {
    insertUser(db, 'owner-a', '2026-01-01T00:00:00.000Z')
    insertUser(db, 'owner-b', '2026-01-02T00:00:00.000Z')
    insertUser(db, 'owner-c', '2026-01-03T00:00:00.000Z')

    assert.equal(requestFeishuAgentPairing(db, pairingRequest('client-a'), '10.0.0.1').status, 'pending')
    assert.equal(requestFeishuAgentPairing(db, pairingRequest('client-b'), '10.0.0.2').status, 'pending')

    assert.deepEqual(
      listFeishuAgentPairings(db, 'owner-b').map((pairing) => pairing.clientId).sort(),
      ['client-a', 'client-b'],
    )
    assert.equal(approveFeishuAgentPairing(db, 'client-a', {}, 'owner-b').status, 'approved')
    assert.equal(approveFeishuAgentPairing(db, 'client-b', {}, 'owner-c').status, 'approved')

    assert.deepEqual(
      listFeishuAgentPairings(db, 'owner-b').map((pairing) => pairing.clientId),
      ['client-a'],
    )
    assert.deepEqual(
      listFeishuAgentPairings(db, 'owner-c').map((pairing) => pairing.clientId),
      ['client-b'],
    )
    assert.deepEqual(
      listFeishuAgentPairings(db, 'owner-a').map((pairing) => pairing.clientId).sort(),
      ['client-a', 'client-b'],
    )
    assert.throws(
      () => approveFeishuAgentPairing(db, 'client-a', {}, 'owner-c'),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    )

    recordFeishuAgentHeartbeat(db, heartbeat('client-a'))
    recordFeishuAgentHeartbeat(db, heartbeat('client-b'))

    assert.deepEqual(
      getFeishuAgentBridgeStatus(db, undefined, 'owner-b').clients.map((client) => client.clientId),
      ['client-a'],
    )
    assert.deepEqual(
      getFeishuAgentBridgeStatus(db, undefined, 'owner-c').clients.map((client) => client.clientId),
      ['client-b'],
    )
    assert.deepEqual(
      getFeishuAgentBridgeStatus(db, undefined, 'owner-a').clients
        .map((client) => client.clientId)
        .sort(),
      ['client-a', 'client-b'],
    )

    assert.equal(
      enqueueFeishuAgentCommand(db, 'sync', undefined, 'client-a', 'owner-b').clientId,
      'client-a',
    )
    assert.throws(
      () => enqueueFeishuAgentCommand(db, 'sync', undefined, 'client-a', 'owner-c'),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    )
  } finally {
    db.close()
  }
})
