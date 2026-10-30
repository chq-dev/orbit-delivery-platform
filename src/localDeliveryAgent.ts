import type {
  FeishuAgentBridgeStatus,
  FeishuAgentCommand,
  FeishuClientAgentHealth,
  LocalDeliveryJob,
  LocalDeliveryStep,
  PipelineRun,
} from './types'

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

const LOCAL_DELIVERY_STEP_DEFINITIONS = [
  { key: 'platform', name: '读取平台', description: '加载工作项、仓库路径与目标分支' },
  { key: 'contract', name: '校验契约', description: '确认服务端支持真实阶段证据' },
  { key: 'checkout', name: '校验仓库', description: '校验客户端路径、Git 根目录与分支' },
  { key: 'codex', name: 'Codex 执行', description: '分析、设计、编码并生成执行证据' },
  { key: 'evidence', name: '检查证据', description: '确认代码变更、报告与提交' },
  { key: 'commit', name: '提交推送', description: '记录本地提交并按授权推送' },
  { key: 'writeback', name: '回写平台', description: '写入真实 commit 与阶段结果' },
] as const

export interface LocalDeliveryStartInput {
  workItemId: string
  repoId: string
  autoCommit: boolean
  pushAfterAcceptance: boolean
  autoClose: boolean
}

interface ApiResponse {
  ok?: boolean
  error?: string | { message?: string }
}

export interface LocalDeliveryAgentReadiness {
  online: boolean
  platformReady: boolean
  configured: boolean
  meegleAuthenticated: boolean
  codexAvailable: boolean
  platformBaseUrl?: string
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function apiErrorMessage(payload: ApiResponse | null, status: number): string {
  if (typeof payload?.error === 'string') return payload.error
  if (payload?.error?.message) return payload.error.message
  return `平台代理请求失败（HTTP ${status}）`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`无法读取平台代理状态：${detail}。请检查平台服务是否可访问`)
  }

  const payload = (await response.json().catch(() => null)) as
    | (T & ApiResponse)
    | null
  if (!response.ok || payload?.ok === false) {
    throw new Error(apiErrorMessage(payload, response.status))
  }
  return payload as T
}

function isDeliveryJob(value: unknown): value is LocalDeliveryJob {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.status === 'running' || value.status === 'succeeded' || value.status === 'failed') &&
    Array.isArray(value.steps)
  )
}

function jobFromCommand(command: FeishuAgentCommand | undefined): LocalDeliveryJob | undefined {
  if (!isRecord(command?.result)) return undefined
  return isDeliveryJob(command.result.job) ? command.result.job : undefined
}

function jobFromHealth(
  status: FeishuAgentBridgeStatus,
  commandId: string,
): LocalDeliveryJob | undefined {
  const job = status.health?.delivery
  if (!isDeliveryJob(job)) return undefined
  return job.commandId === commandId || job.id === commandId ? job : undefined
}

function queuedSteps(command: FeishuAgentCommand): LocalDeliveryStep[] {
  const startedAt = command.createdAt
  return LOCAL_DELIVERY_STEP_DEFINITIONS.map((step) => ({
    ...step,
    status: step.key === 'platform' ? 'running' : 'pending',
    log:
      step.key === 'platform'
        ? command.status === 'pending'
          ? '任务已下发，等待本机代理领取'
          : '本机代理已领取任务，等待执行状态回传'
        : undefined,
    startedAt: step.key === 'platform' ? startedAt : undefined,
  }))
}

function queuedJobFromCommand(
  command: FeishuAgentCommand,
  input: LocalDeliveryStartInput,
): LocalDeliveryJob {
  const job = jobFromCommand(command)
  if (job) return job
  return {
    id: command.id,
    commandId: command.id,
    status: 'running',
    stage: command.status === 'pending' ? '等待本机代理领取' : '本机代理已领取',
    workItemId: input.workItemId,
    repoId: input.repoId,
    startedAt: command.createdAt,
    steps: queuedSteps(command),
  }
}

export function createPendingLocalDeliveryJob(
  input: LocalDeliveryStartInput,
): LocalDeliveryJob {
  const startedAt = new Date().toISOString()
  return {
    id: `pending-${Date.now()}`,
    status: 'running',
    stage: '正在下发到本机代理',
    workItemId: input.workItemId,
    repoId: input.repoId,
    startedAt,
    steps: LOCAL_DELIVERY_STEP_DEFINITIONS.map((step) => ({
      ...step,
      status: step.key === 'platform' ? 'running' : 'pending',
      log:
        step.key === 'platform'
          ? '正在通过平台命令队列下发给本机代理'
          : undefined,
      startedAt: step.key === 'platform' ? startedAt : undefined,
    })),
  }
}

