import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { codexBinaryError, resolveCodexBinary } from '../services/codexBinaryService.js'
import {
  buildFeishuMcpCodexArgs,
  feishuMcpRequired,
  resolveFeishuMcpRuntime,
} from '../services/feishuMcpService.js'
import {
  buildMeegleMcpCodexArgs,
  meegleMcpRequired,
  resolveMeegleMcpRuntime,
} from '../services/meegleMcpService.js'
import { buildLocalSkillInstruction } from '../../src/skillInstruction'
import { requirementDeliveryContextIssue } from '../../src/deliveryContext'
import {
  deliveryCodeFiles,
  normalizeDeliveryPath,
} from '../services/localDeliveryEvidence.js'
import { resetDeliveryCodexPhaseMarker } from '../services/localDeliveryPhase.js'
import {
  buildDeliveryCommitPrompt,
  clearStaleGitIndexLock,
  committedDeliveryFiles,
  deliveryCommitMessageFor,
  forbiddenDeliveryCommitFiles,
  planDeliveryCommitFiles,
  validateDeliveryCommit,
} from '../services/localDeliveryCommitService.js'
import { materializeDeliveryScreenshots } from '../services/deliveryContextAssets.js'
import {
  buildCodexExecArgs,
  fetchJsonWithRetry,
  resolveLocalDeliveryBranch,
  supportsLocalDeliveryContract,
} from '../services/localDeliveryAgentService.js'
import type { DeliveryBuildOutcome } from '../services/deliveryBuildService.js'
import type { Repository, WorkItem, WorkItemScreenshot } from '../../src/types'

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const codexTimeoutMs = positiveInteger(
  process.env.LOCAL_DELIVERY_CODEX_TIMEOUT_MS,
  150 * 60_000,
)
const commitTimeoutMs = positiveInteger(
  process.env.LOCAL_DELIVERY_COMMIT_TIMEOUT_MS,
  30 * 60_000,
)

function writeDeliveryLog(
  path: string,
  stdout: string | null | undefined,
  stderr: string | null | undefined,
): void {
  try {
    const content = `[stdout]\n${stdout ?? ''}\n[stderr]\n${stderr ?? ''}\n`
    writeFileSync(path, content.slice(-2_000_000), 'utf8')
  } catch {
    // Logging must not change the delivery outcome.
  }
}

function lastCodexPhase(output: string): 'analysis' | 'ldd' | 'coding' | undefined {
  return Array.from(
    output.matchAll(/LOCAL_DELIVERY_PHASE:(analysis|ldd|coding)/g),
  ).at(-1)?.[1] as 'analysis' | 'ldd' | 'coding' | undefined
}

interface BootstrapData {
  repositories: Repository[]
  workItems: WorkItem[]
}

interface WorkItemDeliveryContextData {
  workItem: WorkItem
  requirementBreakdown?: string
  designReference?: string
  screenshots: WorkItemScreenshot[]
}

interface LocalDeliveryArgs {
  api: string
  workItem: string
  repo?: string
  path?: string
  branch?: string
  run: boolean
  commitOnly: boolean
  push: boolean
  noCommit: boolean
  close: boolean
  yes: boolean
  help: boolean
}

interface GitResult {
  status: number
  stdout: string
  stderr: string
}

interface DeliveryEvidence {
  changedFiles: string[]
  designReport: boolean
  integrationReport: boolean
  testReport: boolean
  buildReport: boolean
  upgradeReport: boolean
}

interface DeliveryStageResult {
  index: number
  status: 'success' | 'pending' | 'failed'
  log: string
}

interface DeliveryReportInput {
  title: string
  summary: string
  content: string
}

interface DeliveryAttemptContext {
  api: string
  args: LocalDeliveryArgs
  item: WorkItem
  repository: Repository
  branch: string
  localPath: string
  autoCommit: boolean
  artifactDir?: string
  evidence?: DeliveryEvidence
  stageResults?: DeliveryStageResult[]
  reports?: ReturnType<typeof deliveryReports>
  commit?: string
  failureRecorded?: boolean
}

function usage(): string {
  return `Orbit client-local delivery

Usage:
  npm run deliver:local -- --work-item REQ-1137 [options]

Options:
  --api <url>          Platform base URL (default: PLATFORM_BASE_URL or https://127.0.0.1:8787)
  --work-item <id>     Work item ID, for example REQ-1137
  --repo <id>          Repository ID (default: work item repo)
  --path <dir>         Client checkout path (default: repository localPath)
  --branch <name>      Platform default branch (local checkout branch wins when different)
  --run                Start Codex in the client checkout after generating the prompt
  --commit-only        Skip coding Codex and resume /aicr-commit on existing changes
  --no-commit          Leave validated changes uncommitted for human review
  --push               Push the resulting commit after Codex succeeds (requires confirmation)
  --close              Mark a local defect closed after delivery is recorded
  --yes                Skip the --push confirmation
  --help               Show this help

The script only reads platform work-item metadata. Code editing and tests run in a
first Codex pass; the runner then starts a second Codex pass that executes the
repository /aicr-commit skill (staged AICR review + local commit). Only --push
writes the resulting commit to origin. Use --commit-only to resume a timed-out
delivery and commit existing verified changes without rerunning coding.`
}

