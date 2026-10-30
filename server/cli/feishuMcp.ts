import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import {
  buildFeishuMcpLoginCommand,
  buildFeishuMcpLogoutCommand,
  feishuMcpCredentialEnv,
  inspectFeishuMcpAuth,
  resolveFeishuMcpRuntime,
} from '../services/feishuMcpService.js'

function usage(): string {
  return `Orbit Feishu MCP

Usage:
  npm run mcp:feishu:status   Print configuration, executable and login status
  npm run mcp:feishu:login    Complete Feishu OAuth login in this terminal
  npm run mcp:feishu:logout   Clear the local Feishu OAuth session
  npm run mcp:feishu          Start the stdio MCP server for manual debugging

Configuration:
  FEISHU_MCP_CONFIG_PATH  Default: ~/.lark-mcp/config.json
  FEISHU_MCP_BIN          Optional path to lark-mcp
  FEISHU_MCP_ENABLED      Set false to disable injection
`
}

function publicStatus(): unknown {
  const resolution = resolveFeishuMcpRuntime()
  const auth = inspectFeishuMcpAuth(resolution)
  return {
    ...resolution.status,
    authenticated: auth.authenticated,
    reason: resolution.status.reason ?? auth.reason,
    source: resolution.source,
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const result = spawnSync(command, args, { stdio: 'inherit', env })
  if (result.error) throw result.error
  return result.status ?? 1
}

function main(): void {
  const action = process.argv[2]?.trim() || 'status'
  if (action === 'help' || action === '--help' || action === '-h') {
    console.log(usage())
    return
  }

  const resolution = resolveFeishuMcpRuntime()
  if (action === 'status') {
    console.log(JSON.stringify(publicStatus(), null, 2))
    return
  }
  if (action === 'start') {
    if (!resolution.command || !resolution.status.available) {
      throw new Error(resolution.status.reason ?? '飞书 MCP 不可用')
    }
    process.exitCode = run(resolution.command, resolution.args)
    return
  }
  if (action === 'login') {
    if (!resolution.command) throw new Error(resolution.status.reason ?? '飞书 MCP 不可用')
    process.exitCode = run(
      resolution.command,
      buildFeishuMcpLoginCommand(resolution),
      { ...process.env, ...feishuMcpCredentialEnv(resolution) },
    )
    return
  }
  if (action === 'logout') {
    if (!resolution.command) throw new Error(resolution.status.reason ?? '飞书 MCP 不可用')
    process.exitCode = run(resolution.command, buildFeishuMcpLogoutCommand(resolution))
    return
  }
  throw new Error(`未知命令：${action}\n\n${usage()}`)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
