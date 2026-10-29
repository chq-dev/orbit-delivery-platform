import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildFeishuSyncInstruction } from '../../src/feishuSyncInstruction'

test('Codex 飞书同步指令要求本机全量同步并校验平台结果', () => {
  const instruction = buildFeishuSyncInstruction({
    apiBase: 'http://8.145.45.84:8787/',
    projectKey: 'rjcloud',
  })

  assert.match(instruction, /^\s*Use \$feishu-project-sync/m)
  assert.match(instruction, /meegle auth status --format json/)
  assert.match(instruction, /PLATFORM_BASE_URL=http:\/\/8\.145\.45\.84:8787/)
  assert.match(instruction, /FEISHU_SYNC_FULL=true npm run sync:feishu/)
  assert.match(instruction, /npm run sync:feishu:watch/)
  assert.match(instruction, /api\/work-items/)
  assert.match(instruction, /do not put the token in frontend code/i)
  assert.doesNotMatch(instruction, /localhost/)
})