function parseArgs(argv: string[]): LocalDeliveryArgs {
  const args: LocalDeliveryArgs = {
    api: process.env.PLATFORM_BASE_URL?.trim() || 'https://127.0.0.1:8787',
    workItem: '',
    run: false,
    commitOnly: false,
    push: false,
    noCommit: false,
    close: false,
    yes: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (!next || next.startsWith('--')) throw new Error(`${flag} 需要参数值`)
      index += 1
      return next
    }
    if (flag === '--api') args.api = value().replace(/\/api\/?$/, '').replace(/\/$/, '')
    else if (flag === '--work-item') args.workItem = value()
    else if (flag === '--repo') args.repo = value()
    else if (flag === '--path') args.path = value()
    else if (flag === '--branch') args.branch = value()
    else if (flag === '--run') args.run = true
    else if (flag === '--commit-only') {
      args.commitOnly = true
      args.run = true
    }
    else if (flag === '--no-commit') args.noCommit = true
    else if (flag === '--push') args.push = true
    else if (flag === '--close') args.close = true
    else if (flag === '--yes') args.yes = true
    else if (flag === '--help' || flag === '-h') args.help = true
    else throw new Error(`未知参数：${flag}`)
  }
  return args
}

function platformHeaders(): Record<string, string> {
  const token = process.env.PLATFORM_SYNC_TOKEN?.trim()
  return token ? { authorization: `Bearer ${token}` } : {}
}

function deliveryJobId(): string | undefined {
  const value = process.env.ORBIT_DELIVERY_JOB_ID?.trim()
  return value ? value.slice(0, 200) : undefined
}

function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  }
}

function requireGit(cwd: string, args: string[], operation: string): string {
  const result = git(cwd, args)
  if (result.status !== 0) {
    throw new Error(`${operation}失败：${result.stderr || result.stdout || `退出码 ${result.status}`}`)
  }
  return result.stdout
}

function validateCheckout(localPath: string, configuredBranch?: string) {
  if (!isAbsolute(localPath)) throw new Error(`客户端代码路径必须是绝对路径：${localPath}`)
  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
    throw new Error(`客户端代码路径不存在或不是目录：${localPath}`)
  }
  const checkout = realpathSync(localPath)
  const topLevel = realpathSync(requireGit(checkout, ['rev-parse', '--show-toplevel'], '读取 Git 工作区'))
  if (topLevel !== checkout) {
    throw new Error(`客户端代码路径不是 Git 工作区根目录：${localPath}`)
  }
  const currentBranch = requireGit(checkout, ['symbolic-ref', '--short', 'HEAD'], '读取本地分支')
  const resolved = resolveLocalDeliveryBranch(currentBranch, configuredBranch)
  if (resolved.adapted) {
    console.warn(
      `提示：本地仓库当前分支为 ${resolved.branch}，与平台配置分支 ${resolved.configuredBranch} 不一致，已按本机实际分支 ${resolved.branch} 执行`,
    )
  }
  const dirty = Boolean(requireGit(checkout, ['status', '--porcelain'], '检查本地变更'))
  const head = requireGit(checkout, ['rev-parse', 'HEAD'], '读取本地提交')
  const remote = git(checkout, ['remote', 'get-url', 'origin'])
  return {
    checkout,
    branch: resolved.branch,
    configuredBranch: resolved.configuredBranch,
    dirty,
    head,
    remote: remote.stdout,
  }
}

async function fetchBootstrap(api: string): Promise<BootstrapData> {
  const health = await fetchJsonWithRetry<unknown>(`${api}/api/health`, {
    label: '读取平台版本',
    attempts: 3,
    timeoutMs: 12_000,
  })
  if (!supportsLocalDeliveryContract(health)) {
    throw new Error(
      '平台服务端尚未部署真实交付契约，无法保证代码变更、提交和阶段证据；请先升级服务器后重试',
    )
  }
  return fetchJsonWithRetry<BootstrapData>(
    `${api}/api/bootstrap?includeWorkItems=1&includeFeishuInbox=0`,
    {
      label: '读取平台工作项与仓库配置',
      attempts: 2,
      timeoutMs: 30_000,
      init: { headers: platformHeaders() },
    },
  )
}

async function fetchDeliveryContext(
  api: string,
  workItemId: string,
): Promise<WorkItemDeliveryContextData> {
  return fetchJsonWithRetry<WorkItemDeliveryContextData>(
    `${api}/api/work-items/${encodeURIComponent(workItemId)}/delivery-context`,
    {
      label: '读取需求拆解、设计稿与截图',
      attempts: 2,
      timeoutMs: 20_000,
      init: { headers: platformHeaders() },
    },
  )
}

function artifactEvidence(artifactDir: string): DeliveryEvidence {
  const hasContent = (path: string): boolean => {
    try {
      return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0
    } catch {
      return false
    }
  }
  return {
    changedFiles: [],
    designReport: hasContent(join(artifactDir, 'design-report.md')),
    integrationReport: hasContent(join(artifactDir, 'integration-report.md')),
    testReport: hasContent(join(artifactDir, 'test-report.md')),
    buildReport:
      hasContent(join(artifactDir, 'build-report.md')) ||
      hasContent(join(artifactDir, 'build.log')),
    upgradeReport:
      hasContent(join(artifactDir, 'upgrade-report.md')) ||
      hasContent(join(artifactDir, 'upgrade.log')),
  }
}

function workTreeFiles(checkout: string): string[] {
  const tracked = requireGit(
    checkout,
    ['diff', 'HEAD', '--name-only', '-z'],
    '读取工作区变更',
  )
  const untracked = requireGit(
    checkout,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    '读取未跟踪文件',
  )
  return [...new Set(
    `${tracked}\0${untracked}`
      .split('\0')
      .map(normalizeDeliveryPath)
      .filter(Boolean),
  )]
}

