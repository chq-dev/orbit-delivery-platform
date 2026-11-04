import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const DELIVERY_CODEX_PHASES = ['analysis', 'ldd', 'coding'] as const

export type DeliveryCodexPhase = (typeof DELIVERY_CODEX_PHASES)[number]

const DELIVERY_ARTIFACT_PREFIX = 'delivery-artifacts/'

export function parseDeliveryCodexPhase(value: unknown): DeliveryCodexPhase | undefined {
  if (typeof value !== 'string') return undefined
  const phase = value.trim().toLowerCase()
  return DELIVERY_CODEX_PHASES.find((entry) => entry === phase)
}

export function deliveryCodexPhaseIndex(phase: DeliveryCodexPhase): number {
  return DELIVERY_CODEX_PHASES.indexOf(phase)
}

export function nextDeliveryCodexPhase(
  current: DeliveryCodexPhase | undefined,
  detected: DeliveryCodexPhase | undefined,
): DeliveryCodexPhase | undefined {
  if (!detected) return undefined
  if (!current) return detected
  return deliveryCodexPhaseIndex(detected) > deliveryCodexPhaseIndex(current)
    ? detected
    : undefined
}

export function deliveryPhaseMarkerPath(checkout: string, workItemId: string): string {
  return join(checkout, 'delivery-artifacts', workItemId, '.phase-current')
}

export function readDeliveryCodexPhaseMarker(
  checkout: string,
  workItemId: string,
): DeliveryCodexPhase | undefined {
  try {
    const path = deliveryPhaseMarkerPath(checkout, workItemId)
    if (!existsSync(path) || !statSync(path).isFile()) return undefined
    return parseDeliveryCodexPhase(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

export function resetDeliveryCodexPhaseMarker(checkout: string, workItemId: string): void {
  try {
    rmSync(deliveryPhaseMarkerPath(checkout, workItemId), { force: true })
  } catch {
    // A stale marker must not block delivery; the agent will also infer from workspace changes.
  }
}

export function deliveryDesignReportExists(checkout: string, workItemId: string): boolean {
  try {
    const path = join(checkout, 'delivery-artifacts', workItemId, 'design-report.md')
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0
  } catch {
    return false
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

function isLddPath(path: string): boolean {
  return /(^|\/)(?:docs\/ldd|ldd)\//i.test(path) || /ldd\.md$/i.test(path)
}

function isSourcePath(path: string): boolean {
  return Boolean(path) && !/\.md$/i.test(path)
}

export function inferDeliveryCodexPhase(
  files: string[],
  options: { designReport?: boolean } = {},
): DeliveryCodexPhase | undefined {
  const relevant = files
    .map(normalizePath)
    .filter((path) => path && !path.startsWith(DELIVERY_ARTIFACT_PREFIX))
  if (relevant.some(isSourcePath)) return 'coding'
  if (relevant.some(isLddPath)) return 'ldd'
  if (options.designReport) return 'ldd'
  return undefined
}

export function parseGitStatusPaths(output: string): string[] {
  const tokens = output.split('\0')
  const paths: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index]
    if (!entry || entry.length < 4) continue
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (path) paths.push(path)
    if (status.includes('R') || status.includes('C')) {
      const originalPath = tokens[index + 1]
      if (originalPath) {
        paths.push(originalPath)
        index += 1
      }
    }
  }
  return paths
}
