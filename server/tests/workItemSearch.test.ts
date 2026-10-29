import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchWorkItems } from '../../src/workItemSearch'
import type { WorkItem } from '../../src/types'

function item(overrides: Partial<WorkItem> & Pick<WorkItem, 'id' | 'type' | 'title'>): WorkItem {
  return {
    description: '',
    priority: '中',
    status: '待处理',
    repoId: 'repo-1',
    branch: 'dev-harvey',
    owner: '飞书同步',
    updatedAt: '2026-10-29',
    createdAt: '2026-10-28',
    ...overrides,
  }
}

const items: WorkItem[] = [
  item({
    id: 'REQ-3419',
    type: 'requirement',
    title: 'Cybrey Cloud支持MSP看板无线负载',
    owner: '王衍龙',
    projectLine: 'MACC,EWEB',
    feishuStatus: '规划中',
  }),
  item({
    id: 'REQ-4000',
    type: 'requirement',
    title: 'CNC DHCP 配置',
    owner: '刘清',
    projectLine: 'MACC,EWEB',
    feishuStatus: '转测试',
  }),
  item({
    id: 'BUG-236',
    type: 'defect',
    title: '配置一键断网后用户仍可上网',
    owner: '谢宏龙',
    projectLine: 'SME云',
    feishuStatus: '新',
  }),
]

test('可同时模糊搜索需求、缺陷、负责人和项目线', () => {
  assert.deepEqual(
    searchWorkItems(items, 'cybrey').items.map((entry) => entry.id),
    ['REQ-3419'],
  )
  assert.deepEqual(
    searchWorkItems(items, '断网 上网').items.map((entry) => entry.id),
    ['BUG-236'],
  )
  assert.deepEqual(
    searchWorkItems(items, '刘清').items.map((entry) => entry.id),
    ['REQ-4000'],
  )
  assert.deepEqual(
    searchWorkItems(items, 'EWEB').items.map((entry) => entry.id),
    ['REQ-3419', 'REQ-4000'],
  )
})

test('编号精确匹配优先，并返回命中总数与显示上限', () => {
  const result = searchWorkItems(items, 'BUG-236')
  assert.equal(result.total, 1)
  assert.equal(result.items[0]?.type, 'defect')

  const limited = searchWorkItems(items, '', 2)
  assert.equal(limited.total, 3)
  assert.deepEqual(limited.items.map((entry) => entry.id), ['REQ-3419', 'REQ-4000'])
})
