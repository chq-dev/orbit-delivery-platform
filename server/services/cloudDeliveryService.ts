import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppDatabase } from '../db/database.js'
import { conflict, errorMessage, unprocessable } from '../domain/errors.js'
import { config } from '../config.js'
import type { CredentialVault } from '../security/vault.js'
import {
  getAccountSecret,
  listAccounts,
} from './accountService.js'
import { codexBinaryError, resolveCodexBinary } from './codexBinaryService.js'
import { createLocalDeliveryAgentSteps, parseLocalDeliveryAgentRequest, type LocalDeliveryAgentStep } from './localDeliveryAgentService.js'
import { issueFeishuAgentCredential } from './feishuSyncTokenService.js'
import { getRepository } from './repositoryService.js'

const CLOUD_JOB_TIMEOUT_MS = 60 * 60_000
const MAX_RETAINED_JOBS = 30

export interface CloudDeliveryJob {
  id: string
  status: 'running' | 'succeeded' | 'failed'
  stage: string
  workItemId: string
  repoId: string
  localPath?: string
  branch?: string
  steps: LocalDeliveryAgentStep[]
  startedAt: string
  finishedAt?: string
  result?: unknown
  error?: string
}

export interface CloudDeliveryReadiness {
  available: boolean
  gitAvailable: boolean
  runnerAvailable: boolean
  codexAvailable: boolean
  allowedGitHostsConfigured: boolean
  platformUrlConfigured: boolean
  busy: boolean
  reason?: string
}

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

const jobs = new Map<string, CloudDeliveryJob>()
let activeJobId = ''

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function executionEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const keys = [
    'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
    'SYSTEMROOT', 'WINDIR', 'CODEX_BIN', 'CODEX_HOME',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID',
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const key of keys) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return { ...env, ...extra }
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = 30_000,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd: process.cwd(), env, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode: typeof code === 'number' ? code : code ? 1 : 0,
        })
      },
    )
  })
}

function parseJsonOutput(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  for (let index = trimmed.lastIndexOf('{'); index >= 0; index = trimmed.lastIndexOf('{', index - 1)) {
    try {
      return JSON.parse(trimmed.slice(index)) as unknown
    } catch {
      // The CLI can print progress before its final JSON object.
    }
  }
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

function setStep(job: CloudDeliveryJob, key: string, status: LocalDeliveryAgentStep['status'], log: string): void {
  const step = job.steps.find((entry) => entry.key === key)
  if (!step) return
  const now = new Date().toISOString()
  step.status = status
  if (status === 'running' && !step.startedAt) step.startedAt = now
  if (status === 'success' || status === 'failed') step.finishedAt = now
  step.log = log.slice(0, 2_000)
}

function readiness(): CloudDeliveryReadiness {
  const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
  const runnerAvailable = existsSync(join(process.cwd(), 'node_modules', '.bin', 'tsx'))
  const codexAvailable = Boolean(resolveCodexBinary())
  const allowedGitHostsConfigured = config.cloudDeliveryGitHosts.length > 0
  let platformUrlConfigured = false
  try {
    const url = new URL(config.cloudDeliveryPlatformUrl)
    platformUrlConfigured =
      (url.protocol === 'https:' ||
        ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.protocol === 'http:')) &&
      !url.username &&
      !url.password &&
      (!url.pathname || url.pathname === '/') &&
      !url.search &&
      !url.hash
  } catch {
    // Readiness reports the missing or invalid platform URL below.
  }
  const reasons = [
    !gitAvailable ? '服务器未安装 Git' : '',
    !runnerAvailable ? '服务器未安装 tsx 交付运行器依赖' : '',
    !codexAvailable ? codexBinaryError() : '',
    !allowedGitHostsConfigured ? '服务器未配置 CLOUD_DELIVERY_GIT_HOSTS' : '',
    !platformUrlConfigured ? '服务器未配置合法的 CLOUD_DELIVERY_PLATFORM_URL（要求 HTTPS）' : '',
  ].filter(Boolean)
  return {
    available: reasons.length === 0,
    gitAvailable,
    runnerAvailable,
    codexAvailable,
    allowedGitHostsConfigured,
    platformUrlConfigured,
    busy: Boolean(activeJobId),
    ...(reasons.length ? { reason: reasons.join('；') } : {}),
  }
}

