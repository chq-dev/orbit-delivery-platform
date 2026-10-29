import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveCodexBinary } from '../services/codexBinaryService.js'

function executable(path: string): void {
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
}

test('CODEX_BIN 应优先解析为绝对可执行路径', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-codex-bin-'))
  const binary = join(root, 'codex-custom')
  executable(binary)
  assert.equal(
    resolveCodexBinary({ env: { CODEX_BIN: binary }, home: root, platform: 'darwin' }),
    binary,
  )
})

test('launchd 缺少 PATH 时可发现 VS Code 扩展内置 Codex', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-codex-extension-'))
  const binDir = join(
    root,
    '.vscode',
    'extensions',
    'openai.chatgpt-1.2.3',
    'bin',
    'darwin-x64',
  )
  mkdirSync(binDir, { recursive: true })
  const binary = join(binDir, 'codex')
  executable(binary)
  assert.equal(
    resolveCodexBinary({ env: { PATH: '/usr/bin:/bin' }, home: root, platform: 'darwin' }),
    binary,
  )
})

test('不存在的 CODEX_BIN 不会阻止后续 PATH 查找', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-codex-path-'))
  const pathDir = join(root, 'bin')
  mkdirSync(pathDir)
  const binary = join(pathDir, 'codex')
  executable(binary)
  assert.equal(
    resolveCodexBinary({
      env: { CODEX_BIN: join(root, 'missing-codex'), PATH: pathDir },
      home: root,
      platform: 'darwin',
    }),
    binary,
  )
})
