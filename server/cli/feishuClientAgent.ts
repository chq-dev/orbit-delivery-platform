import 'dotenv/config'
import { execFile } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import {
  parseFeishuAgentConfig,
  publicFeishuAgentConfig,
  validateFeishuAgentConfig,
  type FeishuAgentStoredConfig,
} from '../services/feishuAgentConfig.js'

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface LoginChallenge {
  verificationUri: string
  verificationUriComplete: string
  userCode: string
  expiresAt: number
}

interface PendingLogin extends LoginChallenge {
  clientId: string
  deviceCode: string
}

interface LastRun {
  at: string
  status: 'success' | 'failed'
  summary?: unknown
  error?: string
}

interface AgentSyncResult {
  fetched: number
  upserted: number
  archived: number
  skipped: number
  message: string
  syncedAt: string
}

const agentHost = process.env.FEISHU_AGENT_HOST?.trim() || '127.0.0.1'
const agentPort = positiveInteger(process.env.FEISHU_AGENT_PORT, 18_787)
const meegleCommand = process.env.MEEGLE_BIN?.trim() || 'meegle'
const meegleHost = process.env.MEEGLE_HOST?.trim() || 'project.feishu.cn'
const npmCommand = process.env.NPM_BIN?.trim() || 'npm'
const workspaceRoot = process.cwd()
const configPath = resolve(
  process.env.FEISHU_AGENT_CONFIG_PATH?.trim() ||
    resolve(homedir(), '.config', 'orbit', 'feishu-sync.json'),
)
const allowedOrigins = new Set(
  (
    process.env.FEISHU_AGENT_ALLOWED_ORIGINS ||
    [
      'http://8.145.45.84:8787',
      'http://localhost:4173',
      'http://127.0.0.1:4173',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ].join(',')
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
)

let pendingLogin: PendingLogin | null = null
let running = false
let lastRun: LastRun | null = null

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseJson(textValue: string): unknown {
  const trimmed = textValue.trim()
  if (!trimmed) return undefined
  const candidates = [trimmed]
  for (let index = trimmed.indexOf('{'); index >= 0; index = trimmed.indexOf('{', index + 1)) {
    candidates.push(trimmed.slice(index))
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(candidates[index])
    } catch {
      // Command output may contain progress lines before the JSON document.
    }
  }
  return undefined
}

function readConfig(): FeishuAgentStoredConfig | null {
  if (!existsSync(configPath)) return null
  try {
    return parseFeishuAgentConfig(JSON.parse(readFileSync(configPath, 'utf8')))
  } catch {
    return null
  }
}

function writeConfig(config: FeishuAgentStoredConfig): void {
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(configPath, 0o600)
  } catch {
    // Best-effort protection on platforms without POSIX permissions.
  }
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = 60_000,
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      {
        cwd: workspaceRoot,
        env,
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code
        resolvePromise({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode: typeof code === 'number' ? code : code ? 1 : 0,
        })
      },
    )
  })
}

async function authStatus(): Promise<{
  available: boolean
  authenticated: boolean
  reason?: string
  host?: string
}> {
  const result = await runCommand(
    meegleCommand,
    ['auth', 'status', '--format', 'json'],
    process.env,
    20_000,
  )
  const payload = parseJson(result.stdout) ?? parseJson(result.stderr)
  if (isRecord(payload)) {
    return {
      available: true,
      authenticated: result.exitCode === 0 && payload.authenticated === true,
      reason: text(payload.reason) || undefined,
      host: text(payload.host) || undefined,
    }
  }
  return {
    available: result.exitCode === 0,
    authenticated: false,
    reason: result.stderr.trim() || '无法读取 Meegle 登录状态',
  }
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
}

