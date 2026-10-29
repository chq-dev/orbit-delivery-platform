import {
  parseFeishuSnapshot,
  type FeishuSnapshot,
  type ParsedFeishuSnapshot,
} from './feishuSnapshotCore'

export {
  mapFeishuSnapshotItems,
  mergeFeishuSnapshot,
  parseFeishuSnapshot,
  type FeishuSnapshot,
  type FeishuSnapshotItem,
  type ParsedFeishuSnapshot,
} from './feishuSnapshotCore'

const CACHE_KEY = 'orbit.feishuSnapshot.v1'
const DEFAULT_SNAPSHOT_URL = '/feishu-work-items.json'
const DEFAULT_REFRESH_MS = 60_000
const MIN_REFRESH_MS = 15_000

export interface FeishuSnapshotConfig {
  url: string
  refreshMs: number
}

export function getFeishuSnapshotConfig(): FeishuSnapshotConfig {
  const url =
    (import.meta.env.VITE_FEISHU_SNAPSHOT_URL as string | undefined)?.trim() ||
    DEFAULT_SNAPSHOT_URL
  const configuredRefresh = Number(import.meta.env.VITE_FEISHU_SNAPSHOT_REFRESH_MS)
  const refreshMs =
    Number.isInteger(configuredRefresh) && configuredRefresh >= MIN_REFRESH_MS
      ? configuredRefresh
      : DEFAULT_REFRESH_MS
  return { url, refreshMs }
}

export async function fetchFeishuSnapshot(url: string): Promise<ParsedFeishuSnapshot> {
  const separator = url.includes('?') ? '&' : '?'
  const response = await fetch(`${url}${separator}_t=${Date.now()}`, {
    cache: 'no-store',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(`飞书快照读取失败（HTTP ${response.status}）：${url}`)
  }
  return parseFeishuSnapshot(await response.json())
}

export function readCachedFeishuSnapshot(): FeishuSnapshot | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    return raw ? parseFeishuSnapshot(JSON.parse(raw)).snapshot : null
  } catch {
    return null
  }
}

export function writeCachedFeishuSnapshot(snapshot: FeishuSnapshot): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot))
  } catch {
    // A full or disabled localStorage must not prevent live data from rendering.
  }
}
