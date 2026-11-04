import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import type { AppDatabase } from '../db/database.js'
import { AppError, notFound, unprocessable } from '../domain/errors.js'
import { describeFetchError } from '../domain/network.js'
import { nowIso } from '../domain/time.js'
import type { Account } from '../domain/types.js'
import type { CredentialVault } from '../security/vault.js'
import { getAccountSecret, listAccounts } from './accountService.js'

interface JenkinsParameterDefinition {
  name?: string
  type?: string
  description?: string
  choices?: string[]
  defaultParameterValue?: { value?: unknown }
}

interface JenkinsJobResponse {
  name?: string
  url?: string
  buildable?: boolean
  property?: Array<{ parameterDefinitions?: JenkinsParameterDefinition[] }>
}

export interface BuildJobParameter {
  name: string
  type: string
  description?: string
  choices?: string[]
  defaultValue: string
}

export interface BuildJobInfo {
  accountId: string
  name: string
  jobUrl: string
  buildable: boolean
  parameters: BuildJobParameter[]
}

export interface BuildTriggerResult {
  ok: true
  accountId: string
  jobName: string
  jobUrl: string
  queueUrl?: string
  triggeredAt: string
  parameters: string[]
}

interface BuildCredentials {
  account: Account
  authorization: string
  jobUrl: URL
}

let proxyDispatcherCache: { proxyUrl: string; dispatcher: Dispatcher } | undefined

function configuredProxyUrl(): string {
  return process.env.BUILD_PROXY_URL?.trim() ?? ''
}

function proxyDispatcher(proxyUrl: string): Dispatcher {
  if (proxyDispatcherCache?.proxyUrl === proxyUrl) return proxyDispatcherCache.dispatcher
  try {
    const dispatcher = new ProxyAgent(proxyUrl)
    proxyDispatcherCache = { proxyUrl, dispatcher }
    return dispatcher
  } catch (error) {
    throw new AppError(
      500,
      'BUILD_PROXY_INVALID',
      `BUILD_PROXY_URL 配置无效：${describeFetchError(error)}`,
    )
  }
}

function valueAsString(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function buildCredentials(
  db: AppDatabase,
  vault: CredentialVault,
  accountId: string,
): BuildCredentials {
  const account = listAccounts(db).find((item) => item.id === accountId)
  if (!account) throw notFound('编译账号')
  if (account.platform !== 'build') {
    throw unprocessable('仅编译系统账号支持内部编译')
  }
  if (!account.serviceUrl) {
    throw unprocessable('编译账号尚未配置 Jenkins 任务服务地址')
  }

  let parsed: URL
  try {
    parsed = new URL(account.serviceUrl)
  } catch {
    throw unprocessable('编译账号服务地址不是合法的 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw unprocessable('编译账号服务地址仅支持 http/https 协议')
  }

  const jobIndex = parsed.pathname.indexOf('/job/')
  if (jobIndex < 0) {
    throw unprocessable('服务地址必须指向 Jenkins 任务页面（路径包含 /job/）')
  }
  const jobPath = `${parsed.pathname.slice(jobIndex).replace(/\/+$/, '')}/`
  const jobUrl = new URL(jobPath, parsed.origin)
  const secret = getAccountSecret(db, vault, account.id)

  return {
    account,
    authorization: `Basic ${Buffer.from(`${account.username}:${secret}`).toString('base64')}`,
    jobUrl,
  }
}

async function jenkinsFetch(
  credentials: BuildCredentials,
  url: URL,
  init: RequestInit = {},
): Promise<Response> {
  const proxyUrl = configuredProxyUrl()
  try {
    const options = {
      ...init,
      redirect: 'manual' as const,
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: credentials.authorization,
        accept: 'application/json',
        ...init.headers,
      },
    }
    if (proxyUrl) {
      const fetchViaProxy = undiciFetch as unknown as (
        input: URL,
        init: Record<string, unknown>,
      ) => Promise<Response>
      return await fetchViaProxy(url, {
        ...options,
        dispatcher: proxyDispatcher(proxyUrl),
      })
    }
    return await fetch(url, options)
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(
      502,
      'BUILD_SYSTEM_UNREACHABLE',
      `无法连接编译系统 ${url.origin}：${describeFetchError(error)}。请确认平台服务端可访问该地址；如仅能通过代理访问，请配置 BUILD_PROXY_URL`,
    )
  }
}

function assertJenkinsReadable(response: Response, action: string): void {
  if (response.status === 401 || response.status === 403 || response.status === 302) {
    throw new AppError(
      502,
      'BUILD_AUTH_FAILED',
      '编译系统认证失败，请检查账号密码或 Access Token 权限',
    )
  }
  if (response.status === 404) {
    throw new AppError(502, 'BUILD_JOB_NOT_FOUND', '未找到 Jenkins 任务，请检查服务地址')
  }
  if (!response.ok) {
    throw new AppError(
      502,
      'BUILD_SYSTEM_ERROR',
      `编译系统${action}失败（HTTP ${response.status}）`,
    )
  }
}

function parameterDefinitions(response: JenkinsJobResponse): BuildJobParameter[] {
  return (response.property ?? [])
    .flatMap((property) => property.parameterDefinitions ?? [])
    .filter((parameter): parameter is JenkinsParameterDefinition & { name: string } =>
      Boolean(parameter.name),
    )
    .map((parameter) => ({
      name: parameter.name,
      type: parameter.type ?? 'StringParameterDefinition',
      ...(parameter.description ? { description: parameter.description } : {}),
      ...(parameter.choices ? { choices: parameter.choices } : {}),
      defaultValue: valueAsString(parameter.defaultParameterValue?.value),
    }))
}

async function readBuildJob(credentials: BuildCredentials): Promise<BuildJobInfo> {
  const apiUrl = new URL('api/json', credentials.jobUrl)
  apiUrl.searchParams.set(
    'tree',
    'name,url,buildable,property[parameterDefinitions[name,type,description,choices,defaultParameterValue[value]]]',
  )
  const response = await jenkinsFetch(credentials, apiUrl)
  assertJenkinsReadable(response, '读取任务')

  let body: JenkinsJobResponse
  try {
    body = (await response.json()) as JenkinsJobResponse
  } catch {
    throw new AppError(502, 'BUILD_RESPONSE_INVALID', '编译系统返回了无法解析的任务信息')
  }

  const fallbackName = decodeURIComponent(
    credentials.jobUrl.pathname.replace(/\/+$/, '').split('/').pop() ?? 'Jenkins Job',
  )
  return {
    accountId: credentials.account.id,
    name: body.name ?? fallbackName,
    jobUrl: body.url ?? credentials.jobUrl.toString(),
    buildable: body.buildable !== false,
    parameters: parameterDefinitions(body),
  }
}

function resolvedParameters(
  parameters: BuildJobParameter[],
  input: unknown,
): Record<string, string> {
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
    throw unprocessable('编译参数格式不正确')
  }
  const provided = (input ?? {}) as Record<string, unknown>
  const allowed = new Set(parameters.map((parameter) => parameter.name))
  for (const name of Object.keys(provided)) {
    if (!allowed.has(name)) throw unprocessable(`编译参数 ${name} 不存在`)
  }

  const values: Record<string, string> = {}
  for (const parameter of parameters) {
    const raw = Object.prototype.hasOwnProperty.call(provided, parameter.name)
      ? provided[parameter.name]
      : parameter.defaultValue
    const value = valueAsString(raw)
    if (parameter.choices?.length && !parameter.choices.includes(value)) {
      throw unprocessable(
        `编译参数 ${parameter.name} 必须是以下值之一：${parameter.choices.join('、')}`,
      )
    }
    if (parameter.type === 'BooleanParameterDefinition' && value !== 'true' && value !== 'false') {
      throw unprocessable(`编译参数 ${parameter.name} 必须是 true 或 false`)
    }
    values[parameter.name] = value
  }
  return values
}

