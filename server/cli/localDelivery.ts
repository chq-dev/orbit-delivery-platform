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
  deliveryCommitMessage,
  normalizeDeliveryPath,
} from '../services/localDeliveryEvidence.js'
import { materializeDeliveryScreenshots } from '../services/deliveryContextAssets.js'
import {
  fetchJsonWithRetry,
  supportsLocalDeliveryContract,
} from '../services/localDeliveryAgentService.js'
import type { Repository, WorkItem, WorkItemScreenshot } from '../../src/types'

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

function usage(): string {
  return `Orbit client-local delivery

Usage:
  npm run deliver:local -- --work-item REQ-1137 [options]

Options:
  --api <url>          Platform base URL (default: PLATFORM_BASE_URL or https://127.0.0.1:8787)
  --work-item <id>     Work item ID, for example REQ-1137
  --repo <id>          Repository ID (default: work item repo)
  --path <dir>         Client checkout path (default: repository localPath)
  --branch <name>      Expected branch (default: repository branch)
  --run                Start Codex in the client checkout after generating the prompt
  --no-commit          Leave validated changes uncommitted for human review
  --push               Push the resulting commit after Codex succeeds (requires confirmation)
  --close              Mark a local defect closed after delivery is recorded
  --yes                Skip the --push confirmation
  --help               Show this help

The script only reads platform work-item metadata. Code editing, tests, commits and
pushes run on this client against the configured checkout.`
}

