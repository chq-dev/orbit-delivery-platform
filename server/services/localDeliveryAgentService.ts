import { isAbsolute } from 'node:path'

export const LOCAL_DELIVERY_CONTRACT_VERSION = 3

export type LocalDeliveryAgentStepStatus = 'pending' | 'running' | 'success' | 'failed'

export interface LocalDeliveryAgentStepDefinition {
  key: string
  name: string
  description: string
}

export interface LocalDeliveryAgentStep extends LocalDeliveryAgentStepDefinition {
  status: LocalDeliveryAgentStepStatus
  log?: string
  startedAt?: string
  finishedAt?: string
}

export const LOCAL_DELIVERY_AGENT_STEPS: readonly LocalDeliveryAgentStepDefinition[] = [
  { key: 'platform', name: '读取平台', description: '加载工作项、仓库路径与目标分支' },
  { key: 'contract', name: '校验契约', description: '确认服务端支持真实阶段证据' },
  { key: 'checkout', name: '校验仓库', description: '校验客户端路径、Git 根目录与分支' },
  { key: 'codex', name: 'Codex 执行', description: '分析、设计、编码并生成执行证据' },
  { key: 'evidence', name: '检查证据', description: '确认代码变更、报告与提交' },
  { key: 'commit', name: '提交推送', description: '记录本地提交并按授权推送' },
  { key: 'writeback', name: '回写平台', description: '写入真实 commit 与阶段结果' },
]

export function createLocalDeliveryAgentSteps(): LocalDeliveryAgentStep[] {
  return LOCAL_DELIVERY_AGENT_STEPS.map((step) => ({ ...step, status: 'pending' }))
}

export function updateLocalDeliveryAgentStep(
  steps: LocalDeliveryAgentStep[],
  key: string,
  status: LocalDeliveryAgentStepStatus,
  log?: string,
): LocalDeliveryAgentStep | undefined {
  const step = steps.find((entry) => entry.key === key)
  if (!step) return undefined
  const now = new Date().toISOString()
  step.status = status
  if (status === 'running' && !step.startedAt) step.startedAt = now
  if (status === 'success' || status === 'failed') step.finishedAt = now
  if (log) step.log = log
  return step
}

export interface FetchJsonOptions {
  label?: string
  attempts?: number
  timeoutMs?: number
  init?: RequestInit
  onRetry?: (context: { attempt: number; attempts: number; error: string; delayMs: number }) => void
}

function errorCause(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof Error)) return undefined
  const cause = (error as Error & { cause?: unknown }).cause
  return typeof cause === 'object' && cause !== null
    ? (cause as Record<string, unknown>)
    : undefined
}

export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = errorCause(error)
  const parts = [error.name === 'TimeoutError' ? '请求超时' : error.message]
  for (const value of [cause?.code, cause?.message, cause?.errno]) {
    const detail = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
    if (detail && !parts.includes(detail)) parts.push(detail)
  }
  return parts.filter(Boolean).join('；')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchJsonWithRetry<T>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T> {
  const label = options.label ?? '读取平台'
  const attempts = Math.max(1, options.attempts ?? 3)
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 15_000)
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options.init,
        headers: { accept: 'application/json', ...options.init?.headers },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        const body = (await response.text().catch(() => '')).trim().slice(0, 500)
        throw new Error(`${label}失败（HTTP ${response.status}）${body ? `：${body}` : ''}`)
      }
      try {
        return (await response.json()) as T
      } catch {
        throw new Error(`${label}失败：平台返回内容不是合法 JSON`)
      }
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        const delayMs = 700 * attempt
        options.onRetry?.({
          attempt,
          attempts,
          error: describeFetchError(error),
          delayMs,
        })
        await delay(delayMs)
      }
    }
  }
  throw new Error(`${label}失败：${describeFetchError(lastError)}`)
}

export function supportsLocalDeliveryContract(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const version = Number((value as Record<string, unknown>).deliveryContractVersion)
  return Number.isInteger(version) && version >= LOCAL_DELIVERY_CONTRACT_VERSION
}

export interface LocalDeliveryAgentRequest {
  workItemId: string
  repoId: string
  autoCommit: boolean
  pushAfterAcceptance: boolean
  autoClose: boolean
}

export interface LocalDeliveryBootstrapRepository {
  id: string
  name?: string
  branch?: string
  localPath?: string
}

export interface LocalDeliveryBootstrapWorkItem {
  id: string
  title?: string
  repoId?: string
  branch?: string
}

export interface LocalDeliveryBootstrap {
  repositories: LocalDeliveryBootstrapRepository[]
  workItems: LocalDeliveryBootstrapWorkItem[]
}

export interface LocalDeliveryTarget {
  workItem: LocalDeliveryBootstrapWorkItem
  repository: LocalDeliveryBootstrapRepository
  localPath: string
  branch: string
}

export interface LocalDeliveryCommandInput {
  platformBaseUrl: string
  workItemId: string
  repoId: string
  autoCommit: boolean
  pushAfterAcceptance: boolean
  autoClose: boolean
  localPath: string
  branch: string
}

export interface CodexExecArgsInput {
  checkout: string
  prompt: string
  lastMessagePath: string
  imagePaths: string[]
  mcpArgs: string[]
}

