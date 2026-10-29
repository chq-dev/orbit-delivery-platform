import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { AppError } from '../domain/errors.js'

const GIT_TIMEOUT_MS = 120_000
const OUTPUT_LIMIT = 2_000

interface GitResult {
  status: number
  stdout: string
  stderr: string
}

export interface LocalRepositoryInfo {
  path: string
  branch: string
  head: string
  dirty: boolean
}

export interface LocalCommitResult {
  changed: boolean
  commit: string
  shortCommit: string
  message: string
}

export interface LocalPushResult {
  pushed: boolean
  output: string
}

function runGit(localPath: string, args: string[]): GitResult {
  const result = spawnSync('git', ['-C', localPath, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  })
  const stdout = sanitize(result.stdout ?? '')
  const stderr = sanitize(result.stderr ?? '')
  if (result.error) {
    throw new AppError(
      422,
      'GIT_COMMAND_FAILED',
      `Git 命令执行失败：${sanitize(result.error.message)}`,
    )
  }
  return { status: result.status ?? 1, stdout, stderr }
}

function assertGitResult(result: GitResult, operation: string): string {
  if (result.status !== 0) {
    throw new AppError(
      422,
      'GIT_COMMAND_FAILED',
      `${operation}失败：${result.stderr || result.stdout || `退出码 ${result.status}`}`,
    )
  }
  return result.stdout.trim()
}

function sanitize(value: string): string {
  return value
    .replace(/https?:\/\/[^\s@]+@/g, 'https://***@')
    .slice(0, OUTPUT_LIMIT)
}

function normalizedPath(localPath: string): string {
  if (!localPath) {
    throw new AppError(422, 'GIT_LOCAL_PATH_REQUIRED', '请先配置客户端代码路径')
  }
  if (!isAbsolute(localPath)) {
    throw new AppError(422, 'GIT_LOCAL_PATH_INVALID', '客户端代码路径必须是绝对路径')
  }
  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
    throw new AppError(
      422,
      'GIT_LOCAL_PATH_INVALID',
      '当前服务端无法访问该客户端代码路径，或路径不是目录；跨服务器部署时请在代码所在客户端运行后端后再发起交付',
    )
  }
  return localPath
}

export function inspectLocalRepository(
  localPath: string,
  expectedBranch?: string,
): LocalRepositoryInfo {
  const path = normalizedPath(localPath)
  const topLevel = assertGitResult(
    runGit(path, ['rev-parse', '--show-toplevel']),
    '读取 Git 工作区',
  )
  const branch = assertGitResult(
    runGit(path, ['symbolic-ref', '--short', 'HEAD']),
    '读取本地分支',
  )
  if (expectedBranch && branch !== expectedBranch) {
    throw new AppError(
      409,
      'GIT_BRANCH_MISMATCH',
      `本地仓库当前分支为 ${branch}，与配置分支 ${expectedBranch} 不一致`,
    )
  }
  const head = assertGitResult(runGit(path, ['rev-parse', 'HEAD']), '读取本地提交')
  const status = assertGitResult(runGit(path, ['status', '--porcelain']), '检查本地变更')
  return { path: topLevel, branch, head, dirty: status.length > 0 }
}

export function commitLocalChanges(
  localPath: string,
  branch: string,
  message: string,
): LocalCommitResult {
  const info = inspectLocalRepository(localPath, branch)

  assertGitResult(runGit(info.path, ['add', '-A']), '暂存本地变更')
  const diff = runGit(info.path, ['diff', '--cached', '--quiet'])
  if (diff.status === 0) {
    return {
      changed: false,
      commit: info.head,
      shortCommit: info.head.slice(0, 8),
      message: `本地代码无待提交变更，保留提交 ${info.head.slice(0, 8)}`,
    }
  }
  if (diff.status !== 1) {
    throw new AppError(422, 'GIT_DIFF_FAILED', `检查待提交变更失败：${diff.stderr || diff.stdout}`)
  }

  assertGitResult(runGit(info.path, ['commit', '-m', message]), '创建本地提交')
  const commit = assertGitResult(runGit(info.path, ['rev-parse', 'HEAD']), '读取新提交')
  return {
    changed: true,
    commit,
    shortCommit: commit.slice(0, 8),
    message: `已在本地提交 ${commit.slice(0, 8)}`,
  }
}

export function pushLocalCommit(
  localPath: string,
  branch: string,
  expectedCommit: string,
): LocalPushResult {
  const info = inspectLocalRepository(localPath, branch)
  if (
    expectedCommit &&
    !info.head.startsWith(expectedCommit) &&
    !expectedCommit.startsWith(info.head)
  ) {
    throw new AppError(
      409,
      'GIT_COMMIT_MISMATCH',
      `本地最新提交 ${info.head.slice(0, 8)} 与流水线提交 ${expectedCommit.slice(0, 8)} 不一致`,
    )
  }

  const result = runGit(info.path, ['push', 'origin', `HEAD:refs/heads/${branch}`])
  const output = assertGitResult(result, '推送远端分支')
  return { pushed: true, output: output || `已推送至 origin/${branch}` }
}
