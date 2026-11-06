import type { FeishuAgentClientStatus } from './types'

const LOCAL_AGENT_IDENTITY_URL = 'http://127.0.0.1:18787/identity'
const LOCAL_AGENT_SETUP_URL = 'http://127.0.0.1:18787/setup/meegle'
const DISCOVERY_CACHE_MS = 15_000
const LOCAL_CLIENT_ID_KEY = 'orbit-feishu-local-agent-client-id'

let cachedClientId: { clientId: string; at: number } | null = null
let discovery: Promise<string | undefined> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function localAgentClientIdFromHealth(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const config = isRecord(value.config) ? value.config : undefined
  const clientId = typeof value.clientId === 'string'
    ? value.clientId.trim()
    : typeof config?.clientId === 'string'
      ? config.clientId.trim()
      : ''
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(clientId) ? clientId : undefined
}

export async function setupLocalMeegleCli(): Promise<{
  available: boolean
  authenticated: boolean
  host?: string
}> {
  const response = await fetch(LOCAL_AGENT_SETUP_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(5 * 60_000),
  })
  const payload = await response.json().catch(() => null) as
    | { ok?: boolean; status?: { available?: boolean; authenticated?: boolean; host?: string }; error?: string }
    | null
  if (!response.ok || payload?.ok !== true || !payload.status) {
    throw new Error(payload?.error || `本机快捷配置失败（HTTP ${response.status}）`)
  }
  return {
    available: payload.status.available === true,
    authenticated: payload.status.authenticated === true,
    host: payload.status.host,
  }
}

/**
 * The platform can be opened from any machine. Probe only this browser's
 * loopback agent, never another host, so a task is not quietly sent to a
 * different checkout that happens to be online.
 */
export async function discoverLocalFeishuAgentClientId(forceProbe = false): Promise<string | undefined> {
  if (forceProbe) cachedClientId = null
  if (!forceProbe) {
    try {
      const remembered = localStorage.getItem(LOCAL_CLIENT_ID_KEY)?.trim()
      if (remembered && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(remembered)) {
        cachedClientId = { clientId: remembered, at: Date.now() }
        return remembered
      }
    } catch {
      // Continue with the loopback probe when local storage is unavailable.
    }
  }
  if (cachedClientId && Date.now() - cachedClientId.at < DISCOVERY_CACHE_MS) {
    return cachedClientId.clientId
  }
  if (discovery && !forceProbe) return discovery
  const probing = Promise.resolve().then(async () => {
    try {
      const response = await fetch(LOCAL_AGENT_IDENTITY_URL, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(1_500),
      })
      if (!response.ok) return undefined
      const clientId = localAgentClientIdFromHealth(await response.json())
      if (!clientId) return undefined
      cachedClientId = { clientId, at: Date.now() }
      return clientId
    } catch {
      return undefined
    }
  })
  let shared: Promise<string | undefined>
  shared = probing.finally(() => {
    if (discovery === shared) discovery = null
  })
  discovery = shared
  return shared
}

export function rememberLocalFeishuAgentClientId(clientId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(clientId)) return
  cachedClientId = { clientId, at: Date.now() }
  try {
    localStorage.setItem(LOCAL_CLIENT_ID_KEY, clientId)
  } catch {
    // The client remains selectable from the account center if storage is disabled.
  }
}

export function clearLocalFeishuAgentDiscoveryCache(): void {
  cachedClientId = null
}

export function localAgentIsRegistered(
  clientId: string | undefined,
  clients: FeishuAgentClientStatus[],
): boolean {
  return Boolean(clientId && clients.some((client) => client.clientId === clientId))
}
