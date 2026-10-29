import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectWorkItemFilterValues,
  filterWorkItems,
  hasActiveWorkItemFilters,
  splitWorkItemValues,
  type WorkItemFilters,
} from '../../src/workItemFilters'
import type { WorkItem } from '../../src/types'

const baseFilters: WorkItemFilters = {
  type: 'all',
  platformStatus: 'all',
  feishuStatus: '',
  projectLine: '',
  owner: '',
  search: '',
}

const items: WorkItem[] = [
  {
    id: 'REQ-1',
    type: 'requirement',
    title: 'CNC DHCP 配置',
    description: '',
    priority: '高',
    status: '进行中',
    repoId: 'repo-1',
    branch: 'dev-harvey',
    owner: '刘清',
    updatedAt: '2026-10-29',
    createdAt: '2026-10-28',
    source: 'feishu',
    externalId: 'rjcloud:story:6955195522',
    feishuStatus: '转测试',
    projectLine: 'MACC,EWEB',
  },
  {
    id: 'BUG-1',
    type: 'defect',
    title: '日语产品列表出现英文',
    description: '',
    priority: '中',
    status: '待处理',
    repoId: 'repo-1',
    branch: 'dev-harvey',
    owner: '林维城,刘清',
    updatedAt: '2026-10-29',
    createdAt: '2026-10-28',
    source: 'feishu',
    externalId: 'rjcloud:issue:7149778878',
    feishuStatus: '新',
    projectLine: '售前营销服',
  },
]

test('项目线、飞书状态和负责人按飞书多值字段过滤', () => {
  assert.deepEqual(splitWorkItemValues('MACC, EWEB，MACC'), ['MACC', 'EWEB'])
  assert.deepEqual(
    filterWorkItems(items, { ...baseFilters, projectLine: 'MACC' }).map((item) => item.id),
    ['REQ-1'],
  )
  assert.deepEqual(
    filterWorkItems(items, { ...baseFilters, feishuStatus: '新' }).map((item) => item.id),
    ['BUG-1'],
  )
  assert.deepEqual(
    filterWorkItems(items, { ...baseFilters, owner: '刘清' }).map((item) => item.id),
    ['REQ-1', 'BUG-1'],
  )
  assert.deepEqual(
    filterWorkItems(items, { ...baseFilters, type: 'requirement' }).map((item) => item.id),
    ['REQ-1'],
  )
  assert.deepEqual(
    filterWorkItems(items, { ...baseFilters, search: 'eweb' }).map((item) => item.id),
    ['REQ-1'],
  )
})

test('筛选选项去重并排序，且能识别是否启用了筛选', () => {
  assert.deepEqual(collectWorkItemFilterValues(items, 'projectLine'), [
    '售前营销服',
    'EWEB',
    'MACC',
  ])
  assert.deepEqual(collectWorkItemFilterValues(items, 'owner'), ['林维城', '刘清'])
  assert.deepEqual(collectWorkItemFilterValues(items, 'feishuStatus'), ['新', '转测试'])
  assert.equal(hasActiveWorkItemFilters(baseFilters), false)
  assert.equal(hasActiveWorkItemFilters({ ...baseFilters, projectLine: 'MACC' }), true)
})