function summaryFromOutput(stdout: string): AgentSyncResult | undefined {
  const payload = parseJson(stdout)
  if (!isRecord(payload) || typeof payload.projectKey !== 'string') return undefined
  const created = nonNegativeInteger(payload.created)
  const updated = nonNegativeInteger(payload.updated)
  const fetched = nonNegativeInteger(payload.fetched) || created + updated
  const archived = nonNegativeInteger(payload.archived)
  const skipped = nonNegativeInteger(payload.skipped)
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.map(text).filter(Boolean)
    : []
  return {
    fetched,
    upserted: created + updated,
    archived,
    skipped,
    message: `已从飞书同步 ${fetched} 条工作项，新增 ${created} 条、更新 ${updated} 条${
      archived > 0 ? `、归档 ${archived} 条` : ''
    }${warnings.length > 0 ? `；${warnings.join('；')}` : ''}`,
    syncedAt: text(payload.syncedAt) || new Date().toISOString(),
  }
}

async function runSync(): Promise<AgentSyncResult> {
  if (running) throw new Error('同步正在执行，请稍后')
  const config = readConfig()
  if (!config) throw new Error('本机同步代理尚未绑定平台同步密钥')
  const auth = await authStatus()
  if (!auth.available) throw new Error('本机未安装可用的 Meegle CLI')
  if (!auth.authenticated) throw new Error('Meegle 尚未登录，请先完成飞书设备授权')

  running = true
  try {
    const result = await runCommand(
      npmCommand,
      ['run', 'sync:feishu'],
      {
        ...process.env,
        PLATFORM_BASE_URL: config.platformBaseUrl,
        PLATFORM_SYNC_TOKEN: config.syncToken,
        FEISHU_PROJECT_KEY: config.projectKey,
        FEISHU_SYNC_FULL: 'true',
        ...(config.repoId ? { FEISHU_DEFAULT_REPO_ID: config.repoId } : {}),
      },
      15 * 60_000,
    )
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || '飞书同步失败'
      lastRun = { at: new Date().toISOString(), status: 'failed', error: message }
      throw new Error(message)
    }
    const summary = summaryFromOutput(result.stdout) ?? {
      fetched: 0,
      upserted: 0,
      archived: 0,
      skipped: 0,
      message: '飞书同步完成',
      syncedAt: new Date().toISOString(),
    }
    lastRun = { at: new Date().toISOString(), status: 'success', summary }
    return summary
  } finally {
    running = false
  }
}

async function responseMessage(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  if (!body) return `HTTP ${response.status}`
  try {
    const payload = JSON.parse(body) as {
      error?: { message?: string }
      message?: string
    }
    return payload.error?.message || payload.message || body
  } catch {
    return body
  }
}

