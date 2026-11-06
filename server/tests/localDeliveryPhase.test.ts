import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  deliveryDesignReportExists,
  deliveryArtifactFiles,
  deliveryWorkspaceFiles,
  inferDeliveryCodexPhase,
  latestDeliveryArtifactActivity,
  nextDeliveryCodexPhase,
  parseDeliveryCodexPhase,
  parseGitStatusPaths,
  parseGitNumstat,
  readDeliveryCodexPhaseMarker,
  resetDeliveryCodexPhaseMarker,
} from '../services/localDeliveryPhase.js'

test('交付阶段只接受已知阶段值', () => {
  assert.equal(parseDeliveryCodexPhase(' ldd\n'), 'ldd')
  assert.equal(parseDeliveryCodexPhase('analysis'), 'analysis')
  assert.equal(parseDeliveryCodexPhase('commit'), undefined)
  assert.equal(parseDeliveryCodexPhase(undefined), undefined)
})

test('阶段标记只能单向前进，不会被轮询回退', () => {
  assert.equal(nextDeliveryCodexPhase(undefined, 'analysis'), 'analysis')
  assert.equal(nextDeliveryCodexPhase('analysis', 'ldd'), 'ldd')
  assert.equal(nextDeliveryCodexPhase('coding', 'ldd'), undefined)
  assert.equal(nextDeliveryCodexPhase('ldd', 'ldd'), undefined)
})

test('仅有设计报告时推进到业务 LDD 阶段', () => {
  assert.equal(inferDeliveryCodexPhase([], { designReport: true }), 'ldd')
  assert.equal(inferDeliveryCodexPhase([], { designReport: false }), undefined)
})

test('LDD 修改推进到业务 LDD，源码修改推进到业务编码', () => {
  assert.equal(
    inferDeliveryCodexPhase(['web/docs/ldd/SME-模式切换-LDD.md']),
    'ldd',
  )
  assert.equal(
    inferDeliveryCodexPhase(['web/src/pages/ModeSwitch.tsx']),
    'coding',
  )
  assert.equal(
    inferDeliveryCodexPhase([
      'web/docs/ldd/SME-模式切换-LDD.md',
      'web/src/pages/ModeSwitch.tsx',
    ]),
    'coding',
  )
})

test('交付产物目录不参与阶段推断，避免提示词和截图误判为代码', () => {
  assert.equal(
    inferDeliveryCodexPhase([
      'delivery-artifacts/REQ-1082/codex-prompt.md',
      'delivery-artifacts/REQ-1082/requirement-assets/design.png',
    ]),
    undefined,
  )
})

test('工作区阶段标记优先于文件推断', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'orbit-phase-'))
  const artifactDir = join(checkout, 'delivery-artifacts', 'REQ-1082')
  try {
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, '.phase-current'), 'ldd\n')
    writeFileSync(join(artifactDir, 'design-report.md'), '# 设计报告\n')
    assert.equal(readDeliveryCodexPhaseMarker(checkout, 'REQ-1082'), 'ldd')
    assert.equal(deliveryDesignReportExists(checkout, 'REQ-1082'), true)
    resetDeliveryCodexPhaseMarker(checkout, 'REQ-1082')
    assert.equal(readDeliveryCodexPhaseMarker(checkout, 'REQ-1082'), undefined)
  } finally {
    rmSync(checkout, { recursive: true, force: true })
  }
})

test('解析 git status -z，包含重命名前后的路径', () => {
  assert.deepEqual(
    parseGitStatusPaths(
      ' M web/src/pages/ModeSwitch.tsx\0?? web/docs/ldd/SME-模式切换-LDD.md\0R  web/src/new.ts\0web/src/old.ts\0',
    ),
    [
      'web/src/pages/ModeSwitch.tsx',
      'web/docs/ldd/SME-模式切换-LDD.md',
      'web/src/new.ts',
      'web/src/old.ts',
    ],
  )
})

test('交付进度统计排除产物目录并汇总增删行数', () => {
  assert.deepEqual(
    deliveryWorkspaceFiles([
      'web/src/PrivateMetric.ts',
      'delivery-artifacts/REQ-1082/design-report.md',
      'delivery-artifacts/',
    ]),
    ['web/src/PrivateMetric.ts'],
  )
  assert.deepEqual(
    deliveryArtifactFiles([
      'web/src/PrivateMetric.ts',
      'delivery-artifacts/REQ-1082/build.log',
    ]),
    ['delivery-artifacts/REQ-1082/build.log'],
  )
  assert.deepEqual(
    parseGitNumstat(
      '12\t3\tweb/src/PrivateMetric.ts\n-\t-\tweb/public/icon.png\n9\t1\tdelivery-artifacts/REQ-1082/build.log\n',
    ),
    { added: 12, removed: 3 },
  )
})

test('交付产物更新时间用于确认构建或测试仍在写入日志', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'orbit-artifact-'))
  const artifactDir = join(checkout, 'delivery-artifacts', 'REQ-1082')
  try {
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, 'build.log'), 'build started\n')
    const activity = latestDeliveryArtifactActivity(checkout, [
      'delivery-artifacts/REQ-1082/build.log',
      'web/src/PrivateMetric.ts',
    ])
    assert.equal(activity?.path, 'delivery-artifacts/REQ-1082/build.log')
    assert.ok(activity?.modifiedAt)
  } finally {
    rmSync(checkout, { recursive: true, force: true })
  }
})
