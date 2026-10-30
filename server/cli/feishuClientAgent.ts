import 'dotenv/config'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir, hostname } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import {
  parseFeishuAgentConfig,
  parseFeishuAgentRepoPaths,
  publicFeishuAgentConfig,
  validateFeishuAgentConfig,
  type FeishuAgentStoredConfig,
} from '../services/feishuAgentConfig.js'
import { codexBinaryError, resolveCodexBinary } from '../services/codexBinaryService.js'
import {
  inspectFeishuMcpAuth,
  resolveFeishuMcpRuntime,
  type FeishuMcpPublicStatus,
} from '../services/feishuMcpService.js'
import {
  resolveMeegleMcpRuntime,
  type MeegleMcpPublicStatus,
} from '../services/meegleMcpService.js'
import {
  buildLocalDeliveryCommand,
  classifyLocalDeliveryFailure,
  createLocalDeliveryAgentSteps,
  fetchJsonWithRetry,
  LOCAL_DELIVERY_CONTRACT_VERSION,
  parseLocalDeliveryAgentRequest,
  resolveLocalDeliveryTarget,
  supportsLocalDeliveryContract,
  updateLocalDeliveryAgentStep,
  type LocalDeliveryAgentRequest,
  type LocalDeliveryBootstrap,
  type LocalDeliveryAgentStep,
} from '../services/localDeliveryAgentService.js'

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface LoginChallenge {
  verificationUri: string
  verificationUriComplete: string
  userCode: string
  expiresAt: number
}

interface PendingLogin extends LoginChallenge {
  clientId: string
  deviceCode: string
}

interface LastRun {
  at: string
  status: 'success' | 'failed'
  summary?: unknown
  error?: string
}

interface AgentSyncResult {
  fetched: number
  upserted: number
  archived: number
  skipped: number
  message: string
  syncedAt: string
}

type LocalDeliveryJobStatus = 'running' | 'succeeded' | 'failed'

interface LocalDeliveryJob {
  id: string
  commandId?: string
  status: LocalDeliveryJobStatus
  stage: string
  workItemId: string
  repoId: string
  localPath?: string
  branch?: string
  steps: LocalDeliveryAgentStep[]
  startedAt: string
  finishedAt?: string
  result?: unknown
  error?: string
}

function deliveryJobSummary(job: LocalDeliveryJob): LocalDeliveryJob {
  return {
    id: job.id,
    commandId: job.commandId,
    status: job.status,
    stage: job.stage,
    workItemId: job.workItemId,
    repoId: job.repoId,
    localPath: job.localPath,
    branch: job.branch,
    steps: job.steps,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.result,
    error: job.error,
  }
}

const agentHost = process.env.FEISHU_AGENT_HOST?.trim() || '127.0.0.1'
const agentPort = positiveInteger(process.env.FEISHU_AGENT_PORT, 18_787)
const heartbeatIntervalMs = positiveInteger(
  process.env.FEISHU_AGENT_HEARTBEAT_INTERVAL_MS,
  10_000,
)
const loginPollIntervalMs = positiveInteger(
  process.env.FEISHU_AGENT_LOGIN_POLL_INTERVAL_MS,
  3_000,
)
const deliveryTimeoutMs = positiveInteger(
  process.env.FEISHU_AGENT_DELIVERY_TIMEOUT_MS,
  45 * 60_000,
)
const meegleCommand = process.env.MEEGLE_BIN?.trim() || 'meegle'
const meegleHost = process.env.MEEGLE_HOST?.trim() || 'project.feishu.cn'
const npmCommand = process.env.NPM_BIN?.trim() || 'npm'
const workspaceRoot = process.cwd()
const configPath = resolve(
  process.env.FEISHU_AGENT_CONFIG_PATH?.trim() ||
    resolve(homedir(), '.config', 'orbit', 'feishu-sync.json'),
)
const allowedOrigins = new Set(
  (
    process.env.FEISHU_AGENT_ALLOWED_ORIGINS ||
    [
      'https://8.145.45.84:8787',
      'https://localhost:8787',
      'https://127.0.0.1:8787',
      'https://localhost:4173',
      'https://127.0.0.1:4173',
    ].join(',')
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
)

let pendingLogin: PendingLogin | null = null
let running = false
let lastRun: LastRun | null = null
let deliveryJob: LocalDeliveryJob | null = null
let heartbeatInFlight = false
let loginPollInFlight = false
let lastHeartbeatError = ''
let lastDeliveryProgressError = ''
let deliveryProgressInFlight = false
let deliveryProgressQueued = false
const activeCommandIds = new Set<string>()
let cachedAuth: Awaited<ReturnType<typeof authStatus>> | null = null
let cachedAuthAt = 0
let cachedMcpAuth: ReturnType<typeof inspectFeishuMcpAuth> | null = null
let cachedMcpAuthAt = 0
let cachedMcpAuthKey = ''

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseJson(textValue: string): unknown {
  const trimmed = textValue.trim()
  if (!trimmed) return undefined
  const candidates = [trimmed]
  for (let index = trimmed.indexOf('{'); index >= 0; index = trimmed.indexOf('{', index + 1)) {
    candidates.push(trimmed.slice(index))
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(candidates[index])
    } catch {
      // Command output may contain progress lines before the JSON document.
    }
  }
  return undefined
}

