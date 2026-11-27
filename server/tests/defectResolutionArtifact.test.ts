import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDefectResolutionArtifact } from '../services/defectResolutionArtifact.js'

test('自动生成的飞书解决报告按章节解析五个字段', () => {
  assert.deepEqual(
    parseDefectResolutionArtifact(`# 飞书缺陷解决报告

## 是否遗留BUG
否

## 是否修订引入
是

## 解决方案
统一问题日志列表的根因列配置，并补充设备健康度维度。

## 根因分析
设备健康度维度复用了旧的列配置，未包含根因字段。

## 影响面分析
影响 MACC 鹰眼设备健康度问题日志列表，以及相同配置来源的其他维度。
`),
    {
      legacyBug: false,
      introduced: true,
      solution: '统一问题日志列表的根因列配置，并补充设备健康度维度。',
      rootCause: '设备健康度维度复用了旧的列配置，未包含根因字段。',
      impact: '影响 MACC 鹰眼设备健康度问题日志列表，以及相同配置来源的其他维度。',
    },
  )
})

test('自动生成的飞书解决报告支持 JSON 内容', () => {
  assert.deepEqual(
    parseDefectResolutionArtifact(`\`\`\`json
{"legacyBug":false,"introduced":false,"solution":"修复样式","rootCause":"层级错误","impact":"影响问题列表"}
\`\`\``),
    {
      legacyBug: false,
      introduced: false,
      solution: '修复样式',
      rootCause: '层级错误',
      impact: '影响问题列表',
    },
  )
})

test('缺少字段的自动解决报告会被拒绝', () => {
  assert.throws(
    () => parseDefectResolutionArtifact('## 解决方案\n仅有一段内容'),
    /是否遗留BUG/,
  )
})
