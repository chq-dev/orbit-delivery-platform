import type {
  FeishuAgentBridgeStatus,
  FeishuAgentCommand,
  FeishuAgentCommandType,
  FeishuClientAgentHealth,
  LocalDeliveryJob,
} from './types'

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'
const LOCAL_AGENT_BASE = 'http://127.0.0.1:18787'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(30_000),
  })
  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string }; ok?: boolean }
    | null
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error?.message || `代理请求失败（HTTP ${response.status}）`)
  }
  return payload as T
}

export async function fetchFeishuAgentStatus(
  clientId?: string,
): Promise<FeishuAgentBridgeStatus> {
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''
  return request<FeishuAgentBridgeStatus>(`/integrations/feishu/agent/status${query}`)
}

export async function enqueueFeishuAgentCommand(
  type: FeishuAgentCommandType,
  clientId?: string,
  payload?: unknown,
): Promise<FeishuAgentCommand> {
  return request<FeishuAgentCommand>('/integrations/feishu/agent/commands', {
    method: 'POST',
    body: JSON.stringify({ type, clientId, ...(payload === undefined ? {} : { payload }) }),
  })
}

async function requestLocalAgent<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${LOCAL_AGENT_BASE}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error('无法连接当前 Mac 的本机代理，请确认 npm run feishu:agent 正在运行')
  }
  const payload = (await response.json().catch(() => null)) as
    | { error?: string; message?: string; config?: unknown }
    | null
  if (!response.ok) {
    if (path === '/pairing/target' && response.status === 404) {
      throw new Error('当前 Mac 代理版本过旧，请更新并重启代理后再绑定线上服务')
    }
    throw new Error(payload?.message || payload?.error || `本机代理请求失败（HTTP ${response.status}）`)
  }
  return payload as T
}

export function fetchLocalFeishuAgentHealth(): Promise<FeishuClientAgentHealth> {
  return requestLocalAgent<FeishuClientAgentHealth>('/health')
}

export async function fetchLocalDeliveryJob(): Promise<LocalDeliveryJob | null> {
  const health = await fetchLocalFeishuAgentHealth()
  return health.delivery ?? null
}

export function setLocalFeishuAgentPairingTarget(
  platformBaseUrl: string,
): Promise<{
  ok: true
  clientId: string
  clientName: string
  platformBaseUrl: string
}> {
  return requestLocalAgent('/pairing/target', {
    method: 'POST',
    body: JSON.stringify({ platformBaseUrl }),
  })
}

export async function cancelLocalDeliveryJob(jobId?: string): Promise<LocalDeliveryJob> {
  const payload = await requestLocalAgent<{ ok: true; job: LocalDeliveryJob }>(
    '/delivery/cancel',
    {
      method: 'POST',
      body: JSON.stringify(jobId ? { jobId } : {}),
    },
  )
  return payload.job
}

export function configureLocalFeishuAgent(input: {
  platformBaseUrl: string
  syncToken: string
  projectKey: string
  repoPaths: Record<string, string>
}): Promise<{ ok: true; config: FeishuClientAgentHealth['config'] }> {
  return requestLocalAgent('/configure', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function configureLocalFeishuAgentRepoPaths(
  repoPaths: Record<string, string>,
): Promise<{ ok: true; config: FeishuClientAgentHealth['config'] }> {
  return requestLocalAgent('/repo-paths', {
    method: 'POST',
    body: JSON.stringify({ repoPaths }),
  })
}