function readConfig(): FeishuAgentStoredConfig | null {
  if (!existsSync(configPath)) return null
  try {
    const config = parseFeishuAgentConfig(JSON.parse(readFileSync(configPath, 'utf8')))
    if (!config) return null
    const rawRepoPaths = process.env.FEISHU_AGENT_REPO_PATHS?.trim()
    if (!rawRepoPaths) return config
    let environmentRepoPaths: unknown
    try {
      environmentRepoPaths = JSON.parse(rawRepoPaths)
    } catch {
      console.error('FEISHU_AGENT_REPO_PATHS 必须是 JSON 对象，已忽略该环境变量')
      return config
    }
    try {
      return {
        ...config,
        repoPaths: {
          ...config.repoPaths,
          ...parseFeishuAgentRepoPaths(environmentRepoPaths, true),
        },
      }
    } catch (error) {
      console.error(
        `FEISHU_AGENT_REPO_PATHS 无效，已忽略该环境变量：${errorMessage(error)}`,
      )
      return config
    }
  } catch {
    return null
  }
}

function writeConfig(config: FeishuAgentStoredConfig): void {
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(configPath, 0o600)
  } catch {
    // Best-effort protection on platforms without POSIX permissions.
  }
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = 60_000,
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      command,
      args,
      {
        cwd: workspaceRoot,
        env,
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code
        resolvePromise({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode: typeof code === 'number' ? code : code ? 1 : 0,
        })
      },
    )
    // Codex reads piped stdin until EOF before starting a non-interactive run.
    // Close it immediately so a long-running agent never waits for input.
    child.stdin?.end()
  })
}

async function authStatus(): Promise<{
  available: boolean
  authenticated: boolean
  reason?: string
  host?: string
}> {
  const result = await runCommand(
    meegleCommand,
    ['auth', 'status', '--format', 'json'],
    process.env,
    20_000,
  )
  const payload = parseJson(result.stdout) ?? parseJson(result.stderr)
  if (isRecord(payload)) {
    return {
      available: true,
      authenticated: result.exitCode === 0 && payload.authenticated === true,
      reason: text(payload.reason) || undefined,
      host: text(payload.host) || undefined,
    }
  }
  return {
    available: result.exitCode === 0,
    authenticated: false,
    reason: result.stderr.trim() || '无法读取 Meegle 登录状态',
  }
}

async function currentAuthStatus(
  force = false,
): Promise<Awaited<ReturnType<typeof authStatus>>> {
  if (!force && cachedAuth && Date.now() - cachedAuthAt < 20_000) {
    return cachedAuth
  }
  cachedAuth = await authStatus()
  cachedAuthAt = Date.now()
  return cachedAuth
}

async function currentFeishuMcpStatus(force = false): Promise<FeishuMcpPublicStatus> {
  const resolution = resolveFeishuMcpRuntime()
  if (!resolution.status.available) return resolution.status
  const key = `${resolution.command ?? ''}\u0000${resolution.configPath ?? ''}`
  if (!force && cachedMcpAuth && cachedMcpAuthKey === key && Date.now() - cachedMcpAuthAt < 60_000) {
    return {
      ...resolution.status,
      authenticated: cachedMcpAuth.authenticated,
      reason: cachedMcpAuth.reason,
    }
  }
  const auth = inspectFeishuMcpAuth(resolution)
  cachedMcpAuth = auth
  cachedMcpAuthAt = Date.now()
  cachedMcpAuthKey = key
  return {
    ...resolution.status,
    authenticated: auth.authenticated,
    reason: auth.reason,
  }
}

