import 'dotenv/config'
import type { DefectResolution } from '../../src/types'
import { defectResolutionIssue } from '../../src/deliveryContext'
import { resolveMeegleDefect } from '../services/meegleResolutionService.js'

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1]?.trim() : undefined
}

function yesNo(value: string | undefined, label: string): boolean {
  if (value === '是' || value?.toLowerCase() === 'yes' || value === 'true') return true
  if (value === '否' || value?.toLowerCase() === 'no' || value === 'false') return false
  throw new Error(`${label}必须是“是/否”或 yes/no`)
}

function usage(): string {
  return [
    '用法：npm run feishu:resolve -- --external-id rjcloud:issue:123456 \\',
    '  --legacy 否 --introduced 否 \\',
    '  --solution "修复内容" --root-cause "根因" --impact "影响面"',
    '',
    '该命令用于已交付的历史缺陷一次性回填，使用本机 Meegle CLI 登录态。',
  ].join('\n')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage())
    return
  }
  const externalId = valueAfter(args, '--external-id')
  if (!externalId) throw new Error(`缺少 --external-id\n\n${usage()}`)
  const resolution: DefectResolution = {
    legacyBug: yesNo(valueAfter(args, '--legacy'), '是否遗留BUG'),
    introduced: yesNo(valueAfter(args, '--introduced'), '是否修订引入'),
    solution: valueAfter(args, '--solution'),
    rootCause: valueAfter(args, '--root-cause'),
    impact: valueAfter(args, '--impact'),
  }
  const issue = defectResolutionIssue(resolution)
  if (issue) throw new Error(issue)
  const result = resolveMeegleDefect(externalId, resolution)
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
