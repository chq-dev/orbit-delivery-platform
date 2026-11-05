import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
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
const STALE_GIT_INDEX_LOCK_MS = 2 * 60_000
const PROJECT_RESTRICTED_CONFIG = 'web/scripts/git/husky/restricted-files.json'

interface ProjectRestrictedRule {
  pattern: string
  description?: string
  enabled?: boolean
}

interface ProjectRestrictedConfig {
  excludePatterns?: ProjectRestrictedRule[]
  restrictedFiles?: ProjectRestrictedRule[]
  restrictedPatterns?: ProjectRestrictedRule[]
}

export interface ExcludedDeliveryCommitFile {
  path: string
  reason: string
}

export interface DeliveryCommitFilePlan {
  allowedFiles: string[]
  excludedFiles: ExcludedDeliveryCommitFile[]
}

export function clearStaleGitIndexLock(checkout: string, now = Date.now()): boolean {
  const result = spawnSync('git', ['-C', checkout, 'rev-parse', '--git-path', 'index.lock'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `读取 Git 索引锁路径失败：${(result.stderr || result.stdout || '').trim() || `退出码 ${result.status}`}`,
    )
  }
  const reportedPath = (result.stdout ?? '').trim()
  if (!reportedPath) return false
  const lockPath = isAbsolute(reportedPath) ? reportedPath : join(checkout, reportedPath)
  if (!existsSync(lockPath)) return false
  const info = statSync(lockPath)
  if (!info.isFile() || info.size > 0 || now - info.mtimeMs < STALE_GIT_INDEX_LOCK_MS) return false
  const holders = spawnSync('lsof', ['--', lockPath], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  if (holders.status === 0 && holders.stdout.trim()) return false
  unlinkSync(lockPath)
  return true
}

export interface DeliveryCommitPromptInput {
  checkout: string
  branch: string
  item: Pick<WorkItem, 'id' | 'title' | 'type'>
  commitMessage: string
  stagedFiles?: readonly string[]
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

export function parseGitPathList(output: string): string[] {
  return output
    .split('\0')
    .map(normalizeDeliveryPath)
    .filter(Boolean)
}

export function committedDeliveryFiles(checkout: string, revision = 'HEAD'): string[] {
  const result = spawnSync(
    'git',
    ['-C', checkout, 'show', '--name-only', '--format=', '-z', revision],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `读取提交文件失败：${(result.stderr || result.stdout || '').trim() || `退出码 ${result.status}`}`,
    )
  }
  return parseGitPathList(result.stdout)
}

function readProjectRestrictedConfig(checkout: string): ProjectRestrictedConfig {
  try {
    const path = join(checkout, PROJECT_RESTRICTED_CONFIG)
    return existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as ProjectRestrictedConfig)
      : {}
  } catch {
    return {}
  }
}