async function currentHealth(): Promise<{
  ok: true
  version: number
  config: ReturnType<typeof publicFeishuAgentConfig>
  meegle: Awaited<ReturnType<typeof authStatus>>
  running: boolean
  lastRun: LastRun | null
  pendingLogin: LoginChallenge | null
  delivery: LocalDeliveryJob | null
  feishuMcp: FeishuMcpPublicStatus
  meegleMcp: MeegleMcpPublicStatus
  codex: {
    available: boolean
    path?: string
  }
}> {
  const config = readConfig()
  const auth = await currentAuthStatus()
  const feishuMcp = await currentFeishuMcpStatus()
  const meegleMcp = resolveMeegleMcpRuntime()
  const codexBinary = resolveCodexBinary()
  return {
    ok: true,
    version: 8,
    config: publicFeishuAgentConfig(config),
    meegle: auth,
    running,
    lastRun,
    pendingLogin,
    delivery: deliveryJob ? deliveryJobSummary(deliveryJob) : null,
    feishuMcp,
    meegleMcp: meegleMcp.status,
    codex: {
      available: Boolean(codexBinary),
      path: codexBinary,
    },
  }
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
}

function summaryFromOutput(stdout: string): AgentSyncResult | undefined {
  const payload = parseJson(stdout)
  if (!isRecord(payload) || typeof payload.projectKey !== 'string') return undefined
  const created = nonNegativeInteger(payload.created)
  const updated = nonNegativeInteger(payload.updated)
  const fetched = nonNegativeInteger(payload.fetched) || created + updated
  const archived = nonNegativeInteger(payload.archived)
  const skipped = nonNegativeInteger(payload.skipped)
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.map(text).filter(Boolean)
    : []
  return {
    fetched,
    upserted: created + updated,
    archived,
    skipped,
    message: `已从飞书同步 ${fetched} 条工作项，新增 ${created} 条、更新 ${updated} 条${
      archived > 0 ? `、归档 ${archived} 条` : ''
    }${warnings.length > 0 ? `；${warnings.join('；')}` : ''}`,
    syncedAt: text(payload.syncedAt) || new Date().toISOString(),
  }
}

async function runSync(): Promise<AgentSyncResult> {
  if (running) throw new Error('同步正在执行，请稍后')
  const config = readConfig()
  if (!config) throw new Error('本机同步代理尚未绑定平台同步密钥')
  const auth = await authStatus()
  if (!auth.available) throw new Error('本机未安装可用的 Meegle CLI')
  if (!auth.authenticated) throw new Error('Meegle 尚未登录，请先完成飞书设备授权')

  running = true
  try {
    const result = await runCommand(
      npmCommand,
      ['run', 'sync:feishu'],
      {
        ...process.env,
        PLATFORM_BASE_URL: config.platformBaseUrl,
        PLATFORM_SYNC_TOKEN: config.syncToken,
        FEISHU_PROJECT_KEY: config.projectKey,
        FEISHU_SYNC_FULL: 'true',
        ...(config.repoId ? { FEISHU_DEFAULT_REPO_ID: config.repoId } : {}),
      },
      15 * 60_000,
    )
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || '飞书同步失败'
      lastRun = { at: new Date().toISOString(), status: 'failed', error: message }
      throw new Error(message)
    }
    const summary = summaryFromOutput(result.stdout) ?? {
      fetched: 0,
      upserted: 0,
      archived: 0,
      skipped: 0,
      message: '飞书同步完成',
      syncedAt: new Date().toISOString(),
    }
    lastRun = { at: new Date().toISOString(), status: 'success', summary }
    return summary
  } finally {
    running = false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function optionalText(value: unknown): string | undefined {
  return text(value) || undefined
}

function setStep(
  job: LocalDeliveryJob,
  key: string,
  status: LocalDeliveryAgentStep['status'],
  log?: string,
): void {
  updateLocalDeliveryAgentStep(job.steps, key, status, log)
  if (status === 'running') {
    job.stage = job.steps.find((step) => step.key === key)?.name ?? job.stage
  }
  scheduleDeliveryProgress(job)
}

async function fetchPlatformHealth(
  job: LocalDeliveryJob,
  config: FeishuAgentStoredConfig,
): Promise<unknown> {
  return fetchJsonWithRetry<unknown>(`${config.platformBaseUrl}/api/health`, {
    label: '读取平台版本',
    attempts: 3,
    timeoutMs: 12_000,
    onRetry: ({ attempt, attempts, error, delayMs }) => {
      setStep(
        job,
        'platform',
        'running',
        `第 ${attempt}/${attempts} 次连接平台失败：${error}；${delayMs}ms 后重试`,
      )
    },
  })
}

async function fetchDeliveryBootstrap(
  job: LocalDeliveryJob,
  config: FeishuAgentStoredConfig,
): Promise<LocalDeliveryBootstrap> {
  const payload = await fetchJsonWithRetry<unknown>(
    `${config.platformBaseUrl}/api/bootstrap?includeWorkItems=1&includeFeishuInbox=0`,
    {
      label: '读取平台工作项与仓库配置',
      attempts: 2,
      timeoutMs: 35_000,
      init: {
        headers: { authorization: `Bearer ${config.syncToken}` },
      },
      onRetry: ({ attempt, attempts, error }) => {
        setStep(
          job,
          'platform',
          'running',
          `第 ${attempt}/${attempts} 次读取平台配置失败：${error}；准备重试`,
        )
      },
    },
  )
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.repositories) ||
    !Array.isArray(payload.workItems)
  ) {
    throw new Error('平台返回的仓库或工作项数据格式不正确')
  }
  return {
    repositories: payload.repositories.filter(isRecord).map((repository) => ({
      id: text(repository.id),
      name: optionalText(repository.name),
      branch: optionalText(repository.branch),
      localPath: optionalText(repository.localPath),
    })),
    workItems: payload.workItems.filter(isRecord).map((workItem) => ({
      id: text(workItem.id),
      title: optionalText(workItem.title),
      repoId: optionalText(workItem.repoId),
      branch: optionalText(workItem.branch),
    })),
  }
}