function parseArgs(argv: string[]): LocalDeliveryArgs {
  const args: LocalDeliveryArgs = {
    api: process.env.PLATFORM_BASE_URL?.trim() || 'https://127.0.0.1:8787',
    workItem: '',
    run: false,
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

function validateCheckout(localPath: string, expectedBranch: string) {
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
  if (currentBranch !== expectedBranch) {
    throw new Error(`本地仓库当前分支为 ${currentBranch}，与配置分支 ${expectedBranch} 不一致`)
  }
  const dirty = Boolean(requireGit(checkout, ['status', '--porcelain'], '检查本地变更'))
  const head = requireGit(checkout, ['rev-parse', 'HEAD'], '读取本地提交')
  const remote = git(checkout, ['remote', 'get-url', 'origin'])
  return { checkout, branch: currentBranch, dirty, head, remote: remote.stdout }
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

function commitDeliveredChanges(checkout: string, item: WorkItem): string {
  const add = git(checkout, ['add', '--all'])
  if (add.status !== 0) {
    throw new Error(`暂存交付变更失败：${add.stderr || add.stdout || `退出码 ${add.status}`}`)
  }
  const staged = requireGit(checkout, ['diff', '--cached', '--name-only'], '读取暂存变更')
  if (!staged) throw new Error('没有可提交的交付变更')
  const commit = git(checkout, ['commit', '-m', deliveryCommitMessage(item.id, item.title)])
  if (commit.status !== 0) {
    throw new Error(`创建本地交付提交失败：${commit.stderr || commit.stdout || `退出码 ${commit.status}`}`)
  }
  return requireGit(checkout, ['rev-parse', 'HEAD'], '读取交付提交')
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
    { index: 0, status: 'success', log: 'Codex 已实际读取需求、检查代码并完成影响分析' },
    {
      index: 1,
      status: evidence.designReport ? 'success' : 'pending',
      log: evidence.designReport
        ? '已生成 delivery-artifacts/<work-item>/design-report.md'
        : '未检测到 design-report.md，不能标记设计报告完成',
    },
    {
      index: 2,
      status: changed > 0 ? 'success' : 'failed',
      log: `Codex 实际修改代码文件 ${changed} 个：${evidence.changedFiles.slice(0, 8).join(', ') || '无'}`,
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
      log: autoCommit ? '已创建本地提交' : '未启用自动提交，代码保留在工作区',
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
  if (args.noCommit) return null
  const response = await fetch(`${api}/api/pipelines/local`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...platformHeaders(),
    },
    body: JSON.stringify({
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

function buildPrompt(
  item: WorkItem,
  repository: Repository,
  localPath: string,
  branch: string,
  runDescription: string,
  screenshotPaths: string[],
): string {
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
    `Create these evidence files under ${join(localPath, 'delivery-artifacts', item.id)}: design-report.md, integration-report.md, and test-report.md when the corresponding work actually ran.`,
    'Write build-report.md or build.log only for a real build, and upgrade-report.md or upgrade.log only for a real authorized device upgrade. Do not create placeholder evidence.',
    'Do not create, amend, or stage any Git commit. The local delivery runner inspects the worktree, commits validated changes when enabled, and performs the optional push after Codex exits.',
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

  const bootstrap = await fetchBootstrap(args.api)
  const context = await fetchDeliveryContext(args.api, args.workItem)
  const item = context.workItem
  if (!item || item.id !== args.workItem) throw new Error(`平台中不存在工作项 ${args.workItem}`)
  if (item.type === 'requirement') {
    const contextIssue = requirementDeliveryContextIssue({
      requirementBreakdown: context.requirementBreakdown,
      designReference: context.designReference,
      screenshotCount: context.screenshots.length,
    })
    if (contextIssue) throw new Error(contextIssue)
  }
  const repositoryId = args.repo || item.repoId
  const repository = bootstrap.repositories.find((entry) => entry.id === repositoryId)
  if (!repository) throw new Error(`平台中不存在仓库 ${repositoryId}`)

  const localPath = args.path || repository.localPath
  if (!localPath) throw new Error('未配置客户端代码路径，请先在仓库配置中填写本地绝对路径')
  const branch = args.branch || repository.branch || item.branch
  const checkout = validateCheckout(localPath, branch)
  if (!checkout.remote) console.warn('提示：本地仓库没有 origin 远端，--push 将无法执行')

  const artifactDir = join(checkout.checkout, 'delivery-artifacts', item.id)
  mkdirSync(artifactDir, { recursive: true })
  const screenshotPaths = materializeDeliveryScreenshots(artifactDir, context.screenshots)
  const deliveryItem: WorkItem = {
    ...item,
    requirementBreakdown: context.requirementBreakdown ?? item.requirementBreakdown,
    designReference: context.designReference ?? item.designReference,
  }
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
    checkout: checkout.checkout,
    head: checkout.head,
    dirty: checkout.dirty,
    remote: checkout.remote || null,
    promptFile: promptPath,
    screenshotFiles: screenshotPaths,
    run: args.run,
    push: args.push,
    autoCommit: !args.noCommit,
    close: args.close,
    feishuMcp: feishuMcp.status,
    meegleMcp: meegleMcp.status,
  }, null, 2))

  if (!args.run) {
    console.log(`\nPrompt 已生成：${promptPath}`)
    console.log('需要立即执行时，在命令末尾增加 --run。')
    return
  }

  assertCleanDeliveryWorktree(checkout.checkout)

  const codexCommand = resolveCodexBinary()
  if (!codexCommand) throw new Error(codexBinaryError())
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
  const mcpArgs = [
    ...buildFeishuMcpCodexArgs(feishuMcp),
    ...buildMeegleMcpCodexArgs(meegleMcp),
  ]
  const lastMessagePath = join(artifactDir, 'codex-last-message.md')
  const imageArgs = screenshotPaths.flatMap((path) => ['--image', path])
  const result = spawnSync(
    codexCommand,
    [
      'exec',
      ...mcpArgs,
      '-C',
      checkout.checkout,
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '--output-last-message',
      lastMessagePath,
      ...imageArgs,
      prompt,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], encoding: 'utf8' },
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Codex 执行失败，退出码 ${result.status ?? 1}`)

  const evidence = artifactEvidence(artifactDir)
  evidence.changedFiles = deliveryCodeFiles(workTreeFiles(checkout.checkout))
  if (evidence.changedFiles.length === 0) {
    throw new Error(
      'Codex 已结束，但没有检测到非 Markdown 代码文件变更；仅生成说明或报告不算完成编码',
    )
  }
  if (!args.noCommit && (!evidence.designReport || !evidence.integrationReport)) {
    throw new Error('缺少 delivery-artifacts 中的设计报告或集成报告，已停止创建交付提交')
  }

  const finalHead = args.noCommit
    ? requireGit(checkout.checkout, ['rev-parse', 'HEAD'], '读取本地提交')
    : commitDeliveredChanges(checkout.checkout, deliveryItem)

  const stageResults = deliveryStageResults(evidence, !args.noCommit)
  const reports = deliveryReports(artifactDir)

  if (args.push) {
    await confirmPush(branch, args.yes)
    if (!checkout.remote) throw new Error('本地仓库没有 origin 远端，无法推送')
    const push = git(checkout.checkout, ['push', 'origin', `HEAD:refs/heads/${branch}`])
    if (push.status !== 0) {
      throw new Error(`推送失败：${push.stderr || push.stdout || `退出码 ${push.status}`}`)
    }
  }

  let platformPipeline: unknown = null
  try {
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
    stageResults,
    platformPipeline,
    promptFile: promptPath,
    screenshotFiles: screenshotPaths,
    lastMessageFile: lastMessagePath,
  }, null, 2))
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`LOCAL_DELIVERY_ERROR: ${message}`)
  process.exitCode = 1
})
