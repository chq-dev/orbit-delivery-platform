import type { FeishuAgentClientStatus } from './types'

const LOCAL_AGENT_HEALTH_URL = 'http://127.0.0.1:18787/health'
const DISCOVERY_CACHE_MS = 15_000

let cachedClientId: { clientId: string; at: number } | null = null
let discovery: Promise<string | undefined> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function localAgentClientIdFromHealth(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const config = value.config
  if (!isRecord(config)) return undefined
  const clientId = typeof config.clientId === 'string' ? config.clientId.trim() : ''
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(clientId) ? clientId : undefined
}

/**
 * The platform can be opened from any machine. Probe only this browser's
 * loopback agent, never another host, so a task is not quietly sent to a
 * different checkout that happens to be online.
 */
export async function discoverLocalFeishuAgentClientId(): Promise<string | undefined> {
  if (cachedClientId && Date.now() - cachedClientId.at < DISCOVERY_CACHE_MS) {
    return cachedClientId.clientId
  }
  if (discovery) return discovery
  discovery = (async () => {
    try {
      const response = await fetch(LOCAL_AGENT_HEALTH_URL, {
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
    } finally {
      discovery = null
    }
  })()
  return discovery
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
