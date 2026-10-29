import type {
  FeishuClientAgentHealth,
  FeishuLoginChallenge,
  FeishuSyncResult,
  FeishuSyncTokenStatus,
} from './types'

const AGENT_BASE = (
  (import.meta.env.VITE_FEISHU_AGENT_URL as string | undefined)?.trim() ||
  'http://127.0.0.1:18787'
).replace(/\/$/, '')

async function agentRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${AGENT_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(init?.method === 'POST' && path === '/sync' ? 15 * 60_000 : 30_000),
  })
  const payload = (await response.json().catch(() => null)) as
    | { error?: string; ok?: boolean }
    | null
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `本机同步代理请求失败（HTTP ${response.status}）`)
  }
  return payload as T
}

export function getFeishuAgentUrl(): string {
  return AGENT_BASE
}

export async function fetchFeishuAgentHealth(): Promise<FeishuClientAgentHealth> {
  const response = await fetch(`${AGENT_BASE}/health`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`本机同步代理不可用（HTTP ${response.status}）`)
  return (await response.json()) as FeishuClientAgentHealth
}

export async function configureFeishuAgent(input: {
  platformBaseUrl: string
  syncToken: string
  projectKey: string
  repoId?: string
}): Promise<void> {
  await agentRequest('/configure', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function startFeishuAgentLogin(): Promise<FeishuLoginChallenge> {
  const result = await agentRequest<{ challenge: FeishuLoginChallenge }>('/login/start', {
    method: 'POST',
  })
  return result.challenge
}

export async function pollFeishuAgentLogin(): Promise<{ authenticated: boolean; message?: string }> {
  return agentRequest('/login/poll', { method: 'POST' })
}

export async function runFeishuAgentSync(): Promise<FeishuSyncResult> {
  const result = await agentRequest<{ summary: FeishuSyncResult }>('/sync', {
    method: 'POST',
  })
  return result.summary
}

export async function rotateFeishuAgentToken(): Promise<FeishuSyncTokenStatus> {
  const result = await agentRequest<{ status: FeishuSyncTokenStatus }>('/rotate-token', {
    method: 'POST',
  })
  return result.status
}