export function getCloudDeliveryReadiness(): CloudDeliveryReadiness {
  return readiness()
}

export function getCloudDeliveryJob(jobId: string): CloudDeliveryJob | undefined {
  return jobs.get(jobId)
}

function allowedGitUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw unprocessable('仓库 Git 地址不是合法 URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw unprocessable('服务器临时检出只允许使用不含内嵌凭据的 HTTPS Git 地址')
  }
  const host = url.host.toLowerCase()
  if (!config.cloudDeliveryGitHosts.includes(host)) {
    throw unprocessable(`仓库主机 ${host} 未加入服务器 CLOUD_DELIVERY_GIT_HOSTS 白名单`)
  }
  return url
}

function safeCommandError(result: CommandResult): string {
  return `${result.stderr}\n${result.stdout}`
    .trim()
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, '[redacted]@')
    .slice(-4_000) || `退出码 ${result.exitCode}`
}

function pruneJobs(): void {
  const completed = [...jobs.values()]
    .filter((job) => job.status !== 'running')
    .sort((left, right) => (right.finishedAt ?? '').localeCompare(left.finishedAt ?? ''))
  for (const job of completed.slice(MAX_RETAINED_JOBS)) jobs.delete(job.id)
}

export function startCloudDelivery(
  db: AppDatabase,
  vault: CredentialVault,
  input: unknown,
): CloudDeliveryJob {
  const available = readiness()
  if (!available.available) throw conflict(`服务器临时执行尚未就绪：${available.reason}`)
  if (activeJobId) throw conflict('服务器已有临时交付任务运行，请稍后重试')
  const request = parseLocalDeliveryAgentRequest({
    ...(isRecord(input) ? input : {}),
    temporaryCheckout: true,
  })
  if (!request.autoCommit || !request.pushAfterAcceptance) {
    throw unprocessable('临时检出任务需要启用自动提交和推送，否则清理工作区后代码无法保留')
  }
  const platformUrl = new URL(config.cloudDeliveryPlatformUrl)
  const workItem = db
    .prepare('SELECT type FROM work_items WHERE id = ?')
    .get(request.workItemId) as { type: 'requirement' | 'defect' } | undefined

  const job: CloudDeliveryJob = {
    id: `cloud-delivery-${randomUUID()}`,
    status: 'running',
    stage: '准备服务器临时工作区',
    workItemId: request.workItemId,
    repoId: request.repoId,
    startedAt: new Date().toISOString(),
    steps: createLocalDeliveryAgentSteps(workItem?.type),
  }
  jobs.set(job.id, job)
  activeJobId = job.id
  pruneJobs()
  void executeCloudDelivery(db, vault, job, request, platformUrl.origin)
  return job
}