function assertCleanDeliveryWorktree(checkout: string): void {
  const pending = workTreeFiles(checkout).filter(
    (file) => !file.startsWith('delivery-artifacts/'),
  )
  if (pending.length === 0) return
  throw new Error(
    `客户端工作区存在未提交变更，请先提交或清理后再执行交付：${pending.slice(0, 8).join(', ')}`,
  )
}

function stageDeliveryCommitFiles(checkout: string, artifactDir: string): string[] {
  const plan = planDeliveryCommitFiles(checkout, workTreeFiles(checkout))
  if (plan.allowedFiles.length === 0) {
    throw new Error(
      '没有符合项目提交规则的编码文件；LDD/设计文档仅作交付证据，不参与提交',
    )
  }
  if (deliveryCodeFiles(plan.allowedFiles).length === 0) {
    throw new Error('允许提交的文件中没有非 Markdown 代码文件')
  }

  const reset = git(checkout, ['reset', '--mixed', 'HEAD'])
  if (reset.status !== 0) {
    throw new Error(`重置暂存区失败：${reset.stderr || reset.stdout || `退出码 ${reset.status}`}`)
  }
  for (let index = 0; index < plan.allowedFiles.length; index += 60) {
    const batch = plan.allowedFiles.slice(index, index + 60)
    const added = git(checkout, ['add', '--', ...batch])
    if (added.status !== 0) {
      throw new Error(`按项目规则暂存文件失败：${added.stderr || added.stdout || `退出码 ${added.status}`}`)
    }
  }

  const stagedFiles = requireGit(
    checkout,
    ['diff', '--cached', '--name-only', '-z'],
    '读取已暂存文件',
  )
    .split('\0')
    .map(normalizeDeliveryPath)
    .filter(Boolean)
  const allowed = new Set(plan.allowedFiles)
  const unexpected = stagedFiles.filter((file) => !allowed.has(file))
  const missing = plan.allowedFiles.filter((file) => !stagedFiles.includes(file))
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `暂存结果与项目允许清单不一致：${
        unexpected.length > 0 ? `多余 ${unexpected.slice(0, 8).join(', ')}` : ''
      }${unexpected.length > 0 && missing.length > 0 ? '；' : ''}${
        missing.length > 0 ? `缺少 ${missing.slice(0, 8).join(', ')}` : ''
      }`,
    )
  }
  const forbidden = forbiddenDeliveryCommitFiles(stagedFiles)
  if (forbidden.length > 0) {
    throw new Error(`暂存区包含禁止提交的敏感文件：${forbidden.slice(0, 8).join(', ')}`)
  }

  const report = [
    '# 交付提交暂存报告',
    '',
    `允许并已暂存 ${stagedFiles.length} 个文件：`,
    ...stagedFiles.map((file) => `- ${file}`),
    '',
    `按项目规则排除 ${plan.excludedFiles.length} 个文件：`,
    ...plan.excludedFiles.map((file) => `- ${file.path}（${file.reason}）`),
    '',
  ].join('\n')
  writeFileSync(join(artifactDir, 'commit-staging-report.md'), report, 'utf8')
  console.log(
    `已按项目规则暂存 ${stagedFiles.length} 个文件${
      plan.excludedFiles.length > 0 ? `，排除 ${plan.excludedFiles.length} 个受限文件` : ''
    }`,
  )
  return stagedFiles
}

