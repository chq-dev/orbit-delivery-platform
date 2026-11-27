import { existsSync, readFileSync } from 'node:fs'
import type { DefectResolution } from '../domain/types.js'
import { defectResolutionIssue } from '../../src/deliveryContext.js'

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
