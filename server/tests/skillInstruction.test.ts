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
    buildEnabled: true,
    buildAccountId: '',
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
  assert.match(instruction, /天枢 Forge｜工程 Skill 使用手册/)
  assert.match(instruction, /Z6yYwTkJfiteT0k5vKHcbtPFnad/)
  assert.match(instruction, /clarify-requirements/)
  assert.match(instruction, /tech-design \+ case-design/)
  assert.match(instruction, /integration-test/)
  assert.match(instruction, /e2e-test/)
  assert.match(instruction, /aicr-workflow → aicr-commit \/ aicr-pr/)
  assert.match(instruction, /LOCAL_DELIVERY_PHASE:analysis/)
  assert.match(instruction, /business LDD/)
  assert.match(instruction, /Commit-stage skill: \/aicr-commit \(\$aicr-commit/)
  assert.match(instruction, /separate Codex pass that executes the commit skill/)
  assert.match(instruction, /The \/aicr-commit contract requires/)
  assert.match(instruction, /approved: true/)
  assert.match(instruction, /【缺陷修复】\{id\} \{description\}/)
  assert.match(instruction, /\.claude\/skills-overlay\/aicr-commit\/SKILL\.md/)
  assert.match(instruction, /\.claude\/skills\/aicr-pr\/references\/title-rules\.md/)
  assert.match(
    instruction,
    /SME mode-switch LDD design reference: \/Users\/chenhuaqu\/sme\/sme-main\/web\/docs\/ldd\/SME-模式切换-LDD\.md/,
  )
  assert.match(instruction, /web\/components\/views\/modeSwitch/)
  assert.match(instruction, /lua\/luci\/modules\/mode_switch/)
  assert.match(instruction, /never claim the skill ran/)
  assert.match(instruction, /never acceptance evidence/)
  assert.match(instruction, /Feishu MCP server named "feishu"/)
  assert.match(instruction, /Meegle work items remain platform-provided/)
  assert.match(instruction, /Meegle MCP server named "meegle"/)
})

test('缺陷交付提示词包含可选的缺陷说明', () => {
  const item: WorkItem = {
    id: 'BUG-236',
    type: 'defect',
    title: 'AP 漫游后终端无法续租地址',
    description: '漫游后 DHCP 租约未刷新',
    priority: '高',
    status: '待处理',
    repoId: 'repo-1',
    branch: 'dev-harvey',
    owner: 'chenhuaqu',
    updatedAt: '刚刚',
    createdAt: '2026-11-10',
    defectNote: '复现路径：AC 下挂两台 AP，终端从 AP1 漫游到 AP2；期望 20 秒内恢复续租。',
  }

  const instruction = buildLocalSkillInstruction(item, undefined, {
    screenshotPaths: [
      '/Users/chenhuaqu/sme/sme-main/delivery-artifacts/BUG-236/defect-assets/roaming.png',
    ],
  })

  assert.match(instruction, /Defect note \(operator supplied\):/)
  assert.match(instruction, /复现路径：AC 下挂两台 AP/)
  assert.match(instruction, /operator-confirmed delivery scope/)
  assert.match(instruction, /Defect screenshot files:/)
  assert.match(instruction, /use them to reproduce and verify the reported behavior/)
})