function commitDeliveredChanges(input: {
  checkout: string
  branch: string
  item: WorkItem
  codexCommand: string
  mcpArgs: string[]
  artifactDir: string
}): string {
  const expectedMessage = deliveryCommitMessageFor(input.item)
  const previousHead = requireGit(input.checkout, ['rev-parse', 'HEAD'], '读取提交前 HEAD')
  const lastMessagePath = join(input.artifactDir, 'codex-commit-last-message.md')
  console.log('LOCAL_DELIVERY_STAGE:commit')
  if (clearStaleGitIndexLock(input.checkout)) {
    console.log('已清理陈旧的 Git 索引锁')
  }
  const stagedFiles = stageDeliveryCommitFiles(input.checkout, input.artifactDir)
  const prompt = buildDeliveryCommitPrompt({
    checkout: input.checkout,
    branch: input.branch,
    item: input.item,
    commitMessage: expectedMessage,
    stagedFiles,
  })
  const result = spawnSync(
    input.codexCommand,
    buildCodexExecArgs({
      checkout: input.checkout,
      prompt,
      lastMessagePath,
      imagePaths: [],
      mcpArgs: input.mcpArgs,
      sandbox: 'danger-full-access',
    }),
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: commitTimeoutMs,
      killSignal: 'SIGKILL',
    },
  )
  writeDeliveryLog(join(input.artifactDir, 'codex-commit.log'), result.stdout, result.stderr)
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(
        `创建本地交付提交失败：/aicr-commit 超过 ${Math.round(commitTimeoutMs / 60_000)} 分钟未完成`,
      )
    }
    throw result.error
  }
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().slice(-4_000)
    throw new Error(
      `创建本地交付提交失败：/aicr-commit 执行失败，退出码 ${result.status ?? 1}${
        detail ? `：${detail}` : ''
      }`,
    )
  }
  const head = requireGit(input.checkout, ['rev-parse', 'HEAD'], '读取交付提交')
  const files = committedDeliveryFiles(input.checkout)
  const message = requireGit(input.checkout, ['log', '-1', '--format=%B'], '读取交付提交信息')
  try {
    validateDeliveryCommit({
      previousHead,
      head,
      message,
      files,
      expectedMessage,
      allowedFiles: stagedFiles,
    })
  } catch (error) {
    throw new Error(
      `创建本地交付提交失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return head
}

function readReportFile(path: string, title: string): DeliveryReportInput | undefined {
  if (!existsSync(path)) return undefined
  const content = readFileSync(path, 'utf8').trim()
  if (!content) return undefined
  const summaryLine = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line && !line.startsWith('```'))
  return {
    title,
    summary: (summaryLine || `${title}已由 Codex 实际生成`).slice(0, 500),
    content,
  }
}

function deliveryReports(artifactDir: string): {
  design?: DeliveryReportInput
  integration?: DeliveryReportInput
} {
  return {
    design: readReportFile(join(artifactDir, 'design-report.md'), '开发设计报告'),
    integration: readReportFile(join(artifactDir, 'integration-report.md'), '集成报告'),
  }
}

function deliveryStageResults(
  evidence: DeliveryEvidence,
  autoCommit: boolean,
): DeliveryStageResult[] {
  const changed = evidence.changedFiles.length
  return [
    { index: 0, status: 'success', log: 'Codex 已实际读取需求、检查代码并完成需求分析' },
    {
      index: 1,
      status: evidence.designReport ? 'success' : 'pending',
      log: evidence.designReport
        ? '已生成 delivery-artifacts/<work-item>/design-report.md（含业务 LDD 路径与设计决策）'
        : '未检测到 design-report.md，不能标记设计报告与业务 LDD 完成',
    },
    {
      index: 2,
      status: changed > 0 ? 'success' : 'failed',
      log: `Codex 实际完成业务编码，修改代码文件 ${changed} 个：${evidence.changedFiles.slice(0, 8).join(', ') || '无'}`,
    },
    {
      index: 3,
      status: evidence.integrationReport ? 'success' : 'pending',
      log: evidence.integrationReport
        ? '已生成 delivery-artifacts/<work-item>/integration-report.md'
        : '未检测到 integration-report.md，不能标记集成验证完成',
    },
    {
      index: 4,
      status: autoCommit ? 'success' : 'pending',
      log: autoCommit
        ? '已按 /aicr-commit 完成暂存区 AICR 审查并创建本地提交'
        : '未启用自动提交，代码保留在工作区',
    },
    {
      index: 5,
      status: evidence.buildReport ? 'success' : 'pending',
      log: evidence.buildReport
        ? '检测到真实构建证据文件'
        : '未检测到 build-report.md 或 build.log，本阶段未执行',
    },
    {
      index: 6,
      status: evidence.upgradeReport ? 'success' : 'pending',
      log: evidence.upgradeReport
        ? '检测到真实设备升级证据文件'
        : '未检测到 upgrade-report.md 或 upgrade.log，本阶段未执行',
    },
    {
      index: 7,
      status: evidence.testReport ? 'success' : 'pending',
      log: evidence.testReport
        ? '检测到 test-report.md，自动化测试有实际证据'
        : '未检测到 test-report.md，本阶段未执行',
    },
    {
      index: 8,
      status: evidence.testReport ? 'success' : 'pending',
      log: evidence.testReport
        ? '测试报告已归档'
        : '没有真实测试报告，未生成测试归档',
    },
  ]
}

async function recordPlatformDelivery(
  api: string,
  args: LocalDeliveryArgs,
  item: WorkItem,
  repository: Repository,
  checkout: string,
  commit: string,
  branch: string,
  evidence: DeliveryEvidence,
  stageResults: DeliveryStageResult[],
  reports: ReturnType<typeof deliveryReports>,
): Promise<unknown> {
  const response = await fetch(`${api}/api/pipelines/local`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...platformHeaders(),
    },
    body: JSON.stringify({
      ...(deliveryJobId() ? { deliveryJobId: deliveryJobId() } : {}),
      outcome: 'success',
      workItemId: item.id,
      repoId: repository.id,
      branch,
      localPath: checkout,
      commit,
      autoClose: args.close && item.type === 'defect' && evidence.testReport,
      pushed: args.push,
      summary: args.push
        ? `客户端本地交付完成，提交已推送至 origin/${branch}`
        : '客户端本地交付完成，提交保留在本地',
      stageResults,
      reports,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    const payload = await response.text().catch(() => '')
    throw new Error(`回写平台失败（HTTP ${response.status}）：${payload}`)
  }
  const payload = (await response.json().catch(() => null)) as {
    id?: unknown
    clientExecuted?: unknown
    stages?: unknown
  } | null
  if (!payload || typeof payload.id !== 'string' || !payload.id) {
    throw new Error('平台未返回真实流水线记录，不能把本次交付标记为完成')
  }
  if (payload.clientExecuted !== true) {
    throw new Error('平台未确认本次交付由客户端执行，不能把结果标记为完成')
  }
  if (Array.isArray(payload.stages)) {
    const stages = payload.stages.filter(
      (stage): stage is { key?: unknown; status?: unknown } =>
        typeof stage === 'object' && stage !== null && !Array.isArray(stage),
    )
    const buildClaimed = stages.some(
      (stage) => stage.key === 'build' && stage.status === 'success',
    )
    const upgradeClaimed = stages.some(
      (stage) => stage.key === 'upgrade' && stage.status === 'success',
    )
    if ((buildClaimed && !evidence.buildReport) || (upgradeClaimed && !evidence.upgradeReport)) {
      throw new Error('平台阶段状态与客户端证据不一致，已停止把本次交付标记为完成')
    }
  }
  return payload
}

async function requestDeliveryBuild(
  api: string,
  workItemId: string,
  repoId: string,
  clientId?: string,
): Promise<DeliveryBuildOutcome> {
  const response = await fetch(`${api}/api/pipelines/local/build`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...platformHeaders(),
    },
    body: JSON.stringify({
      workItemId,
      repoId,
      ...(clientId ? { clientId } : {}),
    }),
    signal: AbortSignal.timeout(45_000),
  })
  const payload = (await response.json().catch(() => null)) as
    | (Partial<DeliveryBuildOutcome> & { error?: { message?: string } })
    | null
  if (!response.ok) {
    const message =
      payload && typeof payload.message === 'string'
        ? payload.message
        : payload?.error?.message
          ? payload.error.message
        : `HTTP ${response.status}`
    throw new Error(`触发内部编译失败：${message}`)
  }
  if (
    !payload ||
    typeof payload.configured !== 'boolean' ||
    typeof payload.triggered !== 'boolean' ||
    typeof payload.message !== 'string'
  ) {
    throw new Error('平台返回的内部编译结果格式不正确')
  }
  return payload as DeliveryBuildOutcome
}

