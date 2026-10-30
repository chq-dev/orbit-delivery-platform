import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

export interface FeishuMcpRuntimeConfig {
  appId: string
  appSecret: string
  domain: string
  host: string
  port: string
  scope?: string
}

export interface FeishuMcpPublicStatus {
  enabled: boolean
  configured: boolean
  available: boolean
  authenticated: boolean
  transport: 'stdio'
  command?: string
  configPath?: string
  reason?: string
}

export interface FeishuMcpResolution {
  status: FeishuMcpPublicStatus
  source: 'disabled' | 'missing-config' | 'invalid-config' | 'direct' | 'npx'
  command?: string
  args: string[]
  authArgs: string[]
  configPath?: string
  config?: FeishuMcpRuntimeConfig
}

export interface FeishuMcpResolutionOptions {
  env?: NodeJS.ProcessEnv
  home?: string
  cwd?: string
  platform?: NodeJS.Platform
}

export interface FeishuMcpAuthStatus {
  authenticated: boolean
  reason?: string
}

export interface McpExecutableOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  platform?: NodeJS.Platform
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '')
}

function isFalseEnv(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test(value?.trim() ?? '')
}

function executableCandidates(command: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [command]
  return [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveMcpExecutable(
  command: string,
  options: McpExecutableOptions = {},
): string | undefined {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const platform = options.platform ?? process.platform
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return executableCandidates(resolve(command), platform).find(isExecutableFile)
  }
  const directories = [
    join(cwd, 'node_modules', '.bin'),
    ...(env.PATH ?? '').split(delimiter),
  ]
  for (const directory of directories) {
    if (!directory) continue
    for (const candidate of executableCandidates(command, platform)) {
      const executable = resolve(directory, candidate)
      if (isExecutableFile(executable)) return executable
    }
  }
  return undefined
}

function defaultConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return resolve(
    text(env.FEISHU_MCP_CONFIG_PATH) ||
      text(env.LARK_MCP_CONFIG_PATH) ||
      join(home, '.lark-mcp', 'config.json'),
  )
}

function readMcpConfig(configPath: string): FeishuMcpRuntimeConfig {
  const payload = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
  if (!isRecord(payload)) throw new Error('MCP 配置文件必须是 JSON 对象')
  const appId = text(payload.appId)
  const appSecret = text(payload.appSecret)
  if (!appId || !appSecret) throw new Error('MCP 配置缺少 appId 或 appSecret')
  return {
    appId,
    appSecret,
    domain: text(payload.domain) || 'https://open.feishu.cn',
    host: text(payload.host) || 'localhost',
    port: text(payload.port) || '3000',
    scope: text(payload.scope) || undefined,
  }
}

function disabledResolution(reason?: string): FeishuMcpResolution {
  return {
    source: 'disabled',
    args: [],
    authArgs: [],
    status: {
      enabled: false,
      configured: false,
      available: false,
      authenticated: false,
      transport: 'stdio',
      reason,
    },
  }
}

