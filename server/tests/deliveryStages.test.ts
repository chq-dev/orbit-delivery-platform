import assert from 'node:assert/strict'
import { test } from 'node:test'
import { displayDeliveryStages } from '../../src/deliveryStages.js'
import type { PipelineStage } from '../../src/types.js'

function stage(
  key: string,
  name: string,
  status: PipelineStage['status'],
  log?: string,
): PipelineStage {
  return { key, name, description: `${name}说明`, status, log }
}

test('流水线展示统一为弹窗的七步核心流程并追加真实执行的编译与升级', () => {
  const stages = displayDeliveryStages([
    stage('analysis', '需求分析', 'success', '平台与客户端仓库校验通过'),
    stage('design', '业务 LDD', 'success'),
    stage('coding', '业务编码', 'success'),
    stage('integration', '检查证据', 'success'),
    stage('commit', '提交推送', 'success'),
    stage('build', '自动编译', 'success'),
    stage('upgrade', '设备升级', 'pending', '未启用设备升级'),
    stage('test', '自动化测试', 'pending'),
    stage('report', '回写并关闭缺陷', 'success'),
  ])

  assert.deepEqual(
    stages.map((entry) => entry.key),
    ['connectivity', 'analysis', 'ldd', 'coding', 'evidence', 'commit', 'build', 'writeback'],
  )
  assert.deepEqual(
    stages.map((entry) => entry.name),
    ['连通性校验', '需求分析', '业务 LDD', '业务编码', '检查证据', '提交推送', '自动编译', '回写并关闭缺陷'],
  )
})

test('未执行的编译和升级步骤不展示，失败状态仍保留', () => {
  const pending = displayDeliveryStages([
    stage('analysis', '需求分析', 'success'),
    stage('build', '自动编译', 'pending', '等待本机执行'),
    stage('upgrade', '设备升级', 'pending', '等待本机执行'),
    stage('report', '回写并关闭缺陷', 'success'),
  ])
  assert.deepEqual(
    pending.map((entry) => entry.key),
    ['connectivity', 'analysis', 'writeback'],
  )

  const failed = displayDeliveryStages([
    stage('analysis', '需求分析', 'success'),
    stage('build', '自动编译', 'pending', '触发 Jenkins 编译失败'),
    stage('report', '回写并关闭缺陷', 'failed'),
  ])
  assert.deepEqual(
    failed.map((entry) => entry.key),
    ['connectivity', 'analysis', 'build', 'writeback'],
  )
})

test('已有连通性步骤时不会重复插入', () => {
  const stages = displayDeliveryStages([
    stage('connectivity', '连通性校验', 'success'),
    stage('analysis', '需求分析', 'running', '正在分析影响模块'),
  ])
  assert.deepEqual(
    stages.map((entry) => entry.key),
    ['connectivity', 'analysis'],
  )
  assert.equal(stages[1].status, 'running')
})

test('缺陷交付隐藏业务 LDD 步骤并使用缺陷分析文案', () => {
  const stages = displayDeliveryStages(
    [
      stage('connectivity', '连通性校验', 'success'),
      stage('analysis', '需求分析', 'success'),
      stage('ldd', '业务 LDD', 'success'),
      stage('coding', '业务编码', 'success'),
      stage('evidence', '检查证据', 'success'),
      stage('commit', '提交推送', 'success'),
      stage('writeback', '回写并关闭缺陷', 'success'),
    ],
    'defect',
  )

  assert.deepEqual(
    stages.map((entry) => entry.key),
    ['connectivity', 'analysis', 'coding', 'evidence', 'commit', 'writeback'],
  )
  assert.equal(stages[1].name, '缺陷分析')
  assert.match(stages[1].description, /复现条件/)
  assert.match(stages[2].description, /修复方案/)
})