async function rotateToken(): Promise<unknown> {
  const config = readConfig()
  if (!config) throw new Error('本机同步代理尚未绑定平台同步密钥')
  const response = await fetch(
    `${config.platformBaseUrl}/api/integrations/feishu/sync-token/rotate`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.syncToken}`,
      },
      signal: AbortSignal.timeout(30_000),
    },
  )
  if (!response.ok) {
    throw new Error(`轮换平台同步密钥失败：${await responseMessage(response)}`)
  }
  const payload = (await response.json()) as { token?: unknown; status?: unknown }
  const token = text(payload.token)
  if (!token) throw new Error('平台未返回新的同步密钥')
  writeConfig({ ...config, syncToken: token })
  return payload.status ?? { configured: true, source: 'database' }
}

async function startLogin(): Promise<LoginChallenge> {
  const result = await runCommand(
    meegleCommand,
    [
      'auth',
      'login',
      '--device-code',
      '--host',
      meegleHost,
      '--phase',
      'init',
      '--format',
      'json',
    ],
    process.env,
    30_000,
  )
  const payload = parseJson(result.stdout) ?? parseJson(result.stderr)
  if (result.exitCode !== 0 || !isRecord(payload)) {
    throw new Error(result.stderr.trim() || '无法发起飞书设备授权')
  }
  const clientId = text(payload.client_id)
  const deviceCode = text(payload.device_code)
  const userCode = text(payload.user_code)
  const verificationUri = text(payload.verification_uri)
  const verificationUriComplete = text(payload.verification_uri_complete) || verificationUri
  const expiresIn = Number(payload.expires_in) || 600
  if (!clientId || !deviceCode || !userCode || !verificationUriComplete) {
    throw new Error('飞书设备授权响应不完整')
  }
  pendingLogin = {
    clientId,
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresAt: Date.now() + expiresIn * 1000,
  }
  return {
    verificationUri,
    verificationUriComplete,
    userCode,
    expiresAt: pendingLogin.expiresAt,
  }
}

async function pollLogin(): Promise<{ authenticated: boolean; message?: string }> {
  if (!pendingLogin) throw new Error('没有待完成的飞书授权')
  if (Date.now() > pendingLogin.expiresAt) {
    pendingLogin = null
    throw new Error('飞书授权已过期，请重新发起')
  }
  const result = await runCommand(
    meegleCommand,
    [
      'auth',
      'login',
      '--device-code',
      '--host',
      meegleHost,
      '--phase',
      'poll',
      '--client-id',
      pendingLogin.clientId,
      '--device-code-value',
      pendingLogin.deviceCode,
      '--once',
      '--format',
      'json',
    ],
    process.env,
    30_000,
  )
  const payload = parseJson(result.stdout) ?? parseJson(result.stderr)
  const authenticated =
    result.exitCode === 0 && isRecord(payload) && payload.authenticated === true
  if (authenticated) {
    pendingLogin = null
    return { authenticated: true, message: '飞书授权完成' }
  }
  const message = isRecord(payload)
    ? text(payload.error_description) || text(payload.message) || text(payload.reason)
    : ''
  return {
    authenticated: false,
    message: message || '等待浏览器完成授权',
  }
}

function corsOrigin(request: IncomingMessage): string | undefined {
  const origin = text(request.headers.origin)
  return origin && allowedOrigins.has(origin) ? origin : undefined
}

function setCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = corsOrigin(request)
  if (text(request.headers.origin) && !origin) return false
  if (origin) response.setHeader('access-control-allow-origin', origin)
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
  response.setHeader('access-control-allow-headers', 'content-type')
  response.setHeader('access-control-allow-private-network', 'true')
  response.setHeader('vary', 'origin')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  return true
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(`${JSON.stringify(payload)}\n`)
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 64 * 1024) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!isRecord(payload)) throw new Error('请求体必须是 JSON 对象')
  return payload
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!setCors(request, response)) {
    sendJson(response, 403, { error: 'origin_not_allowed' })
    return
  }
  if (request.method === 'OPTIONS') {
    response.statusCode = 204
    response.end()
    return
  }
  const path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname
  if (request.method === 'GET' && (path === '/health' || path === '/status')) {
    const config = readConfig()
    const auth = await authStatus()
    sendJson(response, 200, {
      ok: true,
      version: 2,
      config: publicFeishuAgentConfig(config),
      meegle: auth,
      running,
      lastRun,
      pendingLogin: pendingLogin
        ? {
            userCode: pendingLogin.userCode,
            verificationUriComplete: pendingLogin.verificationUriComplete,
            expiresAt: pendingLogin.expiresAt,
          }
        : null,
    })
    return
  }
  if (request.method === 'POST' && path === '/configure') {
    const config = validateFeishuAgentConfig(await readBody(request))
    writeConfig(config)
    sendJson(response, 200, { ok: true, config: publicFeishuAgentConfig(config) })
    return
  }
  if (request.method === 'POST' && path === '/login/start') {
    sendJson(response, 200, { ok: true, challenge: await startLogin() })
    return
  }
  if (request.method === 'POST' && path === '/login/poll') {
    sendJson(response, 200, { ok: true, ...(await pollLogin()) })
    return
  }
  if (request.method === 'POST' && path === '/sync') {
    sendJson(response, 200, { ok: true, summary: await runSync() })
    return
  }
  if (request.method === 'POST' && path === '/rotate-token') {
    sendJson(response, 200, { ok: true, status: await rotateToken() })
    return
  }
  sendJson(response, 404, { error: 'not_found' })
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(response, 400, { ok: false, error: message })
  })
})

server.listen(agentPort, agentHost, () => {
  console.log(`Orbit 飞书同步代理已启动：http://${agentHost}:${agentPort}`)
  console.log(`配置路径：${configPath}`)
  console.log(`允许的页面来源：${[...allowedOrigins].join(', ')}`)
})

function shutdown(): void {
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
