import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  mapFeishuSnapshotItems,
  mergeFeishuSnapshot,
  parseFeishuSnapshot,
} from '../../src/feishuSnapshotCore'
import {
  buildFeishuSnapshot,
  writeFeishuSnapshot,
} from '../services/feishuSnapshotService.js'
import type { Repository, WorkItem } from '../../src/types'

const repository: Repository = {
  id: 'repo-1',
  name: 'sme-main',
  url: 'http://cloudgit.rj.link/sme/sme-main.git',
  branch: 'dev-harvey',
  localPath: '/Users/chenhuaqu/sme/sme-main',
  language: 'Vue 3 + Lua',
  accountId: 'acc-1',
  lastSync: '刚刚',
  status: 'healthy',
  latestVersion: 'v1.0.0',
}

test('前端快照按飞书工作项 ID 合并并忽略无效记录', () => {
  const parsed = parseFeishuSnapshot({
    version: 1,
    source: 'feishu',
    projectKey: 'rjcloud',
    syncedAt: '2026-10-29T02:00:00.000Z',
    items: [
      {
        externalId: 'rjcloud:story:6955195522',
        type: 'requirement',
        title: '实时需求',
        description: '来自前端快照的需求',
        priority: '高',
        owner: 'Alice',
        updatedAt: '2026-10-29T01:50:00.000Z',
      },
      {
        externalId: 'rjcloud:issue:7142612744',
        type: 'issue',
        title: '实时缺陷',
        description: '来自前端快照的缺陷',
        priority: '紧急',
        owner: 'Bob',
      },
      { externalId: '', type: 'requirement', title: '无效记录' },
    ],
  })

  assert.equal(parsed.snapshot.items.length, 2)
  assert.equal(parsed.skipped, 1)

  const snapshotItems = mapFeishuSnapshotItems(parsed.snapshot, [repository])
  assert.equal(snapshotItems.length, 2)
  assert.equal(snapshotItems.every((item) => item.frontendOnly === true), true)
  assert.equal(snapshotItems.every((item) => item.repoId === repository.id), true)
  assert.equal(snapshotItems.find((item) => item.type === 'defect')?.id, 'BUG-FS-7142612744')

  const existing: WorkItem = {
    id: 'REQ-1082',
    type: 'requirement',
    title: '旧标题',
    description: '旧描述',
    priority: '中',
    status: '进行中',
    repoId: repository.id,
    branch: repository.branch,
    owner: '旧负责人',
    updatedAt: '3 天前',
    createdAt: '2026-10-28T09:08:00.000Z',
    source: 'feishu',
    externalId: '66e039485659e0b44ce1d589:story:6955195522',
  }

  const merged = mergeFeishuSnapshot([existing], snapshotItems)
  assert.equal(merged.length, 1)
  const requirement = merged.find((item) => item.externalId?.endsWith(':story:6955195522'))
  assert.equal(requirement?.id, 'REQ-1082')
  assert.equal(requirement?.title, '旧标题')
  assert.equal(requirement?.status, '进行中')
  assert.equal(requirement?.frontendOnly, false)
  assert.equal(merged.some((item) => item.id === 'BUG-FS-7142612744'), false)
})

test('后端没有飞书工作项时才使用前端快照补充展示', () => {
  const parsed = parseFeishuSnapshot({
    version: 1,
    source: 'feishu',
    projectKey: 'rjcloud',
    syncedAt: '2026-10-29T02:00:00.000Z',
    items: [
      {
        externalId: 'rjcloud:story:6955195522',
        type: 'requirement',
        title: '快照需求',
        description: '后端尚未同步时用于展示',
        priority: '高',
        owner: 'Alice',
        updatedAt: '2026-10-29T01:50:00.000Z',
      },
    ],
  })
  const snapshotItems = mapFeishuSnapshotItems(parsed.snapshot, [repository])
  const merged = mergeFeishuSnapshot([], snapshotItems)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].frontendOnly, true)
})

test('同步器生成的前端快照可被原子写入并读回', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-feishu-snapshot-'))
  const path = join(directory, 'feishu-work-items.json')
  try {
    const snapshot = buildFeishuSnapshot(
      'rjcloud',
      [
        {
          externalId: 'rjcloud:story:1',
          type: 'requirement',
          title: '较新需求',
          description: '描述',
          priority: '高',
          owner: 'Alice',
          updatedAt: '2026-10-29T02:00:00.000Z',
        },
        {
          externalId: 'rjcloud:issue:2',
          type: 'defect',
          title: '较早缺陷',
          description:
            '参考 https://example.feishu.cn/docx/demo?disposable_login_token=secret-value&next=1',
          priority: '中',
          owner: 'Bob',
          updatedAt: '2026-10-29T01:00:00.000Z',
        },
      ],
      '2026-10-29T03:00:00.000Z',
    )
    writeFeishuSnapshot(path, snapshot)

    const saved = JSON.parse(readFileSync(path, 'utf8')) as ReturnType<
      typeof buildFeishuSnapshot
    >
    assert.equal(saved.version, 1)
    assert.equal(saved.generatedBy, 'meegle-cli')
    assert.equal(saved.items.length, 2)
    assert.equal(saved.items[0].type, 'requirement')
    assert.equal(saved.syncedAt, '2026-10-29T03:00:00.000Z')
    assert.match(saved.items[1].description, /disposable_login_token=\[REDACTED\]/)
    assert.doesNotMatch(saved.items[1].description, /secret-value/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
