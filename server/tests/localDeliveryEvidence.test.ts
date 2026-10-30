import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  deliveryCodeFiles,
  deliveryCommitMessage,
  isDeliveryCodeFile,
  normalizeDeliveryPath,
} from '../services/localDeliveryEvidence.js'

test('交付成功判定排除提示词、设计报告和其他 Markdown 说明文件', () => {
  assert.equal(isDeliveryCodeFile('delivery-artifacts/REQ-1082/codex-prompt.md'), false)
  assert.equal(isDeliveryCodeFile('delivery-artifacts/REQ-1082/build.log'), false)
  assert.equal(isDeliveryCodeFile('docs/REQ-1082/design.md'), false)
  assert.equal(isDeliveryCodeFile('docs/REQ-1082/verify.txt'), false)
  assert.equal(isDeliveryCodeFile('web/components/utils/metrics.ts'), true)
  assert.equal(isDeliveryCodeFile('lua/service/dhcp.lua'), true)
})

test('交付代码文件去重并兼容 Windows 路径分隔符', () => {
  assert.deepEqual(
    deliveryCodeFiles([
      './web/components/utils/metrics.ts',
      'web\\components\\utils\\metrics.ts',
      'docs/REQ-1082/design.md',
      'delivery-artifacts/REQ-1082/codex-prompt.md',
      'lua/service/dhcp.lua',
    ]),
    ['web/components/utils/metrics.ts', 'lua/service/dhcp.lua'],
  )
  assert.equal(normalizeDeliveryPath('.\\web\\a.ts'), 'web/a.ts')
})

test('交付提交标题使用工作项编号且保持单行', () => {
  assert.equal(
    deliveryCommitMessage('REQ-1082', '  第三方纳管\n私有监控指标  '),
    'REQ-1082: 第三方纳管 私有监控指标',
  )
  assert.equal(deliveryCommitMessage('REQ-1', ''), 'REQ-1: 本地交付')
})
