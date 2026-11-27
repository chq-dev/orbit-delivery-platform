import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildMeegleResolutionFields,
  resolveMeegleDefect,
} from '../services/meegleResolutionService.js'

const metadata = {
  list: [
    {
      field_key: 'field_880d7e',
      field_name: '是否遗留BUG',
      field_type: 'select',
      option: [
        { option_id: 'legacy-yes', option_name: '是' },
        { option_id: 'legacy-no', option_name: '否' },
      ],
    },
    {
      field_key: 'field_e34974',
      field_name: '是否修订引入',
      field_type: 'select',
      option: [
        { option_id: 'introduced-yes', option_name: '是' },
        { option_id: 'introduced-no', option_name: '否' },
      ],
    },
    { field_key: 'field_953b68', field_name: '解决方案' },
    { field_key: 'field_462c75', field_name: '根因分析' },
    { field_key: 'field_b70e69', field_name: '影响面分析' },
  ],
}

test('Meegle 解决信息按字段名解析选项 ID 并生成五个字段', () => {
  assert.deepEqual(
    buildMeegleResolutionFields(metadata, {
      legacyBug: false,
      introduced: true,
      solution: '修复状态同步',
      rootCause: '遗漏断线重连分支',
      impact: '影响 AP 漫游',
    }),
    [
      { field_key: 'field_880d7e', field_value: { label: '否', value: 'legacy-no' } },
      {
        field_key: 'field_e34974',
        field_value: { label: '是', value: 'introduced-yes' },
      },
      { field_key: 'field_953b68', field_value: '修复状态同步' },
      { field_key: 'field_462c75', field_value: '遗漏断线重连分支' },
      { field_key: 'field_b70e69', field_value: '影响 AP 漫游' },
    ],
  )
})

test('Meegle 外部授权模式流转到已解决时同时提交解决字段', () => {
  const calls: string[][] = []
  const result = resolveMeegleDefect(
    'rjcloud:issue:9001',
    {
      legacyBug: false,
      introduced: false,
      solution: '修复样式层级',
      rootCause: '层级关系错误',
      impact: '影响问题日志列表',
    },
    (args) => {
      calls.push(args)
      if (args[0] === 'workflow' && args[1] === 'list-state-transitions') {
        return {
          state_key: 'OPEN',
          state_name: '新',
          transition: [
            { id: 123456, state_key: 'RESOLVED', state_name: '已解决' },
          ],
        }
      }
      if (args[0] === 'workitem' && args[1] === 'meta-fields') return metadata
      if (args[0] === 'workflow' && args[1] === 'transition-state') {
        return { data: {} }
      }
      throw new Error(`unexpected args: ${args.join(' ')}`)
    },
  )

  assert.equal(result.stateKey, 'RESOLVED')
  assert.equal(result.transitionId, '123456')
  const transitionCall = calls.find((args) => args[1] === 'transition-state')
  assert.ok(transitionCall)
  const paramsIndex = transitionCall.indexOf('--params')
  const params = JSON.parse(transitionCall[paramsIndex + 1]) as {
    fields: Array<{ field_key: string; field_value: unknown }>
  }
  assert.equal(params.fields.length, 5)
  assert.deepEqual(params.fields[0], {
    field_key: 'field_880d7e',
    field_value: { label: '否', value: 'legacy-no' },
  })
})

test('Meegle 外部授权模式已解决时直接返回无需重复流转', () => {
  const calls: string[][] = []
  const result = resolveMeegleDefect(
    'rjcloud:issue:9001',
    {
      legacyBug: false,
      introduced: false,
      solution: '已解决',
      rootCause: '已解决',
      impact: '已解决',
    },
    (args) => {
      calls.push(args)
      if (args[0] === 'workflow' && args[1] === 'list-state-transitions') {
        return { state_key: 'RESOLVED', state_name: '已解决', transition: [] }
      }
      if (args[0] === 'workitem' && args[1] === 'meta-fields') return metadata
      if (args[0] === 'workitem' && args[1] === 'update') return { data: {} }
      throw new Error(`unexpected args: ${args.join(' ')}`)
    },
  )
  assert.equal(result.alreadyResolved, true)
  assert.equal(result.fieldsUpdated, true)
  assert.equal(result.stateKey, 'RESOLVED')
  assert.ok(calls.some((args) => args[1] === 'update'))
})
