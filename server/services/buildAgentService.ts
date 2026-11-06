import type { AppDatabase } from '../db/database.js'
import { AppError, unprocessable } from '../domain/errors.js'
import type { CredentialVault } from '../security/vault.js'
import {
  enqueueFeishuAgentCommand,
  getFeishuAgentBridgeStatus,
  getFeishuAgentCommand,
  resolveCommandClientId,
} from './feishuAgentBridgeService.js'
import {
  getBuildJob,
  parseBuildAgentCommandRequest,
  triggerBuild,
  type BuildJobInfo,
  type BuildTriggerResult,
} from './buildService.js'

const DEFAULT_BUILD_AGENT_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 250

function timeoutMs(): number {
  const parsed = Number(process.env.BUILD_AGENT_TIMEOUT_MS)
  return Number.isInteger(parsed) && parsed >= 5_000 ? parsed : DEFAULT_BUILD_AGENT_TIMEOUT_MS
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function resolveBuildAgentClientId(
  db: AppDatabase,
  requestedClientId?: unknown,
): string {
  if (requestedClientId !== undefined && requestedClientId !== null && requestedClientId !== '') {
    return resolveCommandClientId(db, requestedClientId)
  }
  const status = getFeishuAgentBridgeStatus(db)
  const online = status.clients.filter((client) => client.online)
  if (online.length === 1) return online[0].clientId
  if (online.length === 0) {
    throw unprocessable(
      '未发现在线执行客户端；请先在能访问 Jenkins 的机器运行 npm run feishu:agent 后重试',
    )
  }
  throw unprocessable('检测到多个在线执行客户端，请先在账号页面选择要执行编译的客户端')
}

async function waitForAgentBuildResult<T>(
  db: AppDatabase,
  commandId: string,
  select: (result: Record<string, unknown>) => T,
): Promise<T> {
  const deadline = Date.now() + timeoutMs()
  while (Date.now() < deadline) {
    const command = getFeishuAgentCommand(db, commandId)
    if (command.status === 'succeeded') {
      if (!isRecord(command.result)) {
        throw new AppError(502, 'BUILD_AGENT_RESPONSE_INVALID', '执行客户端返回的编译结果格式不正确')
      }
      return select(command.result)
    }
    if (command.status === 'failed') {
      throw new AppError(
        502,
        'BUILD_AGENT_FAILED',
        command.error || '执行客户端编译失败，请检查客户端网络与 Jenkins 地址',
      )
    }
    await delay(POLL_INTERVAL_MS)
  }
  throw new AppError(
    504,
    'BUILD_AGENT_TIMEOUT',
    '执行客户端未在超时时间内返回编译结果，请确认客户端代理在线并能访问 Jenkins',
  )
}

function selectJob(result: Record<string, unknown>): BuildJobInfo {
  const job = result.job
  if (
    !isRecord(job) ||
    typeof job.accountId !== 'string' ||
    typeof job.name !== 'string' ||
    typeof job.jobUrl !== 'string' ||
    typeof job.buildable !== 'boolean' ||
    !Array.isArray(job.parameters)
  ) {
    throw new AppError(502, 'BUILD_AGENT_RESPONSE_INVALID', '执行客户端返回的编译任务格式不正确')
  }
  return job as unknown as BuildJobInfo
}

function selectBuild(result: Record<string, unknown>): BuildTriggerResult {
  const build = result.build
  if (
    !isRecord(build) ||
    build.ok !== true ||
    typeof build.accountId !== 'string' ||
    typeof build.jobName !== 'string' ||
    typeof build.jobUrl !== 'string' ||
    typeof build.triggeredAt !== 'string' ||
    !Array.isArray(build.parameters) ||
    (build.queueUrl !== undefined && typeof build.queueUrl !== 'string')
  ) {
    throw new AppError(502, 'BUILD_AGENT_RESPONSE_INVALID', '执行客户端返回的编译触发结果格式不正确')
  }
  return build as unknown as BuildTriggerResult
}

async function runAgentBuild<T>(
  db: AppDatabase,
  type: 'build_job_read' | 'build_trigger',
  accountId: string,
  parameters: unknown,
  requestedClientId: unknown,
  select: (result: Record<string, unknown>) => T,
): Promise<T> {
  const request = parseBuildAgentCommandRequest({ accountId, parameters })
  const clientId = resolveBuildAgentClientId(db, requestedClientId)
  const command = enqueueFeishuAgentCommand(db, type, request, clientId)
  return waitForAgentBuildResult(db, command.id, select)
}

function directUnavailable(error: unknown): boolean {
  return error instanceof AppError && error.code === 'BUILD_SYSTEM_UNREACHABLE'
}

export async function getBuildJobWithFallback(
  db: AppDatabase,
  vault: CredentialVault,
  accountId: string,
  clientId?: unknown,
): Promise<BuildJobInfo> {
  try {
    return await getBuildJob(db, vault, accountId)
  } catch (error) {
    if (!directUnavailable(error)) throw error
    return runAgentBuild(db, 'build_job_read', accountId, undefined, clientId, selectJob)
  }
}

export async function triggerBuildWithFallback(
  db: AppDatabase,
  vault: CredentialVault,
  accountId: string,
  parameters: unknown,
  clientId?: unknown,
): Promise<BuildTriggerResult> {
  try {
    return await triggerBuild(db, vault, accountId, parameters)
  } catch (error) {
    if (!directUnavailable(error)) throw error
    return runAgentBuild(db, 'build_trigger', accountId, parameters, clientId, selectBuild)
  }
}
