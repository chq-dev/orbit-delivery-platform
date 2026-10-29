import type { FeishuClientAgentHealth, LocalDeliveryJob, PipelineRun } from './types'

const configuredAgentUrl = (import.meta.env.VITE_FEISHU_AGENT_URL as string | undefined)?.trim()
const AGENT_BASE = (configuredAgentUrl || 'http://127.0.0.1:18787').replace(/\/$/, '')

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

interface AgentResponse {
  ok?: boolean
  job?: LocalDeliveryJob
  error?: string
}

export interface LocalDeliveryAgentReadiness {
  online: boolean
  configured: boolean
  meegleAuthenticated: boolean
  codexAvailable: boolean
  platformBaseUrl?: string
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as Error & { cause?: unknown }).cause
  if (typeof cause !== 'object' || cause === null) return error.message
  const record = cause as Record<string, unknown>
  return [record.code, record.message]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('；')
}

function agentUnavailableMessage(error: unknown, path: string): string {
  const origin = typeof window === 'undefined' ? '当前页面' : window.location.origin
  const detail = errorDetail(error)
  const timeout = error instanceof Error && error.name === 'TimeoutError'
  const reason = timeout
    ? '请求超时（20 秒）'
    : detail || (error instanceof Error ? error.message : String(error))
  return `无法连接本机交付代理 ${AGENT_BASE}${path}：${reason}。请确认当前客户端已运行 npm run feishu:agent，并允许页面来源 ${origin} 访问本机代理`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function request(path: string, init?: RequestInit): Promise<AgentResponse> {
  let response: Response
  try {
    response = await fetch(`${AGENT_BASE}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    throw new Error(agentUnavailableMessage(error, path))
  }

  const payload = (await response.json().catch(() => null)) as AgentResponse | null
  if (!response.ok || payload?.ok === false) {
    if (payload?.error === 'origin_not_allowed') {
      throw new Error(
        `本机代理拒绝页面来源 ${typeof window === 'undefined' ? '' : window.location.origin}。请把该来源加入 FEISHU_AGENT_ALLOWED_ORIGINS 后重启代理`,
      )
    }
    throw new Error(payload?.error || `本机代理请求失败（HTTP ${response.status}）`)
  }
  return payload ?? {}
}

export function createPendingLocalDeliveryJob(
  input: LocalDeliveryStartInput,
): LocalDeliveryJob {
  const startedAt = new Date().toISOString()
  return {
    id: `pending-${Date.now()}`,
    status: 'running',
    stage: '正在连接本机交付代理',
    workItemId: input.workItemId,
    repoId: input.repoId,
    startedAt,
    steps: LOCAL_DELIVERY_STEP_DEFINITIONS.map((step) => ({
      ...step,
      status: step.key === 'platform' ? 'running' : 'pending',
      log:
        step.key === 'platform'
          ? `正在请求 ${AGENT_BASE}/delivery/start`
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
  const failed = steps.find((step) => step.status === 'running') ?? steps.find((step) => step.status === 'pending')
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
  const payload = await request('/delivery/start', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  if (!payload.job) throw new Error('本机代理未返回交付任务')
  return payload.job
}

export async function probeLocalDeliveryAgent(): Promise<LocalDeliveryAgentReadiness> {
  try {
    const payload = await request('/health')
    const health = payload as unknown as FeishuClientAgentHealth
    return {
      online: true,
      configured: Boolean(health.config?.configured),
      meegleAuthenticated: Boolean(health.meegle?.authenticated),
      codexAvailable: Boolean(health.codex?.available),
      platformBaseUrl: health.config?.platformBaseUrl,
    }
  } catch (error) {
    return {
      online: false,
      configured: false,
      meegleAuthenticated: false,
      codexAvailable: false,
      error: error instanceof Error ? error.message : '无法连接本机交付代理',
    }
  }
}

export async function getLocalDeliveryStatus(id: string): Promise<LocalDeliveryJob> {
  const payload = await request(`/delivery/status/${encodeURIComponent(id)}`)
  if (!payload.job) throw new Error('本机代理未返回交付任务状态')
  return payload.job
}

export async function waitForLocalDelivery(
  id: string,
  onUpdate: (job: LocalDeliveryJob) => void,
  timeoutMs = 45 * 60_000,
): Promise<LocalDeliveryJob> {
  const deadline = Date.now() + timeoutMs
  let consecutiveErrors = 0
  while (Date.now() < deadline) {
    await delay(1_500)
    let job: LocalDeliveryJob
    try {
      job = await getLocalDeliveryStatus(id)
      consecutiveErrors = 0
    } catch (error) {
      consecutiveErrors += 1
      if (consecutiveErrors < 5) continue
      throw error
    }
    onUpdate(job)
    if (job.status === 'succeeded') return job
    if (job.status === 'failed') throw new Error(job.error || '本机交付执行失败')
  }
  throw new Error('本机交付执行超时，请在本机终端检查代理与 Codex 日志')
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
