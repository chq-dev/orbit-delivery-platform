import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildLocalSkillInstruction } from '../../src/skillInstruction.js'
import type { Repository, WorkItem } from '../../src/types.js'

test('交付提示词包含工作项配置的设计稿或设计说明', () => {
  const item: WorkItem = {
    id: 'REQ-1082',
    type: 'requirement',
    title: '第三方纳管厂商私有监控指标扩展',
    description: '扩展监控指标',
    priority: '中',
    status: '待处理',
    repoId: 'repo-1',
    branch: 'dev-harvey',
    owner: 'chenhuaqu',
    updatedAt: '刚刚',
    createdAt: '2026-10-30',
    designReference: '/Users/chenhuaqu/sme/sme-main/docs/req-1082-design.md',
  }
  const repository: Repository = {
    id: 'repo-1',
    name: 'sme-main',
    url: 'http://cloudgit.rj.link/sme/sme-main.git',
    branch: 'dev-harvey',
    localPath: '/Users/chenhuaqu/sme/sme-main',
    language: 'Vue 3 + Lua',
    accountId: 'account-1',
    lastSync: '刚刚',
    status: 'healthy',
    latestVersion: 'v1.0.0',
  }

  const instruction = buildLocalSkillInstruction(item, repository)

  assert.match(instruction, /Design reference: \/Users\/chenhuaqu\/sme\/sme-main\/docs\/req-1082-design\.md/)
  assert.match(instruction, /read it before writing the design report/)
})

test('交付提示词包含需求拆解与截图附件路径', () => {
  const item: WorkItem = {
    id: 'REQ-1082',
    type: 'requirement',
    title: '第三方纳管厂商私有监控指标扩展',
    description: '扩展监控指标',
    priority: '中',
    status: '待处理',
    repoId: 'repo-1',
    branch: 'dev-harvey',
    owner: 'chenhuaqu',
    updatedAt: '刚刚',
    createdAt: '2026-10-30',
  }
  const instruction = buildLocalSkillInstruction(
    item,
    undefined,
    {
      requirementBreakdown: '目标：新增指标；范围：列表与详情；验收：数据一致。',
      designReference: 'https://ruijie.feishu.cn/wiki/design-1082',
      screenshotPaths: [
        '/Users/chenhuaqu/sme/sme-main/delivery-artifacts/REQ-1082/requirement-assets/design.png',
      ],
    },
  )
  assert.match(instruction, /Requirement breakdown:\n目标：新增指标/)
  assert.match(instruction, /Design reference: https:\/\/ruijie\.feishu\.cn\/wiki\/design-1082/)
  assert.match(instruction, /Design screenshot files:/)
  assert.match(instruction, /The design screenshots are attached to this Codex run/)
})
