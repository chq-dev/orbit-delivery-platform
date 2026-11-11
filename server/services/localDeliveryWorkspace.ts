import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, rmdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { normalizeDeliveryPath } from './localDeliveryEvidence.js'
import {
  clearStaleGitIndexLock,
  type ExcludedDeliveryCommitFile,
} from './localDeliveryCommitService.js'

const DELIVERY_ARTIFACT_PREFIX = 'delivery-artifacts/'

export interface DeliveryWorktreeIsolation {
  checkout: string
  active: boolean
  stashHash?: string
  baseHead?: string
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

export function unmergedDeliveryFiles(checkout: string): string[] {
  return requireGit(checkout, ['ls-files', '-u', '-z'], '检查未解决的合并冲突')
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(entry.indexOf('\t') + 1))
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
  return listDeliveryWorktreeFiles(checkout)
}

export function isolatePreexistingDeliveryChanges(
  checkout: string,
  label: string,
): DeliveryWorktreeIsolation {
  const unmerged = unmergedDeliveryFiles(checkout)
  if (unmerged.length > 0) {
    throw new Error(
      `客户端仓库存在未解决的合并冲突，不能开始本地交付：${unmerged.slice(0, 8).join(', ')}`,
    )
  }
  const files = preexistingFiles(checkout)
  const isolation: DeliveryWorktreeIsolation = {
    checkout,
    active: false,
    preexistingFiles: files,
  }
  const isolatedFiles = files.filter((file) => !file.startsWith(DELIVERY_ARTIFACT_PREFIX))
  if (isolatedFiles.length === 0) return isolation

  isolation.baseHead = requireGit(checkout, ['rev-parse', 'HEAD'], '记录隔离前提交')
  clearStaleGitIndexLock(checkout)
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

  const isolated = new Set(isolatedFiles)
  const remaining = preexistingFiles(checkout).filter((file) => isolated.has(file))
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

  const currentFiles = new Set(preexistingFiles(isolation.checkout))
  if (isolation.baseHead) {
    const committed = requireGit(
      isolation.checkout,
      ['diff', '--name-only', '-z', `${isolation.baseHead}..HEAD`],
      '检查交付提交文件',
    )
    for (const file of splitNullList(committed)) currentFiles.add(file)
  }
  const overlaps = isolation.preexistingFiles.filter(
    (file) =>
      !file.startsWith(DELIVERY_ARTIFACT_PREFIX) &&
      currentFiles.has(file),
  )
  if (overlaps.length > 0) {
    return {
      restored: false,
      warning: `恢复交付前未提交代码时发生冲突：为避免覆盖本次交付改动，未自动应用 ${selector}；重复路径：${overlaps.slice(0, 8).join(', ')}。原有改动仍保存在该 stash 中`,
    }
  }

  clearStaleGitIndexLock(isolation.checkout)
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

function isCleanupCandidate(
  file: ExcludedDeliveryCommitFile,
  includeEvidenceFiles: boolean,
): boolean {
  const path = normalizeDeliveryPath(file.path)
  if (!isSafeRelativePath(path)) return false
  if (path.startsWith(DELIVERY_ARTIFACT_PREFIX)) return includeEvidenceFiles
  if (includeEvidenceFiles && /LDD\/设计文档/.test(file.reason)) return true
  return /测试文件|日志或临时|依赖或构建产物|构建产物|操作系统文件|环境变量|密钥或证书/.test(
    file.reason,
  )
}

export interface CleanupGeneratedDeliveryFilesOptions {
  includeEvidenceFiles?: boolean
}

function pruneEmptyDirectories(checkout: string, path: string): void {
  const parts = path.split('/')
  parts.pop()
  while (parts.length > 0) {
    const directory = join(checkout, ...parts)
    try {
      rmdirSync(directory)
    } catch {
      break
    }
    parts.pop()
  }
}

export function cleanupGeneratedDeliveryFiles(
  checkout: string,
  files: readonly ExcludedDeliveryCommitFile[],
  protectedFiles: readonly string[] = [],
  options: CleanupGeneratedDeliveryFilesOptions = {},
): string[] {
  const cleaned: string[] = []
  const protectedPaths = new Set(protectedFiles.map(normalizeDeliveryPath).filter(Boolean))
  for (const file of files) {
    if (!isCleanupCandidate(file, options.includeEvidenceFiles === true)) continue
    const path = normalizeDeliveryPath(file.path)
    if (protectedPaths.has(path)) continue
    const tracked = git(checkout, ['ls-files', '--error-unmatch', '--', path])
    if (tracked.status === 0) {
      const restored = git(checkout, ['restore', '--worktree', '--', path])
      if (restored.status === 0) cleaned.push(path)
      continue
    }
    rmSync(join(checkout, ...path.split('/')), { force: true })
    cleaned.push(path)
    pruneEmptyDirectories(checkout, path)
  }
  return cleaned
}

export function cleanupDeliveryArtifactDirectory(checkout: string, workItemId: string): boolean {
  const id = workItemId.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) return false
  const directory = join(checkout, 'delivery-artifacts', id)
  if (!existsSync(directory)) return false
  rmSync(directory, { recursive: true, force: true })
  try {
    rmdirSync(join(checkout, 'delivery-artifacts'))
  } catch {
    // Keep the shared directory when other work items still have artifacts.
  }
  return true
}