async function validateClientCheckout(
  job: LocalDeliveryJob,
  localPath: string,
  branch: string,
): Promise<{ checkout: string; branch: string }> {
  setStep(job, 'checkout', 'running', '正在校验绝对路径、Git 根目录与目标分支')
  if (!isAbsolute(localPath)) throw new Error(`客户端代码路径必须是绝对路径：${localPath}`)
  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
    throw new Error(
      `当前执行客户端 ${hostname()} 上不存在代码目录：${localPath}；请确认该路径属于当前客户端，或在 repoPaths 中配置本机路径`,
    )
  }
  const checkout = realpathSync(localPath)
  const root = await runCommand(
    'git',
    ['-C', checkout, 'rev-parse', '--show-toplevel'],
    process.env,
    15_000,
  )
  if (root.exitCode !== 0) {
    throw new Error(`读取 Git 工作区失败：${root.stderr.trim() || root.stdout.trim()}`)
  }
  const gitRoot = realpathSync(root.stdout.trim())
  if (gitRoot !== checkout) {
    throw new Error(`客户端代码路径不是 Git 工作区根目录：${localPath}`)
  }
  const currentBranch = await runCommand(
    'git',
    ['-C', checkout, 'symbolic-ref', '--short', 'HEAD'],
    process.env,
    15_000,
  )
  if (currentBranch.exitCode !== 0) {
    throw new Error(`读取本地分支失败：${currentBranch.stderr.trim() || currentBranch.stdout.trim()}`)
  }
  const actualBranch = currentBranch.stdout.trim()
  if (actualBranch !== branch) {
    throw new Error(`本地仓库当前分支为 ${actualBranch}，与配置分支 ${branch} 不一致`)
  }
  setStep(job, 'checkout', 'success', `${checkout} · ${actualBranch}`)
  return { checkout, branch: actualBranch }
}

function localDeliveryEnvironment(syncToken: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, PLATFORM_SYNC_TOKEN: syncToken }
  for (const key of [
    'FEISHU_INGEST_TOKEN',
    'FEISHU_ACCESS_TOKEN',
    'FEISHU_PLUGIN_SECRET',
    'MEEGLE_USER_ACCESS_TOKEN',
  ]) {
    delete environment[key]
  }
  return environment
}

function commandFailureMessage(result: CommandResult): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
  const errorIndex = lines.findIndex((line) => line.startsWith('LOCAL_DELIVERY_ERROR:'))
  if (errorIndex >= 0) {
    return lines
      .slice(errorIndex)
      .join('\n')
      .slice('LOCAL_DELIVERY_ERROR:'.length)
      .trim()
      .slice(0, 4_000)
  }
  const raw = result.stderr.trim() || result.stdout.trim()
  const message = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-30)
    .join('\n')
  return (message || `本地交付命令退出码 ${result.exitCode}`).slice(-4_000)
}

const DELIVERY_STEP_ORDER = [
  'platform',
  'contract',
  'checkout',
  'codex',
  'evidence',
  'commit',
  'writeback',
]

