import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildMcpServerCodexArgs,
  resolveMcpExecutable,
  type McpExecutableOptions,
} from './feishuMcpService.js'

export interface MeegleMcpPublicStatus {
  enabled: boolean
  configured: boolean
  available: boolean
  command?: string
  scriptPath?: string
  reason?: string
}

export interface MeegleMcpResolution {
  status: MeegleMcpPublicStatus
  command?: string
  args: string[]
  scriptPath?: string
}

export interface MeegleMcpResolutionOptions extends McpExecutableOptions {
  scriptPath?: string
}

function text(value: string | undefined): string {
  return value?.trim() ?? ''
}

function isFalseEnv(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test(value?.trim() ?? '')
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '')
}

export function resolveMeegleMcpRuntime(
  options: MeegleMcpResolutionOptions = {},
): MeegleMcpResolution {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const scriptPath = resolve(
    options.scriptPath || env.MEEGLE_MCP_SCRIPT?.trim() || resolve(cwd, 'server', 'mcp', 'meegleServer.ts'),
  )
  if (isFalseEnv(env.MEEGLE_MCP_ENABLED)) {
    return {
      args: [],
      scriptPath,
      status: {
        enabled: false,
        configured: false,
        available: false,
        scriptPath,
        reason: 'MEEGLE_MCP_ENABLED 已关闭',
      },
    }
  }
  if (!existsSync(scriptPath)) {
    return {
      args: [],
      scriptPath,
      status: {
        enabled: true,
        configured: false,
        available: false,
        scriptPath,
        reason: `未找到 Meegle MCP 服务脚本：${scriptPath}`,
      },
    }
  }
  const command = resolveMcpExecutable(
    text(env.MEEGLE_MCP_TSX_BIN) || 'tsx',
    { env, cwd, platform: options.platform ?? process.platform },
  )
  if (!command) {
    return {
      args: [],
      scriptPath,
      status: {
        enabled: true,
        configured: false,
        available: false,
        scriptPath,
        reason: '已找到 Meegle MCP 服务脚本，但未找到 tsx 可执行文件',
      },
    }
  }
  const meegleCommand = resolveMcpExecutable(
    text(env.MEEGLE_BIN) || 'meegle',
    { env, cwd, platform: options.platform ?? process.platform },
  )
  if (!meegleCommand) {
    return {
      args: [scriptPath],
      command,
      scriptPath,
      status: {
        enabled: true,
        configured: true,
        available: false,
        command,
        scriptPath,
        reason: '未找到 meegle CLI；请设置 MEEGLE_BIN 或先登录 Meegle CLI',
      },
    }
  }
  return {
    command,
    args: [scriptPath],
    scriptPath,
    status: {
      enabled: true,
      configured: true,
      available: true,
      command,
      scriptPath,
    },
  }
}

export function buildMeegleMcpCodexArgs(resolution: MeegleMcpResolution): string[] {
  if (!resolution.command || !resolution.status.available) return []
  return buildMcpServerCodexArgs('meegle', resolution.command, resolution.args)
}

export function meegleMcpRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnv(env.MEEGLE_MCP_REQUIRED)
}
