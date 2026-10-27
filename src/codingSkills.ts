export const codingSkillsSource = {
  name: 'coding-skills',
  url: 'http://cloudgit.rj.link/agentic-coding/coding-skills.git',
  ref: 'main',
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