function markDeliveryFailure(job: LocalDeliveryJob, message: string): void {
  let failedKey = classifyLocalDeliveryFailure(message)
  const runningKey = job.steps.find((step) => step.status === 'running')?.key
  if (failedKey === 'codex' && runningKey && runningKey !== 'codex') {
    failedKey = runningKey
  }
  const failedIndex = DELIVERY_STEP_ORDER.indexOf(failedKey)
  job.steps.forEach((step) => {
    const index = DELIVERY_STEP_ORDER.indexOf(step.key)
    if (index < failedIndex) {
      if (step.status === 'running') {
        step.status = 'success'
        step.finishedAt = new Date().toISOString()
        step.log = step.log || '已完成'
      }
      return
    }
    if (step.key === failedKey) {
      step.status = 'failed'
      step.finishedAt = new Date().toISOString()
      step.log = message.slice(0, 2_000)
      return
    }
    if (step.status === 'running') {
      step.status = 'failed'
      step.finishedAt = new Date().toISOString()
      step.log = `前序步骤失败，本步骤未完成：${message.slice(0, 1_000)}`
    }
  })
  const failedStep = job.steps.find((step) => step.key === failedKey)
  job.stage = `本机交付失败：${failedStep?.name ?? '未知步骤'}`
}

async function executeLocalDelivery(
  job: LocalDeliveryJob,
  config: FeishuAgentStoredConfig,
  request: LocalDeliveryAgentRequest,
): Promise<void> {
  try {
    job.steps = createLocalDeliveryAgentSteps()
    setStep(job, 'platform', 'running', '正在连接平台健康检查接口')
    const health = await fetchPlatformHealth(job, config)
    setStep(job, 'platform', 'running', '平台连接成功，正在校验真实交付契约')
    setStep(job, 'contract', 'running', '检查 deliveryContractVersion')
    if (!supportsLocalDeliveryContract(health)) {
      throw new Error(
        '平台服务端尚未部署真实交付契约，无法保证代码变更、提交和阶段证据；请先升级服务器后重试',
      )
    }
    setStep(job, 'contract', 'success', `交付契约版本 ${LOCAL_DELIVERY_CONTRACT_VERSION}`)

    job.stage = '读取平台工作项与仓库配置'
    const bootstrap = await fetchDeliveryBootstrap(job, config)
    setStep(job, 'platform', 'success', '已读取工作项与仓库配置')
    const target = resolveLocalDeliveryTarget(bootstrap, request, config.repoPaths)
    job.localPath = target.localPath
    job.branch = target.branch
    await validateClientCheckout(job, target.localPath, target.branch)
    setStep(job, 'codex', 'running', 'Codex 正在分析需求、生成设计与代码')
    job.stage = 'Codex 正在执行需求解析、编码与验证'

    const args = buildLocalDeliveryCommand({
      platformBaseUrl: config.platformBaseUrl,
      ...request,
      localPath: target.localPath,
      branch: target.branch,
    })
    const result = await runCommand(
      npmCommand,
      args,
      localDeliveryEnvironment(config.syncToken),
      deliveryTimeoutMs,
    )
    if (result.exitCode !== 0) throw new Error(commandFailureMessage(result))

    const payload = parseJson(result.stdout)
    job.result = isRecord(payload) ? payload : { status: 'success' }
    const changedFiles = isRecord(payload) && Array.isArray(payload.changedFiles)
      ? payload.changedFiles.filter((file): file is string => typeof file === 'string')
      : []
    const evidence = isRecord(payload) && isRecord(payload.evidence) ? payload.evidence : {}
    const commit = isRecord(payload) && typeof payload.commit === 'string' ? payload.commit : ''
    const platformPipeline =
      isRecord(payload) && isRecord(payload.platformPipeline) ? payload.platformPipeline : undefined
    setStep(
      job,
      'codex',
      'success',
      changedFiles.length > 0
        ? `Codex 完成，修改 ${changedFiles.length} 个代码文件`
        : 'Codex 已完成执行',
    )
    const reportCount = ['designReport', 'integrationReport', 'testReport', 'buildReport', 'upgradeReport']
      .filter((key) => evidence[key] === true).length
    setStep(job, 'evidence', 'success', `已确认 ${changedFiles.length} 个代码变更、${reportCount} 份真实报告`)
    setStep(
      job,
      'commit',
      'success',
      commit ? `本地提交 ${commit.slice(0, 12)}` : '本地提交已记录',
    )
    setStep(
      job,
      'writeback',
      'success',
      platformPipeline && typeof platformPipeline.id === 'string'
        ? `平台流水线 ${platformPipeline.id}`
        : '平台已确认真实执行记录',
    )
    job.status = 'succeeded'
    job.stage = '本机交付完成'
  } catch (error) {
    const message = errorMessage(error)
    markDeliveryFailure(job, message)
    job.status = 'failed'
    job.error = message
  } finally {
    job.finishedAt = new Date().toISOString()
  }
  scheduleDeliveryProgress(job)
}

