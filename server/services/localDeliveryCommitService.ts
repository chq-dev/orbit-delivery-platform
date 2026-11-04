import {
  deliveryCodeFiles,
  deliveryCommitMessage,
  normalizeDeliveryPath,
} from './localDeliveryEvidence.js'
import type { WorkItem } from '../../src/types'

const ENV_FILE_PATTERN = /(^|\/)\.env(?:$|\.)/i
const SECRET_FILE_PATTERN =
  /(^|\/)(?:id_rsa|id_ed25519|id_ecdsa|credentials(?:\.(?:json|ya?ml|toml))?|secrets?\.(?:json|ya?ml|toml))$/i
const SECRET_EXTENSION_PATTERN = /\.(?:pem|key|p12|pfx|keystore|jks)$/i

export interface DeliveryCommitPromptInput {
  checkout: string
  branch: string
  item: Pick<WorkItem, 'id' | 'title' | 'type'>
  commitMessage: string
}

export function isForbiddenDeliveryCommitFile(file: string): boolean {
  const path = normalizeDeliveryPath(file)
  if (!path) return false
  return (
    ENV_FILE_PATTERN.test(path) ||
    SECRET_FILE_PATTERN.test(path) ||
    SECRET_EXTENSION_PATTERN.test(path)
  )
}

export function forbiddenDeliveryCommitFiles(files: readonly string[]): string[] {
  return [...new Set(files.map(normalizeDeliveryPath).filter(isForbiddenDeliveryCommitFile))]
}

export function buildDeliveryCommitPrompt(input: DeliveryCommitPromptInput): string {
  const typeLabel = input.item.type === 'defect' ? '缺陷' : '需求'
  return [
    '## 本地交付提交任务（/aicr-commit）',
    '',
    `工作目录：${input.checkout}`,
    `当前分支：${input.branch}`,
    `平台${typeLabel}：${input.item.id} ${input.item.title}`,
    `必须使用的完整提交标题（单行，不得改写前缀、ID 或描述）：${input.commitMessage}`,
    '',
    '你现在只负责创建本次交付的本地 Git 提交，不要继续修改业务代码。',
    '严格按仓库内的 /aicr-commit 技能执行：',
    '- 读取 `.claude/skills-overlay/aicr-commit/SKILL.md`；',
    '- 读取 `.claude/skills-overlay/aicr-workflow/SKILL.md`；',
    '- 读取 `.claude/skills-overlay/aicr-pr/references/title-rules.md`。',
    '如果上述 overlay 文件不存在，改用 `.claude/skills/` 下的同名技能文件。',
    '',
    '执行要求：',
    '1. 运行 `git status`、`git diff --cached --stat`、`git diff --stat`，确认本次交付的真实源码变更。',
    '2. 只暂存本次交付需要的源码、样式和配置。禁止暂存 `.env`、`.env.*`、密钥、证书、token、`delivery-artifacts/**`、日志、构建产物以及与本工作项无关的文件。',
    '3. 按 aicr-commit 对当前暂存区执行 AICR 审查，并写入 `.git/aicr-ai-review-latest.json`：`scope` 必须为 `staged`，`stagedDiffHash` 必须等于 `git diff --cached --unified=80 | shasum -a 256` 的 hash，审查通过时 `approved` 必须为 `true`。',
    '4. 如果 AICR 审查发现 HIGH 及以上问题或 `approved` 无法为 `true`，不要提交，直接说明阻断原因后退出；不要伪造审查结果。',
    '5. 使用上面的完整提交标题执行一次普通 `git commit`。不要 `--amend`、不要 `--force`、不要创建分支或合并提交。',
    '6. 本次明确「只本地提交，不要 push」。即使 aicr-commit 默认 push，也必须跳过 push。',
    '7. 提交后运行并输出 `git rev-parse HEAD` 与 `git show --stat --oneline HEAD`，确认提交包含本次源码变更且不含敏感文件。',
    '',
    '完成后请在最后一条消息中给出：AICR 审查结论、commit hash、实际提交标题。',
  ].join('\n')
}

export interface DeliveryCommitValidationInput {
  previousHead: string
  head: string
  message: string
  files: readonly string[]
  expectedMessage: string
}

export function validateDeliveryCommit(input: DeliveryCommitValidationInput): void {
  if (!input.head || input.head === input.previousHead) {
    throw new Error('未创建新的提交（AICR 审查未通过或 /aicr-commit 未执行）')
  }
  const subject = input.message.split(/\r?\n/)[0].trim()
  if (subject !== input.expectedMessage) {
    throw new Error(`提交标题不符合 AICR 规范：期望「${input.expectedMessage}」，实际「${subject}」`)
  }
  const forbidden = forbiddenDeliveryCommitFiles(input.files)
  if (forbidden.length > 0) {
    throw new Error(`提交包含禁止提交的敏感文件：${forbidden.slice(0, 8).join(', ')}`)
  }
  if (deliveryCodeFiles(input.files).length === 0) {
    throw new Error('提交没有包含任何非 Markdown 代码文件')
  }
}

export function deliveryCommitMessageFor(item: Pick<WorkItem, 'id' | 'title' | 'type'>): string {
  return deliveryCommitMessage(item.id, item.title, item.type)
}
