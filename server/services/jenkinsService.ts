import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { AppError, unprocessable } from '../domain/errors.js'
import { describeFetchError } from '../domain/network.js'
import { nowIso } from '../domain/time.js'

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

export interface JenkinsBuildSpec {
  accountId: string
  jobUrl: string
  username: string
  secret: string
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

function authorization(spec: JenkinsBuildSpec): string {
  return `Basic ${Buffer.from(`${spec.username}:${spec.secret}`).toString('base64')}`
}

export function normalizeJenkinsJobUrl(serviceUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(serviceUrl)
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
  return new URL(jobPath, parsed.origin)
}

function valueAsString(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

async function jenkinsFetch(
  spec: JenkinsBuildSpec,
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
        authorization: authorization(spec),
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
      `无法连接编译系统 ${url.origin}：${describeFetchError(error)}。请确认执行编译的机器可访问该地址；如仅能通过代理访问，请配置 BUILD_PROXY_URL`,
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

function responseCookies(response: Response): string | undefined {
  const header = response.headers as Headers & { getSetCookie?: () => string[] }
  const cookies = header.getSetCookie?.() ?? []
  const pairs = cookies
    .map((cookie) => cookie.split(';', 1)[0]?.trim() ?? '')
    .filter(Boolean)
  return pairs.length > 0 ? pairs.join('; ') : undefined
}

async function crumbCredentials(
  spec: JenkinsBuildSpec,
): Promise<{ headers: Record<string, string>; cookie?: string }> {
  const crumbUrl = new URL('/crumbIssuer/api/json', spec.jobUrl)
  const response = await jenkinsFetch(spec, crumbUrl)
  if (response.status === 404) return { headers: {} }
  const cookie = responseCookies(response)
  assertJenkinsReadable(response, '获取 CSRF Token')
  const body = (await response.json()) as { crumb?: string; crumbRequestField?: string }
  if (!body.crumb || !body.crumbRequestField) return { headers: {}, ...(cookie ? { cookie } : {}) }
  return {
    headers: { [body.crumbRequestField]: body.crumb },
    ...(cookie ? { cookie } : {}),
  }
}

export async function readJenkinsJob(spec: JenkinsBuildSpec): Promise<BuildJobInfo> {
  const jobUrl = new URL(spec.jobUrl)
  const apiUrl = new URL('api/json', jobUrl)
  apiUrl.searchParams.set(
    'tree',
    'name,url,buildable,property[parameterDefinitions[name,type,description,choices,defaultParameterValue[value]]]',
  )
  const response = await jenkinsFetch(spec, apiUrl)
  assertJenkinsReadable(response, '读取任务')

  let body: JenkinsJobResponse
  try {
    body = (await response.json()) as JenkinsJobResponse
  } catch {
    throw new AppError(502, 'BUILD_RESPONSE_INVALID', '编译系统返回了无法解析的任务信息')
  }

  const fallbackName = decodeURIComponent(
    jobUrl.pathname.replace(/\/+$/, '').split('/').pop() ?? 'Jenkins Job',
  )
  return {
    accountId: spec.accountId,
    name: body.name ?? fallbackName,
    jobUrl: body.url ?? jobUrl.toString(),
    buildable: body.buildable !== false,
    parameters: parameterDefinitions(body),
  }
}

export async function triggerJenkinsJob(
  spec: JenkinsBuildSpec,
  input: unknown,
): Promise<BuildTriggerResult> {
  const jobUrl = new URL(spec.jobUrl)
  const job = await readJenkinsJob(spec)
  if (!job.buildable) throw new AppError(409, 'BUILD_DISABLED', 'Jenkins 任务当前不可构建')

  const values = resolvedParameters(job.parameters, input)
  const target = new URL(
    job.parameters.length > 0 ? 'buildWithParameters' : 'build',
    jobUrl,
  )
  const body = new URLSearchParams(values).toString()
  const crumb = await crumbCredentials(spec)
  const response = await jenkinsFetch(spec, target, {
    method: 'POST',
    headers: {
      ...crumb.headers,
      ...(crumb.cookie ? { cookie: crumb.cookie } : {}),
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
    accountId: spec.accountId,
    jobName: job.name,
    jobUrl: job.jobUrl,
    ...(location ? { queueUrl: new URL(location, jobUrl).toString() } : {}),
    triggeredAt: nowIso(),
    parameters: job.parameters.map((parameter) => parameter.name),
  }
}