function startLocalDelivery(input: unknown, commandId?: string): LocalDeliveryJob {
  if (deliveryJob?.status === 'running') {
    throw new Error('本机已有交付正在执行，请等待完成后再启动')
  }
  const raw = isRecord(input) ? input : {}
  const job: LocalDeliveryJob = {
    id: `delivery-${randomUUID()}`,
    commandId,
    status: 'running',
    stage: '准备本机交付',
    workItemId: text(raw.workItemId),
    repoId: text(raw.repoId),
    steps: createLocalDeliveryAgentSteps(),
    startedAt: new Date().toISOString(),
  }
  deliveryJob = job
  try {
    const config = readConfig()
    if (!config) throw new Error('本机代理尚未绑定平台同步密钥')
    if (!resolveCodexBinary()) throw new Error(codexBinaryError())
    const request = parseLocalDeliveryAgentRequest(input)
    job.workItemId = request.workItemId
    job.repoId = request.repoId
    void executeLocalDelivery(job, config, request)
  } catch (error) {
    const message = errorMessage(error)
    markDeliveryFailure(job, message)
    job.status = 'failed'
    job.error = message
    job.finishedAt = new Date().toISOString()
  }
  return job
}

async function postAgentJson(
  config: FeishuAgentStoredConfig,
  path: string,
  body: unknown,
  timeout = 30_000,
): Promise<Response> {
  return fetch(`${config.platformBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${config.syncToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
}

async function reportDeliveryProgress(job: LocalDeliveryJob): Promise<void> {
  if (!job.commandId) return
  const config = readConfig()
  if (!config) return
  const response = await postAgentJson(
    config,
    `/api/integrations/feishu/agent/commands/${encodeURIComponent(job.commandId)}/progress`,
    { job: deliveryJobSummary(job) },
    10_000,
  )
  if (!response.ok) {
    throw new Error(`上报本机交付进度失败：${await responseMessage(response)}`)
  }
  if (lastDeliveryProgressError) lastDeliveryProgressError = ''
}

function scheduleDeliveryProgress(job: LocalDeliveryJob): void {
  if (!job.commandId) return
  deliveryProgressQueued = true
  if (deliveryProgressInFlight) return
  deliveryProgressInFlight = true
  void (async () => {
    try {
      while (deliveryProgressQueued) {
        deliveryProgressQueued = false
        await reportDeliveryProgress(job).catch((error) => {
          const message = errorMessage(error)
          if (message !== lastDeliveryProgressError) {
            console.error(message)
            lastDeliveryProgressError = message
          }
        })
      }
    } finally {
      deliveryProgressInFlight = false
    }
  })()
}

async function reportCommandResult(
  commandId: string,
  input: { result?: unknown; error?: string },
): Promise<void> {
  const config = readConfig()
  if (!config) return
  const response = await postAgentJson(
    config,
    `/api/integrations/feishu/agent/commands/${encodeURIComponent(commandId)}/result`,
    input,
  )
  if (!response.ok) {
    throw new Error(`上报代理命令结果失败：${await responseMessage(response)}`)
  }
}

async function executeCommand(command: {
  id: string
  type: 'login_start' | 'sync' | 'rotate_token' | 'delivery_start'
  payload?: unknown
}): Promise<void> {
  try {
    let result: unknown
    if (command.type === 'login_start') {
      result = { challenge: await startLogin() }
    } else if (command.type === 'sync') {
      result = await runSync()
    } else if (command.type === 'delivery_start') {
      result = { job: deliveryJobSummary(startLocalDelivery(command.payload, command.id)) }
    } else {
      result = await rotateToken()
    }
    await reportCommandResult(command.id, { result })
    void sendHeartbeat()
  } catch (error) {
    const message = errorMessage(error)
    console.error(`代理命令执行失败（${command.type}）：${message}`)
    await reportCommandResult(command.id, { error: message }).catch((reportError) => {
      console.error(`代理命令结果上报失败：${errorMessage(reportError)}`)
    })
    void sendHeartbeat()
  } finally {
    activeCommandIds.delete(command.id)
  }
}

function runningCommandIds(): string[] {
  const ids = new Set(activeCommandIds)
  if (deliveryJob?.status === 'running' && deliveryJob.commandId) {
    ids.add(deliveryJob.commandId)
  }
  return [...ids]
}

async function sendHeartbeat(): Promise<void> {
  if (heartbeatInFlight) return
  const config = readConfig()
  if (!config) return
  heartbeatInFlight = true
  try {
    const response = await postAgentJson(
      config,
      '/api/integrations/feishu/agent/heartbeat',
      { health: await currentHealth(), runningCommandIds: runningCommandIds() },
    )
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}：${await responseMessage(response)}`)
    }
    if (lastHeartbeatError) {
      console.log('平台代理心跳已恢复')
      lastHeartbeatError = ''
    }
    const payload = (await response.json().catch(() => null)) as
      | { commands?: unknown }
      | null
    const commands = Array.isArray(payload?.commands) ? payload.commands : []
    for (const command of commands) {
      if (!isRecord(command)) continue
      const id = text(command.id)
      const type = text(command.type)
      if (
        !id ||
        (type !== 'login_start' &&
          type !== 'sync' &&
          type !== 'rotate_token' &&
          type !== 'delivery_start')
      ) {
        continue
      }
      if (deliveryJob?.commandId === id) {
        scheduleDeliveryProgress(deliveryJob)
        continue
      }
      if (activeCommandIds.has(id)) continue
      activeCommandIds.add(id)
      void executeCommand({ id, type, payload: command.payload })
    }
  } catch (error) {
    const message = errorMessage(error)
    if (message !== lastHeartbeatError) {
      console.error(`平台代理心跳失败：${message}`)
      lastHeartbeatError = message
    }
  } finally {
    heartbeatInFlight = false
  }
}

