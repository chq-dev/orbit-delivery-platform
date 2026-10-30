export const codingSkillsSource = {
  name: 'coding-skills',
  url: 'http://cloudgit.rj.link/agentic-coding/coding-skills.git',
  ref: 'main',
} as const

export const organizationSkillManual = {
  name: '天枢 Forge｜工程 Skill 使用手册',
  project: 'SME',
  url: 'https://ruijie.feishu.cn/wiki/Z6yYwTkJfiteT0k5vKHcbtPFnad',
  baseline: '2026-10-29',
} as const

export interface CodingSkill {
  id: string
  stage: string
}

export const codingSkills: CodingSkill[] = [
  { id: 'sdd', stage: '需求流程编排' },
  { id: 'grill-with-req', stage: '需求澄清' },
  { id: 'spec-design', stage: '方案设计' },
  { id: 'task-breakdown', stage: '任务拆解' },
  { id: 'task-implement', stage: '编码实现' },
  { id: 'verification-evidence', stage: '验证举证' },
  { id: 'code-review', stage: '独立评审' },
  { id: 'design-to-l1', stage: 'L1 架构知识' },
  { id: 'design-to-l2', stage: 'L2 组件架构' },
]

export interface DeliveryStageSkill {
  stage: string
  entry: string
  artifact: string
}

export const smeDeliveryStageChain: DeliveryStageSkill[] = [
  {
    stage: '需求',
    entry: 'clarify-requirements',
    artifact: '已确认需求卡片：目标、规则、边界、异常、验收与待确认项',
  },
  {
    stage: '方案',
    entry: 'tech-design + case-design',
    artifact: '技术方案、任务拆分与可判定用例',
  },
  {
    stage: '开发',
    entry: 'implementation + Web/Lua 专项',
    artifact: '代码变更、自检结果与对应专项验证',
  },
  {
    stage: '集成',
    entry: 'integration-test',
    artifact: '跨模块集成证据：命令、环境、结果与失败归因',
  },
  {
    stage: '验收',
    entry: 'e2e-test',
    artifact: '独立端到端结果，逐目标记录通过/失败/阻塞/跳过',
  },
  {
    stage: '审查与交付',
    entry: 'aicr-workflow → aicr-commit / aicr-pr',
    artifact: '审查报告、规范提交或 MR；发布另走版本/工程流程',
  },
]

export const smeSkillSpecialties = {
  web: [
    'developer',
    'frontend-project-conventions',
    'frontend-component-development',
    'frontend-data-view-development',
    'frontend-api-client',
    'frontend-styling',
    'frontend-assets',
    'module-federation-development',
    'module-federation-integration',
    'echarts',
    'menu-module-registration',
    'platform-ifdef',
    'i18n-usage',
    'theme-management',
    'timezone-format',
  ],
  lua: ['lua-module-dev'],
  local: [
    'i18n-playwright-mcp-screenshot',
    'performance-optimization',
    'rule-management-lua',
    'sensitive-keyword-management',
    'switch-lua-debug-deploy',
  ],
} as const