export function resolveFeishuMcpRuntime(
  options: FeishuMcpResolutionOptions = {},
): FeishuMcpResolution {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const cwd = options.cwd ?? process.cwd()
  const platform = options.platform ?? process.platform
  if (isFalseEnv(env.FEISHU_MCP_ENABLED)) {
    return disabledResolution('FEISHU_MCP_ENABLED 已关闭')
  }

  const configPath = defaultConfigPath(env, home)
  if (!existsSync(configPath)) {
    return {
      source: 'missing-config',
      args: [],
      authArgs: [],
      configPath,
      status: {
        enabled: true,
        configured: false,
        available: false,
        authenticated: false,
        transport: 'stdio',
        configPath,
        reason: `未找到飞书 MCP 配置：${configPath}`,
      },
    }
  }

  let config: FeishuMcpRuntimeConfig
  try {
    config = readMcpConfig(configPath)
  } catch (error) {
    return {
      source: 'invalid-config',
      args: [],
      authArgs: [],
      configPath,
      status: {
        enabled: true,
        configured: false,
        available: false,
        authenticated: false,
        transport: 'stdio',
        configPath,
        reason: error instanceof Error ? error.message : String(error),
      },
    }
  }

  const explicitCommand = text(env.FEISHU_MCP_BIN) || text(env.LARK_MCP_BIN)
  let command = resolveMcpExecutable(explicitCommand || 'lark-mcp', { env, cwd, platform })
  let source: 'direct' | 'npx' = 'direct'
  let args = ['mcp', '--config', configPath, '--mode', 'stdio']
  let authArgs = ['whoami']
  if (!command) {
    command = resolveMcpExecutable('npx', { env, cwd, platform })
    source = 'npx'
    args = ['-y', '@larksuiteoapi/lark-mcp', 'mcp', '--config', configPath, '--mode', 'stdio']
    authArgs = ['-y', '@larksuiteoapi/lark-mcp', 'whoami']
  }
  if (!command) {
    return {
      source: 'invalid-config',
      args: [],
      authArgs: [],
      configPath,
      config,
      status: {
        enabled: true,
        configured: true,
        available: false,
        authenticated: false,
        transport: 'stdio',
        configPath,
        reason: '已找到 MCP 配置，但未找到 lark-mcp 或 npx 可执行文件',
      },
    }
  }

  return {
    source,
    command,
    args,
    authArgs,
    configPath,
    config,
    status: {
      enabled: true,
      configured: true,
      available: true,
      authenticated: false,
      transport: 'stdio',
      command,
      configPath,
    },
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(',')}]`
}

export function buildFeishuMcpCodexArgs(resolution: FeishuMcpResolution): string[] {
  if (!resolution.command || !resolution.status.available) return []
  return buildMcpServerCodexArgs('feishu', resolution.command, resolution.args)
}

export function buildMcpServerCodexArgs(
  name: string,
  command: string,
  args: string[],
): string[] {
  return [
    '-c',
    `mcp_servers.${name}.command=${tomlString(command)}`,
    '-c',
    `mcp_servers.${name}.args=${tomlArray(args)}`,
  ]
}

export function inspectFeishuMcpAuth(
  resolution: FeishuMcpResolution,
  env: NodeJS.ProcessEnv = process.env,
): FeishuMcpAuthStatus {
  if (!resolution.command || !resolution.status.available) {
    return { authenticated: false, reason: resolution.status.reason ?? '飞书 MCP 不可用' }
  }
  if (resolution.source === 'npx') {
    return { authenticated: false, reason: '通过 npx 回退运行，跳过登录态探测' }
  }
  const result = spawnSync(resolution.command, resolution.authArgs, {
    encoding: 'utf8',
    env,
    timeout: 12_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) return { authenticated: false, reason: result.error.message }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  if (result.status !== 0) {
    return {
      authenticated: false,
      reason: output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-1)[0] ||
        `lark-mcp whoami 退出码 ${result.status ?? 1}`,
    }
  }
  if (/No active login sessions found/i.test(output)) {
    return { authenticated: false, reason: '本机尚未完成飞书 MCP OAuth 登录' }
  }
  return { authenticated: true }
}

export function feishuMcpRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnv(env.FEISHU_MCP_REQUIRED)
}

export function buildFeishuMcpLoginCommand(resolution: FeishuMcpResolution): string[] {
  if (!resolution.command || !resolution.config) {
    throw new Error(resolution.status.reason ?? '飞书 MCP 配置不可用')
  }
  const prefix = resolution.source === 'npx' ? ['-y', '@larksuiteoapi/lark-mcp'] : []
  return [
    ...prefix,
    'login',
    '-d',
    resolution.config.domain,
    '--host',
    resolution.config.host,
    '--port',
    resolution.config.port,
    ...(resolution.config.scope ? ['--scope', resolution.config.scope] : []),
  ]
}

export function feishuMcpCredentialEnv(
  resolution: FeishuMcpResolution,
): NodeJS.ProcessEnv {
  if (!resolution.config) throw new Error(resolution.status.reason ?? '飞书 MCP 配置不可用')
  return {
    APP_ID: resolution.config.appId,
    APP_SECRET: resolution.config.appSecret,
  }
}

export function buildFeishuMcpLogoutCommand(resolution: FeishuMcpResolution): string[] {
  if (!resolution.command || !resolution.config) {
    throw new Error(resolution.status.reason ?? '飞书 MCP 配置不可用')
  }
  const prefix = resolution.source === 'npx' ? ['-y', '@larksuiteoapi/lark-mcp'] : []
  return [...prefix, 'logout', '-a', resolution.config.appId]
}
