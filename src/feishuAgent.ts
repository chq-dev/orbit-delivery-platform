import type {
  FeishuAgentBridgeStatus,
  FeishuAgentCommand,
  FeishuAgentCommandType,
} from './types'

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

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

export async function fetchFeishuAgentStatus(): Promise<FeishuAgentBridgeStatus> {
  return request<FeishuAgentBridgeStatus>('/integrations/feishu/agent/status')
}

export async function enqueueFeishuAgentCommand(
  type: FeishuAgentCommandType,
): Promise<FeishuAgentCommand> {
  return request<FeishuAgentCommand>('/integrations/feishu/agent/commands', {
    method: 'POST',
    body: JSON.stringify({ type }),
  })
}