function failureStageIndex(
  message: string,
  stageResults?: DeliveryStageResult[],
): number {
  if (/LOCAL_DELIVERY_PHASE:analysis/.test(message)) return 0
  if (/LOCAL_DELIVERY_PHASE:ldd/.test(message)) return 1
  if (/LOCAL_DELIVERY_PHASE:coding/.test(message)) return 2
  if (/design-report|缺少 delivery-artifacts 中的设计报告/.test(message)) return 1
  if (/integration-report|缺少 delivery-artifacts 中的集成报告/.test(message)) return 3
  if (/推送失败|已取消推送|没有 origin 远端/.test(message)) return 4
  if (
    /创建本地交付提交失败|暂存交付变更|没有可提交的交付变更|HEAD 没有变化|AICR.*审查|aicr-commit|未创建新的提交/.test(
      message,
    )
  ) {
    return 4
  }
  if (/未启用自动提交/.test(message)) return 4
  if (/内部编译|编译系统|Jenkins|编译任务|触发编译/.test(message)) return 5
  if (/Codex 执行失败/.test(message)) return 2
  if (/没有检测到.*代码文件变更|仅生成说明或报告/.test(message)) return 2
  if (/回写平台|平台未返回|流水线记录/.test(message)) return 8
  if (
    /读取平台|平台服务端|fetch failed|HTTP|超时|timeout|ECONN|ENOTFOUND|EAI_AGAIN/i.test(
      message,
    )
  ) {
    return 0
  }
  if (/路径|分支|Git 工作区|工作区根目录|未提交变更/.test(message)) return 0
  return stageResults?.find((result) => result.status === 'failed')?.index ?? 0
}

