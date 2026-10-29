import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

export interface ResolveCodexBinaryOptions {
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
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

function resolveFromPath(command: string, pathValue: string): string | undefined {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, command)
    if (isExecutableFile(candidate)) return resolve(candidate)
  }
  return undefined
}

function extensionCandidates(home: string, platform: NodeJS.Platform): string[] {
  const roots = [
    join(home, '.vscode', 'extensions'),
    join(home, '.vscode-insiders', 'extensions'),
    join(home, '.cursor', 'extensions'),
  ]
  const candidates: string[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    const extensions = readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (entry.name.startsWith('openai.chatgpt-') || entry.name.startsWith('openai.codex-')),
      )
      .map((entry) => entry.name)
      .sort()
      .reverse()
    for (const extension of extensions) {
      const binRoot = join(root, extension, 'bin')
      if (!existsSync(binRoot)) continue
      for (const entry of readdirSync(binRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        candidates.push(
          join(binRoot, entry.name, platform === 'win32' ? 'codex.exe' : 'codex'),
        )
      }
    }
  }
  return candidates
}

export function resolveCodexBinary(
  options: ResolveCodexBinaryOptions = {},
): string | undefined {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const explicit = env.CODEX_BIN?.trim()
  if (explicit) {
    const resolved = explicit.includes('/') || explicit.includes('\\')
      ? resolve(explicit)
      : resolveFromPath(explicit, env.PATH ?? '')
    if (resolved && isExecutableFile(resolved)) return resolved
  }

  const pathCandidate = resolveFromPath('codex', env.PATH ?? '')
  if (pathCandidate) return pathCandidate

  const knownCandidates = [
    join(home, '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    ...extensionCandidates(home, platform),
  ]
  return knownCandidates.find(isExecutableFile)
}

export function codexBinaryError(): string {
  return '未找到可执行的 Codex CLI。请设置 CODEX_BIN 为 codex 可执行文件的绝对路径，或安装 Codex CLI 后重启本机代理'
}