const REQUEST_KEYS = new Set([
  'workItemId',
  'repoId',
  'autoCommit',
  'pushAfterAcceptance',
  'autoClose',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function requiredIdentifier(value: unknown, label: string): string {
  const candidate = text(value)
  if (!candidate) throw new Error(`缺少${label}`)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(candidate)) {
    throw new Error(`${label}格式不正确`)
  }
  return candidate
}

function booleanOption(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${label}必须是布尔值`)
  return value
}

export function parseLocalDeliveryAgentRequest(input: unknown): LocalDeliveryAgentRequest {
  if (!isRecord(input)) throw new Error('请求体必须是 JSON 对象')
  const unknownKeys = Object.keys(input).filter((key) => !REQUEST_KEYS.has(key))
  if (unknownKeys.length > 0) {
    throw new Error(`不支持交付参数：${unknownKeys.join(', ')}`)
  }

  const autoCommit = booleanOption(input.autoCommit, '自动提交', true)
  const pushAfterAcceptance = booleanOption(input.pushAfterAcceptance, '验收后推送', false)
  if (pushAfterAcceptance && !autoCommit) {
    throw new Error('未启用自动提交时不能推送')
  }
  return {
    workItemId: requiredIdentifier(input.workItemId, '工作项'),
    repoId: requiredIdentifier(input.repoId, '代码仓库'),
    autoCommit,
    pushAfterAcceptance,
    autoClose: booleanOption(input.autoClose, '自动关闭缺陷', false),
  }
}

export function resolveLocalDeliveryTarget(
  bootstrap: LocalDeliveryBootstrap,
  request: LocalDeliveryAgentRequest,
  repoPaths: Record<string, string> = {},
): LocalDeliveryTarget {
  const workItem = bootstrap.workItems.find((entry) => entry.id === request.workItemId)
  if (!workItem) throw new Error(`平台中不存在工作项 ${request.workItemId}`)
  const repository = bootstrap.repositories.find((entry) => entry.id === request.repoId)
  if (!repository) throw new Error(`平台中不存在代码仓库 ${request.repoId}`)

  const localPath = text(repoPaths[repository.id]) || text(repository.localPath)
  if (!localPath) {
    throw new Error(
      '该仓库尚未配置当前客户端的代码路径；请在平台仓库设置或本机代理 repoPaths 中配置绝对路径',
    )
  }
  if (!isAbsolute(localPath)) throw new Error(`客户端代码路径必须是绝对路径：${localPath}`)
  const branch = text(repository.branch) || text(workItem.branch)
  if (!branch) throw new Error('该仓库尚未配置目标分支')
  return { workItem, repository, localPath, branch }
}

export function buildLocalDeliveryCommand(input: LocalDeliveryCommandInput): string[] {
  if (!text(input.platformBaseUrl)) throw new Error('本机代理尚未绑定平台地址')
  if (!isAbsolute(input.localPath)) {
    throw new Error(`客户端代码路径必须是绝对路径：${input.localPath}`)
  }
  if (!text(input.branch)) throw new Error('目标分支不能为空')

  const args = [
    'run',
    'deliver:local',
    '--',
    '--api',
    input.platformBaseUrl,
    '--work-item',
    input.workItemId,
    '--repo',
    input.repoId,
    '--path',
    input.localPath,
    '--branch',
    input.branch,
    '--run',
  ]
  if (!input.autoCommit) args.push('--no-commit')
  else if (input.pushAfterAcceptance) args.push('--push', '--yes')
  if (input.autoClose) args.push('--close')
  return args
}

export function buildCodexExecArgs(input: CodexExecArgsInput): string[] {
  if (!text(input.checkout)) throw new Error('Codex 工作目录不能为空')
  if (!text(input.prompt)) throw new Error('Codex 提示词不能为空')
  if (!text(input.lastMessagePath)) throw new Error('Codex 最后消息文件不能为空')
  return [
    'exec',
    ...input.mcpArgs,
    '-C',
    input.checkout,
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '--output-last-message',
    input.lastMessagePath,
    ...input.imagePaths.flatMap((path) => ['--image', path]),
    '--',
    input.prompt,
  ]
}

export function classifyLocalDeliveryFailure(message: string): string {
  if (/契约|deliveryContractVersion/i.test(message)) return 'contract'
  if (
    /不支持交付参数|缺少工作项|缺少代码仓库|自动提交|布尔值|未启用自动提交/.test(message)
  ) {
    return 'contract'
  }
  if (/未提交变更|工作区.*清理|尚未配置客户端代码路径/.test(message)) return 'checkout'
  if (/没有检测到.*代码文件变更|缺少 delivery-artifacts|仅生成说明或报告/.test(message)) {
    return 'evidence'
  }
  if (/Codex 执行失败|No prompt provided|Reading prompt from stdin/i.test(message)) {
    return 'codex'
  }
  if (/HEAD 没有变化|创建本地交付提交失败|暂存交付变更|没有可提交的交付变更|推送失败/.test(message)) {
    return 'commit'
  }
  if (/回写平台|平台未返回|流水线记录/.test(message)) return 'writeback'
  if (/路径|分支|Git 工作区|工作区根目录/.test(message)) return 'checkout'
  if (
    /读取平台|尚未绑定平台|本机代理|fetch failed|HTTP|超时|timeout|ECONN|ENOTFOUND|EAI_AGAIN/i.test(
      message,
    )
  ) {
    return 'platform'
  }
  return 'codex'
}