async function recordPlatformFailure(
  context: DeliveryAttemptContext,
  message: string,
  failedIndex: number,
): Promise<{ id: string; status?: string }> {
  let reports = context.reports
  if (!reports && context.artifactDir) {
    try {
      reports = deliveryReports(context.artifactDir)
    } catch (error) {
      console.warn(
        `提示：读取交付报告失败，失败流水线将不附带报告：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const body = JSON.stringify({
    ...(deliveryJobId() ? { deliveryJobId: deliveryJobId() } : {}),
    outcome: 'failed',
    workItemId: context.item.id,
    repoId: context.repository.id,
    branch: context.branch,
    localPath: context.localPath,
    ...(context.commit ? { commit: context.commit } : {}),
    error: message.slice(0, 4_000),
    failedStageIndex: failedIndex,
    autoCommit: context.autoCommit,
    stageResults: context.stageResults,
    reports,
  })
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await postFailureRecord(context.api, body)
    } catch (error) {
      lastError = error
      const text = error instanceof Error ? error.message : String(error)
      const status = Number(text.match(/HTTP (\d{3})/)?.[1] ?? 0)
      if ((status && status < 500 && status !== 408 && status !== 429) || attempt === 3) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 700))
    }
  }
  throw lastError ?? new Error('回写失败流水线失败')
}

async function postFailureRecord(
  api: string,
  body: string,
): Promise<{ id: string; status?: string }> {
  const response = await fetch(`${api}/api/pipelines/local`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...platformHeaders(),
    },
    body,
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    const payload = await response.text().catch(() => '')
    throw new Error(`回写失败流水线失败（HTTP ${response.status}）：${payload}`)
  }
  const payload = (await response.json().catch(() => null)) as {
    id?: unknown
    status?: unknown
  } | null
  if (!payload || typeof payload.id !== 'string' || !payload.id) {
    throw new Error('平台未返回失败流水线记录')
  }
  if (payload.status !== 'failed') {
    throw new Error(`平台返回的失败流水线状态异常：${String(payload.status)}`)
  }
  return { id: payload.id, status: payload.status }
}

function buildPrompt(
  item: WorkItem,
  repository: Repository,
  localPath: string,
  branch: string,
  runDescription: string,
  screenshotPaths: string[],
): string {
  const phaseMarkerPath = join(localPath, 'delivery-artifacts', item.id, '.phase-current')
  return [
    buildLocalSkillInstruction(
      item,
      { ...repository, localPath },
      {
        requirementBreakdown: item.requirementBreakdown,
        designReference: item.designReference,
        screenshotPaths,
      },
    ),
    '',
    '## Client execution contract',
    `Execute only in this client checkout: ${localPath}`,
    `Expected branch: ${branch}`,
    `Platform work item: ${item.id}`,
    runDescription,
    `Work in three explicit phases: requirement analysis, business LDD, then business coding. At the start of each phase persist the phase name to ${phaseMarkerPath}: write \`analysis\`, then \`ldd\`, then \`coding\`. Also print \`LOCAL_DELIVERY_PHASE:analysis\`, \`LOCAL_DELIVERY_PHASE:ldd\`, and \`LOCAL_DELIVERY_PHASE:coding\` when each phase starts. This file is progress telemetry only; never treat it as design or test evidence.`,
    'Phase 2 must generate or update the business LDD affected by this work item under the project LDD convention (for mode-switch work use web/docs/ldd/SME-模式切换-LDD.md). Record the LDD path and key decisions in design-report.md; do not invent an LDD that the code does not follow.',
    `Create these evidence files under ${join(localPath, 'delivery-artifacts', item.id)}: design-report.md, integration-report.md, and test-report.md when the corresponding work actually ran.`,
    'Write build-report.md or build.log only for a real build, and upgrade-report.md or upgrade.log only for a real authorized device upgrade. Do not create placeholder evidence.',
    'Do not create, amend, stage, or push any Git commit. After this coding run, a separate Codex invocation executes the repository /aicr-commit skill to review the staged diff, write the AICR gate report, and create the local commit. Leave the code changes in the working tree; do not run git add.',
    `At least one non-Markdown source file must change under ${localPath}. Reports and delivery-artifacts alone are not a code delivery.`,
    'The platform marks build, upgrade, and test as unexecuted unless the matching evidence file exists. Never invent build, device, test, or report results.',
    'If the Codex session exposes a Feishu MCP server named "feishu", use it to read linked Feishu documents, Wiki pages, screenshots or messages when the task needs them.',
    'If the Codex session exposes a Meegle MCP server named "meegle", use it to query live requirement or defect details. The platform-provided work item remains authoritative for scope. MCP output is supporting input, not acceptance evidence; run the required checks before claiming success.',
  ].join('\n')
}

async function confirmPush(branch: string, yes: boolean): Promise<void> {
  if (yes) return
  if (!input.isTTY) {
    throw new Error('非交互式终端执行 push 时必须显式传入 --yes')
  }
  const prompt = createInterface({ input, output })
  try {
    const answer = await prompt.question(`确认将当前提交推送到 origin/${branch}？输入 yes 继续：`)
    if (answer.trim().toLowerCase() !== 'yes') throw new Error('已取消推送')
  } finally {
    prompt.close()
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  if (!args.workItem) throw new Error(`缺少 --work-item\n\n${usage()}`)
  if (args.push && !args.run) throw new Error('--push 必须与 --run 一起使用')
  if (args.push && args.noCommit) throw new Error('--push 不能与 --no-commit 同时使用')
  if (args.commitOnly && args.noCommit) throw new Error('--commit-only 不能与 --no-commit 同时使用')
  console.log('LOCAL_DELIVERY_STAGE:connectivity')

  const bootstrap = await fetchBootstrap(args.api)
  const context = await fetchDeliveryContext(args.api, args.workItem)
  const item = context.workItem
  if (!item || item.id !== args.workItem) throw new Error(`平台中不存在工作项 ${args.workItem}`)
  const contextIssue =
    item.type === 'requirement'
      ? requirementDeliveryContextIssue({
      requirementBreakdown: context.requirementBreakdown,
      designReference: context.designReference,
      screenshotCount: context.screenshots.length,
    })
      : undefined
  const repositoryId = args.repo || item.repoId
  const repository = bootstrap.repositories.find((entry) => entry.id === repositoryId)
  if (!repository) throw new Error(`平台中不存在仓库 ${repositoryId}`)

  const localPath = args.path || repository.localPath || ''
  const configuredBranch = args.branch || repository.branch || item.branch
  const deliveryItem: WorkItem = {
    ...item,
    requirementBreakdown: context.requirementBreakdown ?? item.requirementBreakdown,
    designReference: context.designReference ?? item.designReference,
  }
  const attempt: DeliveryAttemptContext = {
    api: args.api,
    args,
    item: deliveryItem,
    repository,
    branch: configuredBranch || 'unknown',
    localPath,
    autoCommit: !args.noCommit,
  }

  try {
    if (contextIssue) throw new Error(contextIssue)
    if (!localPath) {
      throw new Error('未配置客户端代码路径，请先在仓库配置中填写本地绝对路径')
    }
    const checkout = validateCheckout(localPath, configuredBranch)
    const branch = checkout.branch
    attempt.branch = branch
    attempt.localPath = checkout.checkout
    if (!checkout.remote) console.warn('提示：本地仓库没有 origin 远端，--push 将无法执行')

    const artifactDir = join(checkout.checkout, 'delivery-artifacts', item.id)
    attempt.artifactDir = artifactDir
    mkdirSync(artifactDir, { recursive: true })
    const screenshotPaths = materializeDeliveryScreenshots(artifactDir, context.screenshots)
    const promptPath = join(artifactDir, 'codex-prompt.md')
    const runDescription = args.run
      ? 'Run the required code changes now; the launcher will not ask for the prompt again.'
      : 'This is a prepared prompt. Do not edit code until a runner starts Codex with this prompt.'
    const prompt = buildPrompt(
      deliveryItem,
      repository,
      checkout.checkout,
      branch,
      runDescription,
      screenshotPaths,
    )
    writeFileSync(promptPath, `${prompt}\n`, 'utf8')
    const feishuMcp = resolveFeishuMcpRuntime()
    const meegleMcp = resolveMeegleMcpRuntime()

    console.log(JSON.stringify({
      workItem: item.id,
      title: item.title,
      repository: repository.name,
      branch,
      configuredBranch: checkout.configuredBranch ?? null,
      checkout: checkout.checkout,
      head: checkout.head,
      dirty: checkout.dirty,
      remote: checkout.remote || null,
      promptFile: promptPath,
      screenshotFiles: screenshotPaths,
      run: args.run,
      commitOnly: args.commitOnly,
      push: args.push,
      autoCommit: !args.noCommit,
      close: args.close,
      codexTimeoutMs,
      commitTimeoutMs,
      feishuMcp: feishuMcp.status,
      meegleMcp: meegleMcp.status,
    }, null, 2))

    if (!args.run) {
      console.log(`\nPrompt 已生成：${promptPath}`)
      console.log('需要立即执行时，在命令末尾增加 --run。')
      return
    }

    if (!args.commitOnly) assertCleanDeliveryWorktree(checkout.checkout)

    const codexCommand = resolveCodexBinary()
    if (!codexCommand) throw new Error(codexBinaryError())
    let mcpArgs: string[] = []
    const lastMessagePath = join(artifactDir, 'codex-last-message.md')
    if (!args.commitOnly) {
      if (feishuMcpRequired() && !feishuMcp.status.available) {
        throw new Error(`FEISHU_MCP_REQUIRED=true，但飞书 MCP 不可用：${feishuMcp.status.reason ?? '未知原因'}`)
      }
      if (feishuMcp.status.configured && !feishuMcp.status.available) {
        console.warn(`提示：飞书 MCP 已配置但不可用：${feishuMcp.status.reason ?? '未知原因'}`)
      }
      if (meegleMcpRequired() && !meegleMcp.status.available) {
        throw new Error(`MEEGLE_MCP_REQUIRED=true，但 Meegle MCP 不可用：${meegleMcp.status.reason ?? '未知原因'}`)
      }
      if (meegleMcp.status.configured && !meegleMcp.status.available) {
        console.warn(`提示：Meegle MCP 已配置但不可用：${meegleMcp.status.reason ?? '未知原因'}`)
      }
      mcpArgs = [
        ...buildFeishuMcpCodexArgs(feishuMcp),
        ...buildMeegleMcpCodexArgs(meegleMcp),
      ]
      resetDeliveryCodexPhaseMarker(checkout.checkout, item.id)
      console.log('LOCAL_DELIVERY_STAGE:codex')
      const result = spawnSync(
        codexCommand,
        buildCodexExecArgs({
          checkout: checkout.checkout,
          prompt,
          lastMessagePath,
          imagePaths: screenshotPaths,
          mcpArgs,
        }),
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
          timeout: codexTimeoutMs,
          killSignal: 'SIGKILL',
        },
      )
      writeDeliveryLog(join(artifactDir, 'codex.log'), result.stdout, result.stderr)
    const codexPhase = lastCodexPhase(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    const phaseSuffix = codexPhase ? `（LOCAL_DELIVERY_PHASE:${codexPhase}）` : ''
      if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
          throw new Error(
          `Codex 执行失败：Codex 阶段超过 ${Math.round(codexTimeoutMs / 60_000)} 分钟未完成${phaseSuffix}`,
          )
        }
        throw result.error
      }
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
      if (result.status !== 0) {
        const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
          .trim()
          .slice(-4_000)
        throw new Error(
          `Codex 执行失败，退出码 ${result.status ?? 1}${phaseSuffix}${detail ? `：${detail}` : ''}`,
        )
      }
      const headAfterCoding = requireGit(checkout.checkout, ['rev-parse', 'HEAD'], '读取编码后 HEAD')
      if (headAfterCoding !== checkout.head) {
        throw new Error(
          'Codex 执行失败：编码阶段创建了 Git 提交，违反客户端执行契约；提交只能由 /aicr-commit 阶段完成',
        )
      }
    }

    console.log('LOCAL_DELIVERY_STAGE:evidence')
    const evidence = artifactEvidence(artifactDir)
    try {
      evidence.changedFiles = deliveryCodeFiles(workTreeFiles(checkout.checkout))
    } catch (error) {
      console.warn(`提示：读取 Codex 代码变更失败：${error instanceof Error ? error.message : String(error)}`)
    }
    attempt.evidence = evidence

    if (args.commitOnly) {
      const forbidden = forbiddenDeliveryCommitFiles(workTreeFiles(checkout.checkout))
      if (forbidden.length > 0) {
        throw new Error(`工作区包含禁止提交的敏感文件，请先处理：${forbidden.slice(0, 8).join(', ')}`)
      }
    }
    if (evidence.changedFiles.length === 0) {
      throw new Error(
        args.commitOnly
          ? '没有检测到可提交的非 Markdown 代码文件变更；--commit-only 需要已有代码改动'
          : 'Codex 已结束，但没有检测到非 Markdown 代码文件变更；仅生成说明或报告不算完成编码',
      )
    }
    if (!args.noCommit && (!evidence.designReport || !evidence.integrationReport)) {
      throw new Error('缺少 delivery-artifacts 中的设计报告或集成报告，已停止创建交付提交')
    }

    if (args.noCommit) {
      const message = '未启用自动提交代码；代码变更已保留在客户端工作区，本次交付未创建提交'
      attempt.stageResults = deliveryStageResults(evidence, false)
      const failure = await recordPlatformFailure(
        attempt,
        message,
        4,
      )
      attempt.failureRecorded = true
      throw new Error(`${message}。平台已记录失败流水线 ${failure.id}`)
    }

    const finalHead = commitDeliveredChanges({
      checkout: checkout.checkout,
      branch,
      item: deliveryItem,
      codexCommand,
      mcpArgs: [],
      artifactDir,
    })
    attempt.commit = finalHead
    const stageResults = deliveryStageResults(evidence, true)
    attempt.stageResults = stageResults
    const reports = deliveryReports(artifactDir)
    attempt.reports = reports

    let internalBuild: DeliveryBuildOutcome | undefined
    if (args.push) {
      console.log('LOCAL_DELIVERY_STAGE:push')
      const actualBranch = requireGit(
        checkout.checkout,
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        '读取提交后分支',
      )
      if (actualBranch !== branch) {
        throw new Error(`推送失败：提交后分支已从 ${branch} 变为 ${actualBranch}，已停止推送`)
      }
      await confirmPush(actualBranch, args.yes)
      if (!checkout.remote) throw new Error('本地仓库没有 origin 远端，无法推送')
      const push = git(checkout.checkout, ['push', 'origin', `HEAD:refs/heads/${actualBranch}`])
      if (push.status !== 0) {
        throw new Error(`推送失败：${push.stderr || push.stdout || `退出码 ${push.status}`}`)
      }
      internalBuild = await requestDeliveryBuild(
        args.api,
        item.id,
        repository.id,
        process.env.ORBIT_AGENT_CLIENT_ID?.trim() || undefined,
      )
      const buildStage = stageResults.find((result) => result.index === 5)
      if (internalBuild.triggered && internalBuild.build) {
        evidence.buildReport = true
        if (buildStage) {
          buildStage.status = 'success'
          buildStage.log = `${internalBuild.message}${
            internalBuild.build.queueUrl ? `；队列 ${internalBuild.build.queueUrl}` : ''
          }`
        }
      } else if (buildStage && !evidence.buildReport) {
        buildStage.log = internalBuild.message
      }
    } else {
      const buildStage = stageResults.find((result) => result.index === 5)
      if (buildStage && !evidence.buildReport) {
        buildStage.log = '代码未推送到远端，未触发 Jenkins 内部编译'
      }
    }

    let platformPipeline: unknown = null
    try {
      console.log('LOCAL_DELIVERY_STAGE:writeback')
      platformPipeline = await recordPlatformDelivery(
        args.api,
        args,
        deliveryItem,
        repository,
        checkout.checkout,
        finalHead,
        branch,
        evidence,
        stageResults,
        reports,
      )
    } catch (error) {
      throw new Error(
        `本地代码已提交 ${finalHead}${args.push ? `并推送到 origin/${branch}` : '，尚未推送'}，但${error instanceof Error ? error.message : String(error)}`,
      )
    }

    console.log(JSON.stringify({
      status: 'success',
      workItem: item.id,
      checkout: checkout.checkout,
      branch,
      configuredBranch: checkout.configuredBranch ?? null,
      previousHead: checkout.head,
      commit: finalHead,
      pushed: args.push,
      changedFiles: evidence.changedFiles,
      evidence: {
        designReport: evidence.designReport,
        integrationReport: evidence.integrationReport,
        testReport: evidence.testReport,
        buildReport: evidence.buildReport,
        upgradeReport: evidence.upgradeReport,
      },
      internalBuild,
      stageResults,
      platformPipeline,
      promptFile: promptPath,
      screenshotFiles: screenshotPaths,
      lastMessageFile: lastMessagePath,
    }, null, 2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    let recordedPipelineId: string | undefined
    let recordErrorMessage: string | undefined
    if (!attempt.failureRecorded) {
      if (!attempt.stageResults && attempt.evidence) {
        attempt.stageResults = deliveryStageResults(attempt.evidence, Boolean(attempt.commit))
      }
      try {
        const failure = await recordPlatformFailure(
          attempt,
          message,
          failureStageIndex(message, attempt.stageResults),
        )
        attempt.failureRecorded = true
        recordedPipelineId = failure.id
        console.error(`平台已记录失败流水线 ${failure.id}`)
      } catch (recordError) {
        recordErrorMessage =
          recordError instanceof Error ? recordError.message : String(recordError)
        console.error(`LOCAL_DELIVERY_RECORD_ERROR: ${recordErrorMessage}`)
      }
    }
    if (recordedPipelineId) {
      throw new Error(`${message}（平台已记录失败流水线 ${recordedPipelineId}）`)
    }
    if (recordErrorMessage) {
      throw new Error(`${message}（失败记录回写平台失败：${recordErrorMessage}）`)
    }
    throw error
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`LOCAL_DELIVERY_ERROR: ${message}`)
  process.exitCode = 1
})