function matchesProjectPattern(pattern: string, path: string): boolean {
  const webRelative = path.replace(/^web\//, '')
  try {
    const expression = new RegExp(pattern)
    return expression.test(path) || expression.test(webRelative)
  } catch {
    return false
  }
}

function excludedDeliveryFileReason(checkout: string, file: string): string | undefined {
  const path = normalizeDeliveryPath(file)
  if (!path) return '空路径'
  if (path.startsWith('delivery-artifacts/')) return '交付产物目录'
  if (ENV_FILE_PATTERN.test(path)) return '环境变量文件'
  if (SECRET_FILE_PATTERN.test(path) || SECRET_EXTENSION_PATTERN.test(path)) return '密钥或证书文件'
  if (/\.(?:log|tmp|temp)$/i.test(path)) return '日志或临时文件'
  if (/(^|\/)(?:node_modules|dist|dist_base|coverage|build-analysis-reports)\//i.test(path)) {
    return '依赖或构建产物'
  }
  if (/(?:\.min\.|\.bundle\.|\.chunk\.|(^|\/)remoteEntry\.js$)/i.test(path)) return '构建产物'
  if (/(^|\/)(?:\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(path)) return '操作系统文件'
  if (
    /(^|\/)docs\/(?:design|ldd)\/.+\.md$/i.test(path) ||
    /(?:^|[-_ ])L[LD]D\.md$/i.test(path)
  ) {
    return 'LDD/设计文档仅作交付证据，不提交'
  }
  if (
    /(^|\/)i18n\/lang\/(?!zh\.json$)[^/]+\.json$/i.test(path) ||
    /(^|\/)locales\/lang\/json\/(?:menu-modules\/)?(?!zh\.json$)[^/]+\.json$/i.test(path)
  ) {
    return 'i18n 仅允许提交 zh.json'
  }

  const config = readProjectRestrictedConfig(checkout)
  const excluded = (config.excludePatterns ?? []).some(
    (rule) => rule.enabled !== false && matchesProjectPattern(rule.pattern, path),
  )
  if (!excluded) {
    const restricted = [
      ...(config.restrictedFiles ?? []),
      ...(config.restrictedPatterns ?? []),
    ].find((rule) => rule.enabled !== false && matchesProjectPattern(rule.pattern, path))
    if (restricted) return restricted.description || '项目受限文件'
  }
  return undefined
}

export function planDeliveryCommitFiles(
  checkout: string,
  files: readonly string[],
): DeliveryCommitFilePlan {
  const allowedFiles: string[] = []
  const excludedFiles: ExcludedDeliveryCommitFile[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const path = normalizeDeliveryPath(file)
    if (!path || seen.has(path)) continue
    seen.add(path)
    const reason = excludedDeliveryFileReason(checkout, path)
    if (reason) excludedFiles.push({ path, reason })
    else allowedFiles.push(path)
  }
  return {
    allowedFiles: allowedFiles.sort(),
    excludedFiles: excludedFiles.sort((left, right) => left.path.localeCompare(right.path)),
  }
}

export function buildDeliveryCommitPrompt(input: DeliveryCommitPromptInput): string {
  const typeLabel = input.item.type === 'defect' ? '缺陷' : '需求'
  const stagedFiles = (input.stagedFiles ?? []).map(normalizeDeliveryPath).filter(Boolean)
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
    '1. 交付 runner 已按项目规则准备好暂存区，运行 `git status`、`git diff --cached --stat` 确认范围。',
    `2. 当前允许提交的编码文件：${stagedFiles.length > 0 ? stagedFiles.join(', ') : '以当前暂存区为准'}。`,
    '3. 禁止再执行 `git add`、`git reset`、`git restore --staged` 或暂存任何额外文件；不要修改业务代码。若发现缺少必要文件，停止并说明，不要自行补充。',
    '    LDD、设计报告和其他 Markdown 文档只作为交付证据保留在工作区，不得暂存或提交。',
    '4. 按 aicr-commit 对当前暂存区执行 AICR 审查，并写入 `.git/aicr-ai-review-latest.json`：`scope` 必须为 `staged`，`stagedDiffHash` 必须等于 `git diff --cached --unified=80 | shasum -a 256` 的 hash，审查通过时 `approved` 必须为 `true`。',
    '5. 如果 AICR 审查发现 HIGH 及以上问题或 `approved` 无法为 `true`，不要提交，直接说明阻断原因后退出；不要伪造审查结果。',
    '6. 使用上面的完整提交标题执行一次普通 `git commit`。不要 `--amend`、不要 `--force`、不要创建分支或合并提交。',
    '7. 本次明确「只本地提交，不要 push」。即使 aicr-commit 默认 push，也必须跳过 push；推送由交付 runner 在提交校验通过后执行。',
    '8. 提交后运行并输出 `git rev-parse HEAD` 与 `git show --stat --oneline HEAD`，确认提交文件与暂存清单一致且不含敏感文件。',
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
  allowedFiles?: readonly string[]
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
  if (input.allowedFiles) {
    const allowed = new Set(input.allowedFiles.map(normalizeDeliveryPath))
    const unexpected = input.files
      .map(normalizeDeliveryPath)
      .filter((file) => file && !allowed.has(file))
    if (unexpected.length > 0) {
      throw new Error(`提交包含未按项目规则暂存的文件：${unexpected.slice(0, 8).join(', ')}`)
    }
  }
}

export function deliveryCommitMessageFor(item: Pick<WorkItem, 'id' | 'title' | 'type'>): string {
  return deliveryCommitMessage(item.id, item.title, item.type)
}