async function executeCloudDelivery(
  db: AppDatabase,
  vault: CredentialVault,
  job: CloudDeliveryJob,
  request: ReturnType<typeof parseLocalDeliveryAgentRequest>,
  platformBaseUrl: string,
): Promise<void> {
  let tempRoot = ''
  let credentialClientId = ''
  let workspaceCleaned = false
  const secrets: string[] = []
  try {
    setStep(job, 'platform', 'running', '读取平台仓库、分支和 Git 账号')
    const repository = getRepository(db, request.repoId)
    const gitUrl = allowedGitUrl(repository.url)
    const account = listAccounts(db).find((entry) => entry.id === repository.accountId)
    if (!account || account.platform !== 'git' || account.status !== 'active') {
      throw unprocessable('仓库关联的 Git 账号不存在或已停用')
    }
    const password = getAccountSecret(db, vault, account.id)
    secrets.push(password)
    const branch = text(repository.branch)
    if (!branch) throw unprocessable('请先为仓库配置默认分支')
    job.branch = branch
    setStep(job, 'platform', 'success', `已读取仓库 ${repository.name} · ${branch}`)
    setStep(job, 'contract', 'success', '服务器执行使用真实交付契约')

    tempRoot = mkdtempSync(join(tmpdir(), 'orbit-cloud-delivery-'))
    chmodSync(tempRoot, 0o700)
    const checkout = join(tempRoot, 'checkout')
    const askpassPath = join(tempRoot, 'git-askpass.sh')
    const emptyEnvPath = join(tempRoot, 'empty.env')
    writeFileSync(emptyEnvPath, '', { mode: 0o600 })
    writeFileSync(
      askpassPath,
      '#!/bin/sh\ncase "$1" in *"https://$ORBIT_GIT_ALLOWED_HOST/"*|*"https://$ORBIT_GIT_ALLOWED_HOST\'"*|*"https://$ORBIT_GIT_USERNAME@$ORBIT_GIT_ALLOWED_HOST/"*|*"https://$ORBIT_GIT_USERNAME@$ORBIT_GIT_ALLOWED_HOST\'"*) ;; *) exit 1 ;; esac\ncase "$1" in *Username*) printf \'%s\\n\' "$ORBIT_GIT_USERNAME" ;; *Password*) printf \'%s\\n\' "$ORBIT_GIT_PASSWORD" ;; *) exit 1 ;; esac\n',
      { mode: 0o700 },
    )
    chmodSync(askpassPath, 0o700)
    const gitEnv = executionEnvironment({
      GIT_ASKPASS: askpassPath,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.followRedirects',
      GIT_CONFIG_VALUE_0: 'false',
      ORBIT_GIT_ALLOWED_HOST: gitUrl.host,
      ORBIT_GIT_USERNAME: account.username,
      ORBIT_GIT_PASSWORD: password,
    })
    setStep(job, 'checkout', 'running', `正在服务器临时工作区检出 ${gitUrl.host} · ${branch}`)
    const clone = await runCommand(
      'git',
      ['-c', 'http.followRedirects=false', 'clone', '--depth', '1', '--single-branch', '--branch', branch, gitUrl.toString(), checkout],
      gitEnv,
      10 * 60_000,
    )
    if (clone.exitCode !== 0) throw new Error(`Git 临时检出失败：${safeCommandError(clone)}`)
    const gitName = await runCommand('git', ['-C', checkout, 'config', 'user.name', 'Orbit Cloud Executor'], gitEnv)
    if (gitName.exitCode !== 0) throw new Error(`Git 用户名配置失败：${safeCommandError(gitName)}`)
    const gitEmail = await runCommand('git', ['-C', checkout, 'config', 'user.email', 'orbit-delivery@localhost'], gitEnv)
    if (gitEmail.exitCode !== 0) throw new Error(`Git 邮箱配置失败：${safeCommandError(gitEmail)}`)
    job.localPath = '服务器临时工作区（任务结束后清理）'
    setStep(job, 'checkout', 'success', `服务器临时检出完成：${branch}`)
    setStep(job, 'codex', 'running', 'Codex 正在服务器临时工作区执行交付')

    credentialClientId = `cloud-${randomUUID()}`
    const serviceToken = issueFeishuAgentCredential(db, credentialClientId)
    const runnerCommand = join(process.cwd(), 'node_modules', '.bin', 'tsx')
    const cliArgs = [
      join(process.cwd(), 'server', 'cli', 'localDelivery.ts'),
      '--api',
      platformBaseUrl,
      '--work-item',
      request.workItemId,
      '--repo',
      request.repoId,
      '--path',
      checkout,
      '--branch',
      branch,
      '--run',
      '--push',
      '--yes',
      ...(request.autoClose ? ['--close'] : []),
    ]
    const delivery = await runCommand(
      runnerCommand,
      cliArgs,
      executionEnvironment({
        DOTENV_CONFIG_PATH: emptyEnvPath,
        PLATFORM_BASE_URL: platformBaseUrl,
        PLATFORM_SYNC_TOKEN: serviceToken,
        GIT_AUTHOR_NAME: 'Orbit Cloud Executor',
        GIT_AUTHOR_EMAIL: 'orbit-delivery@localhost',
        GIT_COMMITTER_NAME: 'Orbit Cloud Executor',
        GIT_COMMITTER_EMAIL: 'orbit-delivery@localhost',
        ORBIT_DELIVERY_REPORTED_PATH: '服务器临时工作区（任务结束后已清理）',
        ORBIT_DELIVERY_EXPECTED_REMOTE_URL: gitUrl.href,
        ORBIT_CODEX_EPHEMERAL: 'true',
      }),
      CLOUD_JOB_TIMEOUT_MS,
    )
    if (delivery.exitCode !== 0) throw new Error(`服务器临时交付失败：${safeCommandError(delivery)}`)
    const result = parseJsonOutput(delivery.stdout)
    if (!isRecord(result) || result.status !== 'success') {
      throw new Error('服务器交付程序没有返回成功结果')
    }
    const evidence = isRecord(result.evidence) ? result.evidence : {}
    job.result = {
      status: 'success',
      ...(text(result.commit) ? { commit: text(result.commit) } : {}),
      changedFiles: Array.isArray(result.changedFiles)
        ? result.changedFiles.filter((entry): entry is string => typeof entry === 'string').slice(0, 200)
        : [],
      evidence: Object.fromEntries(
        ['designReport', 'integrationReport', 'testReport', 'buildReport', 'upgradeReport']
          .map((key) => [key, evidence[key] === true]),
      ),
      ...(isRecord(result.platformPipeline) ? { platformPipeline: result.platformPipeline } : {}),
      checkout: '服务器临时工作区（任务结束后已清理）',
    }
    setStep(job, 'codex', 'success', 'Codex 已完成需求实现')
    const reports = ['designReport', 'integrationReport', 'testReport', 'buildReport', 'upgradeReport']
      .filter((key) => evidence[key] === true).length
    setStep(job, 'evidence', 'success', `已记录 ${reports} 份真实交付报告`)
    setStep(job, 'commit', 'success', `提交 ${text(result.commit).slice(0, 12)} 已推送`)
    setStep(job, 'writeback', 'success', '平台流水线已回写')
    job.status = 'succeeded'
    job.stage = '服务器临时交付完成，仓库已清理'
  } catch (error) {
    let message = errorMessage(error)
    if (tempRoot) message = message.split(tempRoot).join('[服务器临时工作区]')
    for (const secret of secrets) {
      if (secret) message = message.split(secret).join('[已脱敏]')
    }
    message = message.slice(0, 4_000)
    job.status = 'failed'
    job.error = message
    job.stage = `服务器临时交付失败：${message}`
    const failed = job.steps.find((step) => step.status === 'running') ?? job.steps.find((step) => step.status === 'pending')
    if (failed) {
      failed.status = 'failed'
      failed.finishedAt = new Date().toISOString()
      failed.log = message.slice(0, 2_000)
    }
  } finally {
    if (tempRoot) {
      try {
        rmSync(tempRoot, { recursive: true, force: true })
        workspaceCleaned = true
      } catch (error) {
        const cleanup = `临时工作区清理失败：${errorMessage(error).split(tempRoot).join('[服务器临时工作区]')}`
        job.status = 'failed'
        job.error = [job.error, cleanup].filter(Boolean).join('；')
        job.stage = cleanup
        setStep(job, 'checkout', 'failed', cleanup)
      }
    }
    if (credentialClientId) {
      try {
        db.prepare('DELETE FROM feishu_agent_credentials WHERE client_id = ?').run(credentialClientId)
      } catch (error) {
        const cleanup = `服务器临时服务凭据清理失败：${errorMessage(error)}`
        job.status = 'failed'
        job.error = [job.error, cleanup].filter(Boolean).join('；')
        job.stage = cleanup
      }
    }
    const checkoutLabel = workspaceCleaned
      ? '服务器临时工作区（任务结束后已清理）'
      : '服务器临时工作区清理失败，请管理员检查'
    if (job.localPath) job.localPath = checkoutLabel
    if (job.result && isRecord(job.result)) {
      job.result = { ...job.result, checkout: checkoutLabel }
    }
    job.finishedAt = new Date().toISOString()
    if (activeJobId === job.id) activeJobId = ''
    pruneJobs()
  }
}