export function markLocalDeliveryStartFailed(
  job: LocalDeliveryJob,
  message: string,
): LocalDeliveryJob {
  const finishedAt = new Date().toISOString()
  const steps = (job.steps ?? []).map((step) => ({ ...step }))
  const failed =
    steps.find((step) => step.status === 'running') ??
    steps.find((step) => step.status === 'pending')
  if (failed) {
    failed.status = 'failed'
    failed.finishedAt = finishedAt
    failed.log = message
  }
  return {
    ...job,
    status: 'failed',
    stage: failed ? `本机交付失败：${failed.name}` : '本机交付启动失败',
    error: message,
    finishedAt,
    steps,
  }
}

export async function startLocalDelivery(
  input: LocalDeliveryStartInput,
): Promise<LocalDeliveryJob> {
  const command = await request<FeishuAgentCommand>('/integrations/feishu/agent/commands', {
    method: 'POST',
    body: JSON.stringify({ type: 'delivery_start', payload: input }),
  })
  if (!command.id) throw new Error('平台未返回本机交付命令')
  return queuedJobFromCommand(command, input)
}

export async function probeLocalDeliveryAgent(): Promise<LocalDeliveryAgentReadiness> {
  try {
    const [status, platform] = await Promise.all([
      request<FeishuAgentBridgeStatus>('/integrations/feishu/agent/status'),
      request<{ deliveryContractVersion?: number }>('/health'),
    ])
    const health: FeishuClientAgentHealth | undefined = status.health
    const platformReady = Number(platform.deliveryContractVersion) >= 3
    return {
      online: status.online,
      platformReady,
      configured: Boolean(health?.config?.configured),
      meegleAuthenticated: Boolean(health?.meegle?.authenticated),
      codexAvailable: Boolean(health?.codex?.available),
      platformBaseUrl: health?.config?.platformBaseUrl,
      error: !platformReady
        ? '平台服务端仍是旧版本，请部署新服务端后重试'
        : status.online
          ? undefined
          : '本机代理心跳已超过 90 秒未上报',
    }
  } catch (error) {
    return {
      online: false,
      platformReady: false,
      configured: false,
      meegleAuthenticated: false,
      codexAvailable: false,
      error: error instanceof Error ? error.message : '无法读取平台代理状态',
    }
  }
}

export async function waitForLocalDelivery(
  commandId: string,
  onUpdate: (job: LocalDeliveryJob) => void,
  timeoutMs = 45 * 60_000,
): Promise<LocalDeliveryJob> {
  const deadline = Date.now() + timeoutMs
  let consecutiveErrors = 0
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 1_500))
    let status: FeishuAgentBridgeStatus
    try {
      status = await request<FeishuAgentBridgeStatus>('/integrations/feishu/agent/status')
      consecutiveErrors = 0
    } catch (error) {
      consecutiveErrors += 1
      if (consecutiveErrors < 5) continue
      throw error
    }

    const command = status.commands.find((entry) => entry.id === commandId)
    const job = jobFromCommand(command) ?? jobFromHealth(status, commandId)
    if (job) {
      onUpdate(job)
      if (job.status === 'succeeded') return job
      if (job.status === 'failed') throw new Error(job.error || '本机交付执行失败')
      continue
    }
    if (command?.status === 'failed') {
      throw new Error(command.error || '本机代理执行交付命令失败')
    }
    if (command?.status === 'succeeded') {
      throw new Error('本机代理已接受命令，但没有返回交付任务状态')
    }
  }
  throw new Error('本机交付执行超时，请检查客户端代理与 Codex 日志')
}

export function pipelineFromDeliveryResult(result: unknown): PipelineRun | undefined {
  if (!isRecord(result)) return undefined
  const candidate = result.platformPipeline
  if (
    !isRecord(candidate) ||
    typeof candidate.id !== 'string' ||
    typeof candidate.workItemId !== 'string' ||
    typeof candidate.status !== 'string'
  ) {
    return undefined
  }
  return candidate as unknown as PipelineRun
}