async function pollPendingLogin(): Promise<void> {
  if (!pendingLogin || loginPollInFlight) return
  loginPollInFlight = true
  try {
    const result = await pollLogin()
    if (!result.authenticated) return
    cachedAuth = null
    cachedAuthAt = 0
    console.log('飞书设备授权完成，开始首次全量同步')
    await runSync()
    console.log('首次全量同步完成')
  } catch (error) {
    console.error(`飞书授权轮询失败：${errorMessage(error)}`)
  } finally {
    loginPollInFlight = false
  }
}

async function responseMessage(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  if (!body) return `HTTP ${response.status}`
  try {
    const payload = JSON.parse(body) as {
      error?: { message?: string }
      message?: string
    }
    return payload.error?.message || payload.message || body
  } catch {
    return body
  }
}

async function rotateToken(): Promise<unknown> {
  const config = readConfig()
  if (!config) throw new Error('本机同步代理尚未绑定平台同步密钥')
  const response = await fetch(
    `${config.platformBaseUrl}/api/integrations/feishu/sync-token/rotate`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.syncToken}`,
      },
      signal: AbortSignal.timeout(30_000),
    },
  )
  if (!response.ok) {
    throw new Error(`轮换平台同步密钥失败：${await responseMessage(response)}`)
  }
  const payload = (await response.json()) as { token?: unknown; status?: unknown }
  const token = text(payload.token)
  if (!token) throw new Error('平台未返回新的同步密钥')
  writeConfig({ ...config, syncToken: token })
  return payload.status ?? { configured: true, source: 'database' }
}

async function startLogin(): Promise<LoginChallenge> {
  const result = await runCommand(
    meegleCommand,
    [
      'auth',
      'login',
      '--device-code',
      '--host',
      meegleHost,
      '--phase',
      'init',
      '--format',
      'json',
    ],
    process.env,
    30_000,
  )
  const payload = parseJson(result.stdout) ?? parseJson(result.stderr)
  if (result.exitCode !== 0 || !isRecord(payload)) {
    throw new Error(result.stderr.trim() || '无法发起飞书设备授权')
  }
  const clientId = text(payload.client_id)
  const deviceCode = text(payload.device_code)
  const userCode = text(payload.user_code)
  const verificationUri = text(payload.verification_uri)
  const verificationUriComplete = text(payload.verification_uri_complete) || verificationUri
  const expiresIn = Number(payload.expires_in) || 600
  if (!clientId || !deviceCode || !userCode || !verificationUriComplete) {
    throw new Error('飞书设备授权响应不完整')
  }
  pendingLogin = {
    clientId,
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresAt: Date.now() + expiresIn * 1000,
  }
  return {
    verificationUri,
    verificationUriComplete,
    userCode,
    expiresAt: pendingLogin.expiresAt,
  }
}

async function pollLogin(): Promise<{ authenticated: boolean; message?: string }> {
  if (!pendingLogin) throw new Error('没有待完成的飞书授权')
  if (Date.now() > pendingLogin.expiresAt) {
    pendingLogin = null
    throw new Error('飞书授权已过期，请重新发起')
  }
  const result = await runCommand(
    meegleCommand,
    [
      'auth',
      'login',
      '--device-code',
      '--host',
      meegleHost,
      '--phase',
      'poll',
      '--client-id',
      pendingLogin.clientId,
      '--device-code-value',
      pendingLogin.deviceCode,
      '--once',
      '--format',
      'json',
    ],
    process.env,
    30_000,
  )
  const payload = parseJson(result.stdout) ?? parseJson(result.stderr)
  const authenticated =
    result.exitCode === 0 && isRecord(payload) && payload.authenticated === true
  if (authenticated) {
    pendingLogin = null
    return { authenticated: true, message: '飞书授权完成' }
  }
  const message = isRecord(payload)
    ? text(payload.error_description) || text(payload.message) || text(payload.reason)
    : ''
  return {
    authenticated: false,
    message: message || '等待浏览器完成授权',
  }
}

function corsOrigin(request: IncomingMessage): string | undefined {
  const origin = text(request.headers.origin)
  return origin && allowedOrigins.has(origin) ? origin : undefined
}

function setCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = corsOrigin(request)
  if (text(request.headers.origin) && !origin) return false
  if (origin) response.setHeader('access-control-allow-origin', origin)
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
  response.setHeader('access-control-allow-headers', 'content-type')
  response.setHeader('access-control-allow-private-network', 'true')
  response.setHeader('vary', 'origin')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  return true
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(`${JSON.stringify(payload)}\n`)
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 64 * 1024) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!isRecord(payload)) throw new Error('请求体必须是 JSON 对象')
  return payload
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!setCors(request, response)) {
    sendJson(response, 403, {
      ok: false,
      error: 'origin_not_allowed',
      message: `页面来源 ${text(request.headers.origin)} 未获准访问本机代理，请加入 FEISHU_AGENT_ALLOWED_ORIGINS`,
    })
    return
  }
  if (request.method === 'OPTIONS') {
    response.statusCode = 204
    response.end()
    return
  }
  const path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname
  if (path.startsWith('/delivery/') && !isLoopbackRequest(request)) {
    sendJson(response, 403, { ok: false, error: '本机交付接口仅允许本机页面访问' })
    return
  }
  if (request.method === 'GET' && (path === '/health' || path === '/status')) {
    sendJson(response, 200, await currentHealth())
    return
  }
  if (request.method === 'POST' && path === '/delivery/start') {
    sendJson(response, 202, { ok: true, job: startLocalDelivery(await readBody(request)) })
    return
  }
  const deliveryStatusMatch = path.match(/^\/delivery\/status\/([^/]+)$/)
  if (request.method === 'GET' && deliveryStatusMatch) {
    const jobId = decodeURIComponent(deliveryStatusMatch[1])
    if (!deliveryJob || deliveryJob.id !== jobId) {
      sendJson(response, 404, { ok: false, error: '本机交付任务不存在或已过期' })
      return
    }
    sendJson(response, 200, { ok: true, job: deliveryJob })
    return
  }
  if (request.method === 'POST' && path === '/configure') {
    const config = validateFeishuAgentConfig(await readBody(request))
    writeConfig(config)
    cachedAuth = null
    cachedAuthAt = 0
    void sendHeartbeat()
    sendJson(response, 200, { ok: true, config: publicFeishuAgentConfig(config) })
    return
  }
  if (request.method === 'POST' && path === '/login/start') {
    sendJson(response, 200, { ok: true, challenge: await startLogin() })
    return
  }
  if (request.method === 'POST' && path === '/login/poll') {
    sendJson(response, 200, { ok: true, ...(await pollLogin()) })
    return
  }
  if (request.method === 'POST' && path === '/sync') {
    sendJson(response, 200, { ok: true, summary: await runSync() })
    return
  }
  if (request.method === 'POST' && path === '/rotate-token') {
    sendJson(response, 200, { ok: true, status: await rotateToken() })
    return
  }
  sendJson(response, 404, { error: 'not_found' })
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(response, 400, { ok: false, error: message })
  })
})

server.listen(agentPort, agentHost, () => {
  console.log(`Orbit 飞书同步代理已启动：http://${agentHost}:${agentPort}`)
  console.log(`配置路径：${configPath}`)
  console.log(`允许的页面来源：${[...allowedOrigins].join(', ')}`)
  console.log(`平台代理心跳间隔：${heartbeatIntervalMs}ms`)
  void sendHeartbeat()
})

const heartbeatTimer = setInterval(() => void sendHeartbeat(), heartbeatIntervalMs)
const loginPollTimer = setInterval(() => void pollPendingLogin(), loginPollIntervalMs)

function shutdown(): void {
  clearInterval(heartbeatTimer)
  clearInterval(loginPollTimer)
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
