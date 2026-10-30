import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildFeishuMcpCodexArgs,
  buildFeishuMcpLoginCommand,
  feishuMcpCredentialEnv,
  inspectFeishuMcpAuth,
  resolveFeishuMcpRuntime,
} from '../services/feishuMcpService.js'

function executable(path: string, body = '#!/bin/sh\nexit 0\n'): void {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function configFile(root: string, overrides: Record<string, unknown> = {}): string {
  const path = join(root, 'lark-mcp.json')
  writeFileSync(
    path,
    JSON.stringify({
      appId: 'cli_test_app',
      appSecret: 'secret-must-not-leak',
      domain: 'https://open.feishu.cn',
      tools: ['preset.default'],
      mode: 'stdio',
      ...overrides,
    }),
  )
  return path
}

test('飞书 MCP 解析 stdio 配置并生成 codex 启动参数', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-feishu-mcp-'))
  const configPath = configFile(root)
  const binary = join(root, 'lark-mcp')
  executable(binary)

  const resolution = resolveFeishuMcpRuntime({
    env: { FEISHU_MCP_CONFIG_PATH: configPath, FEISHU_MCP_BIN: binary, PATH: '' },
    home: root,
    cwd: root,
    platform: 'darwin',
  })
  assert.equal(resolution.source, 'direct')
  assert.equal(resolution.status.configured, true)
  assert.equal(resolution.status.available, true)
  assert.equal(resolution.status.transport, 'stdio')
  assert.deepEqual(resolution.args, ['mcp', '--config', configPath, '--mode', 'stdio'])
  assert.equal(JSON.stringify(resolution.status).includes('secret-must-not-leak'), false)

  const codexArgs = buildFeishuMcpCodexArgs(resolution)
  assert.deepEqual(codexArgs, [
    '-c',
    `mcp_servers.feishu.command=${JSON.stringify(binary)}`,
    '-c',
    `mcp_servers.feishu.args=${JSON.stringify(['mcp', '--config', configPath, '--mode', 'stdio'])}`,
  ])
  assert.equal(JSON.stringify(codexArgs).includes('secret-must-not-leak'), false)
  const loginCommand = buildFeishuMcpLoginCommand(resolution)
  assert.equal(loginCommand.includes('secret-must-not-leak'), false)
  assert.equal(loginCommand.includes('-s'), false)
  assert.equal(feishuMcpCredentialEnv(resolution).APP_SECRET, 'secret-must-not-leak')
})

test('飞书 MCP 配置缺失或关闭时不会注入，并强制使用 stdio', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-feishu-mcp-missing-'))
  const missing = resolveFeishuMcpRuntime({
    env: { FEISHU_MCP_CONFIG_PATH: join(root, 'missing.json') },
    home: root,
    cwd: root,
    platform: 'darwin',
  })
  assert.equal(missing.source, 'missing-config')
  assert.equal(missing.status.configured, false)
  assert.equal(missing.status.available, false)
  assert.deepEqual(buildFeishuMcpCodexArgs(missing), [])

  const disabled = resolveFeishuMcpRuntime({
    env: { FEISHU_MCP_ENABLED: 'false', FEISHU_MCP_CONFIG_PATH: join(root, 'missing.json') },
    home: root,
    cwd: root,
    platform: 'darwin',
  })
  assert.equal(disabled.source, 'disabled')
  assert.equal(disabled.status.enabled, false)

  const configPath = configFile(root, { mode: 'streamable' })
  const binary = join(root, 'lark-mcp')
  executable(binary)
  const forcedStdio = resolveFeishuMcpRuntime({
    env: { FEISHU_MCP_CONFIG_PATH: configPath, FEISHU_MCP_BIN: binary, PATH: '' },
    home: root,
    cwd: root,
    platform: 'darwin',
  })
  assert.equal(forcedStdio.status.available, true)
  assert.deepEqual(forcedStdio.args.slice(-2), ['--mode', 'stdio'])
})

test('未安装 lark-mcp 时回退 npx，且能识别未登录状态', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-feishu-mcp-npx-'))
  const configPath = configFile(root)
  const binDir = join(root, 'bin')
  mkdirSync(binDir)
  const npx = join(binDir, 'npx')
  executable(npx)
  const resolution = resolveFeishuMcpRuntime({
    env: { FEISHU_MCP_CONFIG_PATH: configPath, PATH: binDir },
    home: root,
    cwd: root,
    platform: 'darwin',
  })
  assert.equal(resolution.source, 'npx')
  assert.equal(resolution.command, npx)
  assert.deepEqual(resolution.args.slice(0, 3), ['-y', '@larksuiteoapi/lark-mcp', 'mcp'])

  const binary = join(root, 'lark-mcp')
  executable(
    binary,
    '#!/bin/sh\nif [ "$1" = "whoami" ]; then echo "No active login sessions found"; exit 0; fi\nexit 0\n',
  )
  const direct = resolveFeishuMcpRuntime({
    env: { FEISHU_MCP_CONFIG_PATH: configPath, FEISHU_MCP_BIN: binary, PATH: '' },
    home: root,
    cwd: root,
    platform: 'darwin',
  })
  const auth = inspectFeishuMcpAuth(direct, { PATH: '' })
  assert.equal(auth.authenticated, false)
  assert.match(auth.reason ?? '', /OAuth/)
})
