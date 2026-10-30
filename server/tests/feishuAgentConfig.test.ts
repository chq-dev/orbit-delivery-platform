import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseFeishuAgentConfig,
  publicFeishuAgentConfig,
  validateFeishuAgentConfig,
} from '../services/feishuAgentConfig.js'

test('本机代理公开状态不包含平台同步密钥', () => {
  const token = 'agent-secret-token-with-enough-length'
  const config = parseFeishuAgentConfig({
    platformBaseUrl: 'http://8.145.45.84:8787/',
    syncToken: token,
    projectKey: 'rjcloud',
    repoId: 'repo-1',
  })
  assert.ok(config)
  const publicConfig = publicFeishuAgentConfig(config)
  assert.deepEqual(publicConfig, {
    configured: true,
    platformBaseUrl: 'http://8.145.45.84:8787',
    projectKey: 'rjcloud',
    repoId: 'repo-1',
    repoPaths: {},
  })
  assert.equal(JSON.stringify(publicConfig).includes(token), false)
  assert.equal('syncToken' in publicConfig, false)
})

test('本机代理配置校验只接受合法平台地址和足够长的密钥', () => {
  const valid = validateFeishuAgentConfig({
    platformBaseUrl: 'https://orbit.example.com/',
    syncToken: '0123456789abcdef',
    projectKey: 'rjcloud',
  })
  assert.deepEqual(valid, {
    platformBaseUrl: 'https://orbit.example.com',
    syncToken: '0123456789abcdef',
    projectKey: 'rjcloud',
    repoId: undefined,
    repoPaths: {},
  })
  assert.throws(() => validateFeishuAgentConfig({ platformBaseUrl: 'ftp://example.com', syncToken: '0123456789abcdef' }))
  assert.throws(() => validateFeishuAgentConfig({ platformBaseUrl: 'http://localhost:8787', syncToken: 'short' }))
  assert.throws(() =>
    validateFeishuAgentConfig({
      platformBaseUrl: 'http://localhost:8787',
      syncToken: '0123456789abcdef',
      projectKey: 'bad project',
    }),
  )
  assert.throws(() =>
    validateFeishuAgentConfig({
      platformBaseUrl: 'http://localhost:8787',
      syncToken: '0123456789abcdef',
      repoPaths: { 'repo-1': 'relative/path' },
    }),
  )
})

test('本机代理保存仓库专属路径且公开状态不泄漏密钥', () => {
  const config = parseFeishuAgentConfig({
    platformBaseUrl: 'http://8.145.45.84:8787',
    syncToken: 'agent-secret-token-with-enough-length',
    repoPaths: {
      'repo-1': '/Users/shinya/Documents/workspace/SME/basic-component-cloud',
      'bad key': '/tmp/ignored',
      'repo-2': 'relative/ignored',
    },
  })
  assert.ok(config)
  assert.deepEqual(config.repoPaths, {
    'repo-1': '/Users/shinya/Documents/workspace/SME/basic-component-cloud',
  })
  assert.equal(
    JSON.stringify(publicFeishuAgentConfig(config)).includes('agent-secret'),
    false,
  )
})
