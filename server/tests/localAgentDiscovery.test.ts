import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  localAgentClientIdFromHealth,
  localAgentIsRegistered,
} from '../../src/localAgentDiscovery'
import type { FeishuAgentClientStatus } from '../../src/types'

test('本机代理健康响应只接受合法的客户端标识', () => {
  assert.equal(
    localAgentClientIdFromHealth({
      ok: true,
      config: { clientId: 'client-mac-harvey' },
    }),
    'client-mac-harvey',
  )
  assert.equal(
    localAgentClientIdFromHealth({ config: { clientId: '   ' } }),
    undefined,
  )
  assert.equal(
    localAgentClientIdFromHealth({ config: { clientId: '../other-client' } }),
    undefined,
  )
  assert.equal(localAgentClientIdFromHealth(null), undefined)
})

test('只有已注册到平台的本机客户端才能被自动选中', () => {
  const clients = [
    { clientId: 'client-local', online: true },
    { clientId: 'client-remote', online: true },
  ] as FeishuAgentClientStatus[]
  assert.equal(localAgentIsRegistered('client-local', clients), true)
  assert.equal(localAgentIsRegistered('client-missing', clients), false)
  assert.equal(localAgentIsRegistered(undefined, clients), false)
})
