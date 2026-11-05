import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { normalizeDeliveryPath } from './localDeliveryEvidence.js'
import type { ExcludedDeliveryCommitFile } from './localDeliveryCommitService.js'

const DELIVERY_ARTIFACT_PREFIX = 'delivery-artifacts/'

export interface DeliveryWorktreeIsolation {
  checkout: string
  active: boolean
  stashHash?: string
  preexistingFiles: string[]
}

interface GitResult {
  status: number
  stdout: string
  stderr: string
}

function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  }
}

function requireGit(cwd: string, args: string[], operation: string): string {
  const result = git(cwd, args)
  if (result.status !== 0) {
    throw new Error(`${operation}失败：${result.stderr || result.stdout || `退出码 ${result.status}`}`)
  }
  return result.stdout
}

function splitNullList(output: string): string[] {
  return output
    .split('\0')
    .map(normalizeDeliveryPath)
    .filter(Boolean)
}

export function listDeliveryWorktreeFiles(checkout: string): string[] {
  const tracked = requireGit(checkout, ['diff', 'HEAD', '--name-only', '-z'], '读取工作区变更')
  const untracked = requireGit(
    checkout,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    '读取未跟踪文件',
  )
  return [...new Set([...splitNullList(tracked), ...splitNullList(untracked)])]
}

function preexistingFiles(checkout: string): string[] {
  return listDeliveryWorktreeFiles(checkout).filter(
    (file) => !file.startsWith(DELIVERY_ARTIFACT_PREFIX),
  )
}

export function isolatePreexistingDeliveryChanges(
  checkout: string,
  label: string,
): DeliveryWorktreeIsolation {
  const files = preexistingFiles(checkout)
  const isolation: DeliveryWorktreeIsolation = {
    checkout,
    active: false,
    preexistingFiles: files,
  }
  if (files.length === 0) return isolation

  const message = `orbit-delivery-${label.replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 80)}`
  const result = git(checkout, [
    'stash',
    'push',
    '--include-untracked',
    '-m',
    message,
    '--',
    '.',
    `:(exclude)${DELIVERY_ARTIFACT_PREFIX}**`,
  ])
  if (result.status !== 0) {
    throw new Error(
      `隔离客户端原有未提交代码失败：${
        result.stderr || result.stdout || `退出码 ${result.status}`
      }`,
    )
  }

  const hashResult = git(checkout, ['rev-parse', '--verify', 'refs/stash'])
  if (hashResult.status !== 0 || !hashResult.stdout) {
    throw new Error('隔离客户端原有未提交代码失败：未创建 Git stash')
  }
  isolation.active = true
  isolation.stashHash = hashResult.stdout

  const remaining = preexistingFiles(checkout)
  if (remaining.length > 0) {
    const restore = restorePreexistingDeliveryChanges(isolation)
    throw new Error(
      `隔离客户端原有未提交代码失败，工作区仍有变更：${remaining.slice(0, 8).join(', ')}${
        restore.warning ? `；${restore.warning}` : ''
      }`,
    )
  }
  return isolation
}

function stashSelector(checkout: string, hash: string): string | undefined {
  const result = git(checkout, ['stash', 'list', '--format=%gd%x09%H'])
  if (result.status !== 0) return undefined
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .find(([, entryHash]) => entryHash === hash)?.[0]
}

export function restorePreexistingDeliveryChanges(
  isolation: DeliveryWorktreeIsolation | undefined,
): { restored: boolean; warning?: string } {
  if (!isolation?.active || !isolation.stashHash) return { restored: false }
  const selector = stashSelector(isolation.checkout, isolation.stashHash)
  if (!selector) {
    return {
      restored: false,
      warning: `未找到交付前保存的 Git stash ${isolation.stashHash.slice(0, 12)}，请手工检查 git stash list`,
    }
  }
  const apply = git(isolation.checkout, ['stash', 'apply', '--quiet', selector])
  if (apply.status !== 0) {
    return {
      restored: false,
      warning: `恢复交付前未提交代码时发生冲突，变更仍保存在 ${selector}：${
        apply.stderr || apply.stdout || `退出码 ${apply.status}`
      }`,
    }
  }
  isolation.active = false
  const drop = git(isolation.checkout, ['stash', 'drop', '--quiet', selector])
  return drop.status === 0
    ? { restored: true }
    : {
        restored: true,
        warning: `交付前未提交代码已恢复，但清理 ${selector} 失败：${
          drop.stderr || drop.stdout || `退出码 ${drop.status}`
        }`,
      }
}

function isSafeRelativePath(path: string): boolean {
  return Boolean(path) && !isAbsolute(path) && !path.split('/').includes('..')
}

function isCleanupCandidate(file: ExcludedDeliveryCommitFile): boolean {
  const path = normalizeDeliveryPath(file.path)
  if (!isSafeRelativePath(path) || path.startsWith(DELIVERY_ARTIFACT_PREFIX)) return false
  return /测试文件|日志或临时|依赖或构建产物|构建产物|操作系统文件|环境变量|密钥或证书/.test(
    file.reason,
  )
}

export function cleanupGeneratedDeliveryFiles(
  checkout: string,
  files: readonly ExcludedDeliveryCommitFile[],
): string[] {
  const cleaned: string[] = []
  for (const file of files) {
    if (!isCleanupCandidate(file)) continue
    const path = normalizeDeliveryPath(file.path)
    const tracked = git(checkout, ['ls-files', '--error-unmatch', '--', path])
    if (tracked.status === 0) {
      const restored = git(checkout, ['restore', '--worktree', '--', path])
      if (restored.status === 0) cleaned.push(path)
      continue
    }
    rmSync(join(checkout, ...path.split('/')), { force: true })
    cleaned.push(path)
  }
  return cleaned
}
