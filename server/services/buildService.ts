import type { AppDatabase } from '../db/database.js'
import { notFound, unprocessable } from '../domain/errors.js'
import { requiredText } from '../domain/validation.js'
import type { CredentialVault } from '../security/vault.js'
import { getAccountSecret, listAccounts } from './accountService.js'
import {
  normalizeJenkinsJobUrl,
  readJenkinsJob,
  triggerJenkinsJob,
  type BuildJobInfo,
  type BuildTriggerResult,
  type JenkinsBuildSpec,
} from './jenkinsService.js'

export type {
  BuildJobInfo,
  BuildJobParameter,
  BuildTriggerResult,
  JenkinsBuildSpec,
} from './jenkinsService.js'

export interface BuildAgentCommandRequest {
  accountId: string
  parameters?: Record<string, string>
}

export interface BuildAgentCommandPayload extends BuildAgentCommandRequest {
  spec: JenkinsBuildSpec
}

function buildParameters(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw unprocessable('编译参数格式不正确')
  }
  const entries = Object.entries(value)
  if (entries.length > 200) throw unprocessable('编译参数数量不能超过 200 个')
  const parameters: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(key)) throw unprocessable(`编译参数 ${key} 名称不合法`)
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      throw unprocessable(`编译参数 ${key} 必须是字符串、数字或布尔值`)
    }
    const text = String(raw)
    if (text.length > 4_000) throw unprocessable(`编译参数 ${key} 长度不能超过 4000 个字符`)
    parameters[key] = text
  }
  return parameters
}

export function parseBuildAgentCommandRequest(value: unknown): BuildAgentCommandRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw unprocessable('编译命令参数格式不正确')
  }
  const record = value as Record<string, unknown>
  const parameters = buildParameters(record.parameters)
  return {
    accountId: requiredText(record.accountId, '编译账号', { max: 200 }),
    ...(parameters ? { parameters } : {}),
  }
}

export function buildAgentCommandPayload(
  db: AppDatabase,
  vault: CredentialVault,
  request: BuildAgentCommandRequest,
): BuildAgentCommandPayload {
  return {
    ...request,
    spec: buildExecutionSpec(db, vault, request.accountId),
  }
}

export function buildExecutionSpec(
  db: AppDatabase,
  vault: CredentialVault,
  accountId: string,
): JenkinsBuildSpec {
  const account = listAccounts(db).find((item) => item.id === accountId)
  if (!account) throw notFound('编译账号')
  if (account.platform !== 'build') {
    throw unprocessable('仅编译系统账号支持内部编译')
  }
  if (!account.serviceUrl) {
    throw unprocessable('编译账号尚未配置 Jenkins 任务服务地址')
  }
  const jobUrl = normalizeJenkinsJobUrl(account.serviceUrl)
  return {
    accountId: account.id,
    jobUrl: jobUrl.toString(),
    username: account.username,
    secret: getAccountSecret(db, vault, account.id),
  }
}

export async function getBuildJob(
  db: AppDatabase,
  vault: CredentialVault,
  accountId: string,
): Promise<BuildJobInfo> {
  return readJenkinsJob(buildExecutionSpec(db, vault, accountId))
}

export async function triggerBuild(
  db: AppDatabase,
  vault: CredentialVault,
  accountId: string,
  input: unknown,
): Promise<BuildTriggerResult> {
  return triggerJenkinsJob(buildExecutionSpec(db, vault, accountId), input)
}
