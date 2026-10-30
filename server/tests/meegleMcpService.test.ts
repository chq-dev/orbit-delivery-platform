import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildMeegleMcpCodexArgs,
  meegleMcpRequired,
  resolveMeegleMcpRuntime,
} from '../services/meegleMcpService.js'

function executable(path: string): void {
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
}

test('Meegle MCP 解析本地服务并生成 codex 参数', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-meegle-mcp-'))
  const scriptPath = join(root, 'meegleServer.ts')
  writeFileSync(scriptPath, '// fake MCP entry\n')
  const tsx = join(root, 'tsx')
  const meegle = join(root, 'meegle')
  executable(tsx)
  executable(meegle)

  const resolution = resolveMeegleMcpRuntime({
    env: {
      MEEGLE_MCP_TSX_BIN: tsx,
      MEEGLE_BIN: meegle,
      PATH: '',
    },
    cwd: root,
    platform: 'darwin',
    scriptPath,
  })
  assert.equal(resolution.status.configured, true)
  assert.equal(resolution.status.available, true)
  assert.equal(resolution.command, tsx)
  assert.deepEqual(resolution.args, [scriptPath])
  assert.deepEqual(buildMeegleMcpCodexArgs(resolution), [
    '-c',
    `mcp_servers.meegle.command=${JSON.stringify(tsx)}`,
    '-c',
    `mcp_servers.meegle.args=${JSON.stringify([scriptPath])}`,
  ])
})

test('Meegle MCP 在脚本、tsx 或 meegle CLI 缺失时明确禁用', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-meegle-mcp-missing-'))
  const missingScript = resolveMeegleMcpRuntime({
    env: { MEEGLE_MCP_TSX_BIN: join(root, 'tsx'), MEEGLE_BIN: join(root, 'meegle') },
    cwd: root,
    platform: 'darwin',
    scriptPath: join(root, 'missing.ts'),
  })
  assert.equal(missingScript.status.configured, false)
  assert.match(missingScript.status.reason ?? '', /未找到 Meegle MCP 服务脚本/)

  const scriptPath = join(root, 'meegleServer.ts')
  writeFileSync(scriptPath, '// fake MCP entry\n')
  const tsx = join(root, 'tsx')
  executable(tsx)
  const missingCli = resolveMeegleMcpRuntime({
    env: { MEEGLE_MCP_TSX_BIN: tsx, PATH: '' },
    cwd: root,
    platform: 'darwin',
    scriptPath,
  })
  assert.equal(missingCli.status.configured, true)
  assert.equal(missingCli.status.available, false)
  assert.match(missingCli.status.reason ?? '', /meegle/)

  const disabled = resolveMeegleMcpRuntime({
    env: { MEEGLE_MCP_ENABLED: 'off' },
    cwd: root,
    platform: 'darwin',
    scriptPath,
  })
  assert.equal(disabled.status.enabled, false)
  assert.equal(meegleMcpRequired({ MEEGLE_MCP_REQUIRED: 'true' }), true)
})

test('Meegle MCP 缺少 tsx 时不生成启动参数', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-meegle-mcp-no-tsx-'))
  const scriptPath = join(root, 'meegleServer.ts')
  mkdirSync(join(root, 'bin'))
  writeFileSync(scriptPath, '// fake MCP entry\n')
  const resolution = resolveMeegleMcpRuntime({
    env: { PATH: join(root, 'bin') },
    cwd: root,
    platform: 'darwin',
    scriptPath,
  })
  assert.equal(resolution.status.configured, false)
  assert.match(resolution.status.reason ?? '', /tsx/)
  assert.deepEqual(buildMeegleMcpCodexArgs(resolution), [])
})