async function crumbHeaders(credentials: BuildCredentials): Promise<Record<string, string>> {
  const crumbUrl = new URL('/crumbIssuer/api/json', credentials.jobUrl.origin)
  const response = await jenkinsFetch(credentials, crumbUrl)
  if (response.status === 404) return {}
  assertJenkinsReadable(response, '获取 CSRF Token')
  const body = (await response.json()) as { crumb?: string; crumbRequestField?: string }
  if (!body.crumb || !body.crumbRequestField) return {}
  return { [body.crumbRequestField]: body.crumb }
}

export async function getBuildJob(
  db: AppDatabase,
  vault: CredentialVault,
  accountId: string,
): Promise<BuildJobInfo> {
  return readBuildJob(buildCredentials(db, vault, accountId))
}

export async function triggerBuild(
  db: AppDatabase,
  vault: CredentialVault,
  accountId: string,
  input: unknown,
): Promise<BuildTriggerResult> {
  const credentials = buildCredentials(db, vault, accountId)
  const job = await readBuildJob(credentials)
  if (!job.buildable) throw new AppError(409, 'BUILD_DISABLED', 'Jenkins 任务当前不可构建')

  const values = resolvedParameters(job.parameters, input)
  const target = new URL(
    job.parameters.length > 0 ? 'buildWithParameters' : 'build',
    credentials.jobUrl,
  )
  const body = new URLSearchParams(values).toString()
  const headers = await crumbHeaders(credentials)
  const response = await jenkinsFetch(credentials, target, {
    method: 'POST',
    headers: {
      ...headers,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body } : {}),
  })

  if (response.status === 401 || response.status === 403) {
    throw new AppError(
      502,
      'BUILD_AUTH_FAILED',
      '编译系统认证失败，请检查账号密码或 Access Token 权限',
    )
  }
  if (response.status === 404) {
    throw new AppError(502, 'BUILD_JOB_NOT_FOUND', '未找到 Jenkins 任务，请检查服务地址')
  }
  if (response.status === 400) {
    throw new AppError(502, 'BUILD_PARAMETERS_REJECTED', 'Jenkins 拒绝了本次编译参数')
  }
  if (response.status >= 400) {
    throw new AppError(
      502,
      'BUILD_TRIGGER_FAILED',
      `触发编译失败（HTTP ${response.status}）`,
    )
  }

  const location = response.headers.get('location')
  return {
    ok: true,
    accountId,
    jobName: job.name,
    jobUrl: job.jobUrl,
    ...(location ? { queueUrl: new URL(location, credentials.jobUrl).toString() } : {}),
    triggeredAt: nowIso(),
    parameters: job.parameters.map((parameter) => parameter.name),
  }
}
