import 'dotenv/config'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  assertMeegleAuthenticated,
  fetchMeegleWorkItems,
  type MeegleSyncConfig,
} from '../services/meegleCliClient.js'
import {
  buildFeishuSnapshot,
  writeFeishuSnapshot,
} from '../services/feishuSnapshotService.js'
import type { SyncedFeishuWorkItem } from '../services/workItemService.js'

interface SyncState {
  lastSuccessfulSyncAt?: string
  projectKey?: string
  fetched?: number
  created?: number
  updated?: number
}

interface PlatformIngestResult {
  fetched: number
  created: number
  updated: number
  skipped: number
  message: string
  syncedAt: string
}

interface SyncSummary {
  projectKey: string
  fetched: number
  created: number
  updated: number
  skipped: number
  warnings: string[]
  syncedAt: string
  snapshotFile: string
}

function textEnv(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) return fallback
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  return fallback
}

function syncConfig(state: SyncState): MeegleSyncConfig {
  const projectKey = textEnv('FEISHU_PROJECT_KEY', 'rjcloud')
  const fullSync = booleanEnv('FEISHU_SYNC_FULL', false)
  const explicitSince = textEnv('FEISHU_SYNC_SINCE')
  const overlapHours = positiveIntegerEnv('FEISHU_SYNC_OVERLAP_HOURS', 48)
  const lastSuccessfulAt = state.lastSuccessfulSyncAt
    ? Date.parse(state.lastSuccessfulSyncAt)
    : Number.NaN
  const sinceFromState = Number.isFinite(lastSuccessfulAt)
    ? new Date(lastSuccessfulAt - overlapHours * 3_600_000).toISOString().slice(0, 10)
    : undefined
  const since = fullSync
    ? undefined
    : explicitSince || sinceFromState

  return {
    command: textEnv('MEEGLE_BIN', 'meegle'),
    host: textEnv('MEEGLE_HOST', textEnv('FEISHU_PROJECT_BASE_URL', 'project.feishu.cn')),
    projectKey,
    requirementTypeKey: textEnv('FEISHU_REQUIREMENT_TYPE_KEY', 'story'),
    defectTypeKey: textEnv('FEISHU_DEFECT_TYPE_KEY', 'issue'),
    defaultOwner: textEnv('FEISHU_DEFAULT_OWNER', '飞书同步'),
    since,
    fetchDescriptions: booleanEnv('FEISHU_SYNC_FETCH_DESCRIPTIONS', true),
  }
}

function platformBaseUrl(): string {
  return textEnv('PLATFORM_BASE_URL', 'http://127.0.0.1:8787').replace(/\/$/, '')
}

function snapshotFilePath(): string {
  return resolve(
    process.cwd(),
    textEnv('FEISHU_SNAPSHOT_PATH', 'data/feishu-work-items.json'),
  )
}

function snapshotOnly(): boolean {
  return process.argv.includes('--snapshot-only') || booleanEnv('FEISHU_SNAPSHOT_ONLY', false)
}

function platformHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const token = textEnv('PLATFORM_SYNC_TOKEN')
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

function statePath(): string {
  return resolve(process.cwd(), textEnv('FEISHU_SYNC_STATE_PATH', 'data/meegle-sync-state.json'))
}

function loadState(): SyncState {
  const path = statePath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SyncState
  } catch {
    return {}
  }
}

function saveState(state: SyncState): void {
  const path = statePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

async function responseMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  if (!text) return `HTTP ${response.status}`
  try {
    const payload = JSON.parse(text) as {
      error?: { message?: string; code?: string }
      message?: string
    }
    return payload.error?.message ?? payload.message ?? text
  } catch {
    return text
  }
}

async function resolveRepoId(): Promise<string> {
  const configured = textEnv('FEISHU_DEFAULT_REPO_ID')
  if (configured) return configured

  const response = await fetch(`${platformBaseUrl()}/api/repositories`, {
    headers: platformHeaders(),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`读取平台仓库失败：${await responseMessage(response)}`)
  }
  const repositories = (await response.json()) as Array<{ id?: unknown }>
  const repoId = repositories.find((repository) => typeof repository.id === 'string')?.id
  if (typeof repoId !== 'string' || !repoId) {
    throw new Error('平台尚未配置代码仓库，请先在页面创建仓库或设置 FEISHU_DEFAULT_REPO_ID')
  }
  return repoId
}

async function postBatch(
  projectKey: string,
  repoId: string,
  items: SyncedFeishuWorkItem[],
): Promise<PlatformIngestResult> {
  const url = `${platformBaseUrl()}/api/integrations/feishu/ingest`
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { ...platformHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ projectKey, repoId, items }),
        signal: AbortSignal.timeout(60_000),
      })
      if (response.ok) return (await response.json()) as PlatformIngestResult

      const message = await responseMessage(response)
      if (response.status < 500 || attempt === 3) {
        throw new Error(`写入平台失败（HTTP ${response.status}）：${message}`)
      }
      lastError = new Error(message)
    } catch (error) {
      lastError = error
      if (attempt === 3) break
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 1_500))
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function runOnce(): Promise<SyncSummary> {
  const state = loadState()
  const config = syncConfig(state)
  await assertMeegleAuthenticated(config)
  const fetched = await fetchMeegleWorkItems(config)
  const syncedAt = new Date().toISOString()
  const snapshotFile = snapshotFilePath()
  writeFeishuSnapshot(
    snapshotFile,
    buildFeishuSnapshot(config.projectKey, fetched.items, syncedAt),
  )

  const repoId =
    !snapshotOnly() && fetched.items.length > 0 ? await resolveRepoId() : undefined
  let created = 0
  let updated = 0
  let skipped = 0

  if (repoId) {
    for (const batch of chunks(fetched.items, 200)) {
      const result = await postBatch(config.projectKey, repoId, batch)
      created += result.created
      updated += result.updated
      skipped += result.skipped
    }
  }

  saveState({
    lastSuccessfulSyncAt: syncedAt,
    projectKey: config.projectKey,
    fetched: fetched.fetched,
    created,
    updated,
  })
  return {
    projectKey: config.projectKey,
    fetched: fetched.fetched,
    created,
    updated,
    skipped: fetched.skipped + skipped,
    warnings: fetched.warnings,
    syncedAt,
    snapshotFile,
  }
}

async function main(): Promise<void> {
  const watch = process.argv.includes('--watch')
  const interval = positiveIntegerEnv('FEISHU_SYNC_INTERVAL_MS', 300_000)
  do {
    try {
      const summary = await runOnce()
      console.log(JSON.stringify(summary, null, 2))
    } catch (error) {
      console.error(
        JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
            code: (error as { code?: string }).code,
            syncedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      )
      if (!watch) process.exitCode = 1
    }
    if (!watch) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, interval))
  } while (true)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
