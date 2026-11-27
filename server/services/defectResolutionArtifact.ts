import { existsSync, readFileSync } from 'node:fs'
import type { DefectResolution } from '../domain/types.js'
import { defectResolutionIssue } from '../../src/deliveryContext.js'

export interface DefectResolutionPromptInput {
  checkout: string
  artifactDir: string
  workItem: {
    id: string
    title: string
    description?: string
  }
}

export function buildDefectResolutionPrompt(input: DefectResolutionPromptInput): string {
  const artifactPath = `${input.artifactDir}/feishu-resolution.md`
  return [
    '## 飞书缺陷解决信息生成任务',
    '',
    `工作目录：${input.checkout}`,
    `工作项：${input.workItem.id} ${input.workItem.title}`,
    input.workItem.description ? `缺陷描述：${input.workItem.description}` : '',
    `必须生成或覆盖：${artifactPath}`,
    '',
    '只生成上述一份证据文件，不要修改业务代码、测试文件或其他交付产物；不要执行 git add、git commit 或 git push。',
    '先读取以下真实证据，禁止编造不存在的设备、版本、测试或验证结果：',
    `- ${input.artifactDir}/feishu-context.md`,
    `- ${input.artifactDir}/integration-report.md`,
    `- ${input.artifactDir}/test-report.md（存在时）`,
    `- ${input.artifactDir}/codex-last-message.md（存在时）`,
    '- 当前工作区相对 HEAD 的实际代码差异：git diff HEAD',
    '',
    '使用且只使用以下五个二级标题，顺序不得变化：',
    '## 是否遗留BUG',
    '只写“是”或“否”。',
    '## 是否修订引入',
    '只写“是”或“否”。',
    '## 解决方案',
    '基于真实代码差异说明改了什么、为什么能修复缺陷。',
    '## 根因分析',
    '说明造成缺陷的直接技术原因，必须与解决方案和代码差异一致。',
    '## 影响面分析',
    '说明受影响设备、版本、模块、用户场景和回归范围；无法确认的信息写明依据，不要猜测。',
    '',
    '完成后检查文件包含全部五个章节且内容非空。最后一条消息只给出生成文件和五个章节是否齐全，不要输出代码补丁。',
  ].filter(Boolean).join('\n')
}

function yesNo(value: string | undefined, label: string): boolean {
  const text = (value ?? '')
    .replace(/^[-*]\s*/, '')
    .replace(/[*_`]/g, '')
    .trim()
  if (/^(是|yes|true)$/i.test(text)) return true
  if (/^(否|no|false)$/i.test(text)) return false
  throw new Error(`${label}必须是“是/否”或 yes/no`)
}

function section(content: string, title: string): string | undefined {
  const pattern = new RegExp(
    `^##\\s*${title}\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`,
    'm',
  )
  return pattern.exec(content)?.[1]?.trim()
}

export function parseDefectResolutionArtifact(content: string): DefectResolution {
  const source = content.trim()
  if (!source) throw new Error('飞书缺陷解决报告为空')

  const jsonCandidate = source
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  if (jsonCandidate.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonCandidate)
    } catch {
      throw new Error('飞书缺陷解决报告 JSON 格式不正确')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('飞书缺陷解决报告格式不正确')
    }
    const record = parsed as Record<string, unknown>
    const resolution: DefectResolution = {
      legacyBug: typeof record.legacyBug === 'boolean' ? record.legacyBug : undefined,
      introduced: typeof record.introduced === 'boolean' ? record.introduced : undefined,
      solution: typeof record.solution === 'string' ? record.solution.trim() : undefined,
      rootCause: typeof record.rootCause === 'string' ? record.rootCause.trim() : undefined,
      impact: typeof record.impact === 'string' ? record.impact.trim() : undefined,
    }
    const issue = defectResolutionIssue(resolution)
    if (issue) throw new Error(issue)
    return resolution
  }

  const resolution: DefectResolution = {
    legacyBug: yesNo(section(source, '是否遗留BUG'), '是否遗留BUG'),
    introduced: yesNo(section(source, '是否修订引入'), '是否修订引入'),
    solution: section(source, '解决方案'),
    rootCause: section(source, '根因分析'),
    impact: section(source, '影响面分析'),
  }
  const issue = defectResolutionIssue(resolution)
  if (issue) throw new Error(issue)
  return resolution
}

export function readDefectResolutionArtifact(path: string): DefectResolution | undefined {
  if (!existsSync(path)) return undefined
  return parseDefectResolutionArtifact(readFileSync(path, 'utf8'))
}
