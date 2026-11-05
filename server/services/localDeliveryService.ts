import type { AppDatabase } from '../db/database.js'
import { nextSequence } from '../db/sequences.js'
import { notFound, unprocessable } from '../domain/errors.js'
import { nowIso } from '../domain/time.js'
import type { PipelineRun, WorkItemType } from '../domain/types.js'
import { booleanValue, oneOf, optionalText, requiredText } from '../domain/validation.js'
import { enqueueFeishuCloseOutbox } from './feishuIntegrationService.js'
import {
  CLIENT_DELIVERY_TRIGGER,
  getPipeline,
  stageDefinitions,
} from './pipelineService.js'

export interface LocalDeliveryInput {
  workItemId?: unknown
  repoId?: unknown
  deliveryJobId?: unknown
  branch?: unknown
  localPath?: unknown
  commit?: unknown
  outcome?: unknown
  error?: unknown
  failedStageIndex?: unknown
  autoCommit?: unknown
  autoClose?: unknown
  pushed?: unknown
  summary?: unknown
  stageResults?: unknown
  reports?: unknown
}

interface LocalDeliveryStageResult {
  index: number
  status: 'success' | 'pending' | 'failed'
  log: string
}

interface LocalDeliveryReport {
  kind: string
  title: string
  summary: string
  content: string
}

interface LocalDeliveryProgressStep {
  key: string
  status: 'pending' | 'running' | 'success' | 'failed'
  log?: string
  startedAt?: string
  finishedAt?: string
}

interface LocalDeliveryProgressJob {
  id: string
  commandId?: string
  status: 'running' | 'succeeded' | 'failed'
  workItemId: string
  repoId: string
  branch?: string
  localPath?: string
  steps: LocalDeliveryProgressStep[]
  error?: string
}

interface LocalDeliveryStageState {
  status: 'pending' | 'running' | 'success' | 'failed'
  log: string
  startedAt?: string
  finishedAt?: string
}

const AGENT_STEP_STAGE_INDEX: Record<string, number> = {
  analysis: 0,
  ldd: 1,
  coding: 2,
  evidence: 3,
  commit: 4,
  writeback: 8,
}

function progressStep(value: unknown): LocalDeliveryProgressStep | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const key = typeof record.key === 'string' ? record.key.trim() : ''
  const status = record.status
  if (!key || (status !== 'pending' && status !== 'running' && status !== 'success' && status !== 'failed')) {
    return undefined
  }
  return {
    key,
    status,
    log: typeof record.log === 'string' ? record.log.trim().slice(0, 4_000) : undefined,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : undefined,
    finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : undefined,
  }
}

function progressJob(value: unknown): LocalDeliveryProgressJob | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim().slice(0, 200) : ''
  const workItemId = typeof record.workItemId === 'string' ? record.workItemId.trim() : ''
  const repoId = typeof record.repoId === 'string' ? record.repoId.trim() : ''
  const status = record.status
  if (!id || !workItemId || !repoId || (status !== 'running' && status !== 'succeeded' && status !== 'failed')) {
    return undefined
  }
  return {
    id,
    commandId: typeof record.commandId === 'string' ? record.commandId.trim().slice(0, 200) : undefined,
    status,
    workItemId,
    repoId,
    branch: typeof record.branch === 'string' ? record.branch.trim() : undefined,
    localPath: typeof record.localPath === 'string' ? record.localPath.trim() : undefined,
    steps: Array.isArray(record.steps)
      ? record.steps.map(progressStep).filter((step): step is LocalDeliveryProgressStep => Boolean(step))
      : [],
    error: typeof record.error === 'string' ? record.error.trim().slice(0, 4_000) : undefined,
  }
}

function defaultStageStates(): LocalDeliveryStageState[] {
  return stageDefinitions.map(() => ({
    status: 'pending',
    log: '等待本机执行',
  }))
}

function stageStatesFromJob(
  job: LocalDeliveryProgressJob,
  existing: LocalDeliveryStageState[] = defaultStageStates(),
): LocalDeliveryStageState[] {
  const states = existing.map((state) => ({ ...state }))
  const byKey = new Map(job.steps.map((step) => [step.key, step]))
  for (const [key, index] of Object.entries(AGENT_STEP_STAGE_INDEX)) {
    const step = byKey.get(key)
    if (!step || !states[index]) continue
    states[index] = {
      status: step.status,
      log: step.log || stageDefinitions[index].description,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
    }
  }

  const analysis = byKey.get('analysis')
  const connectivity = byKey.get('connectivity')
  if (states[0] && (!analysis || analysis.status === 'pending') && connectivity) {
    states[0] = {
      status: connectivity.status === 'failed'
        ? 'failed'
        : connectivity.status === 'success'
          ? 'running'
          : connectivity.status,
      log: connectivity.log || '正在校验平台、客户端仓库与分支',
      startedAt: connectivity.startedAt,
      finishedAt: connectivity.finishedAt,
    }
  }

  if (job.status === 'failed' && job.error) {
    const failed = states.findIndex((state) => state.status === 'failed')
    const running = states.findIndex((state) => state.status === 'running')
    const index = failed >= 0 ? failed : running >= 0 ? running : 0
    states[index] = {
      ...states[index],
      status: 'failed',
      log: states[index].log || job.error,
      finishedAt: states[index].finishedAt ?? new Date().toISOString(),
    }
  }
  return states
}

function stageProgress(states: LocalDeliveryStageState[]): { progress: number; currentStage: number } {
  const successCount = states.filter((state) => state.status === 'success').length
  const activeIndex = states.findIndex((state) => state.status === 'running')
  const currentStage = activeIndex >= 0 ? activeIndex : Math.min(9, successCount)
  return {
    progress: Math.min(95, Math.max(8, Math.round((successCount / stageDefinitions.length) * 100))),
    currentStage,
  }
}

function stageResultsFrom(value: unknown, requireSuccess: boolean): LocalDeliveryStageResult[] {
  const defaults = stageDefinitions.map((_stage, index) => ({
    index,
    status: 'pending' as const,
    log: '未检测到真实执行证据，本阶段未执行',
  }))
  if (!Array.isArray(value)) {
    if (requireSuccess) throw unprocessable('缺少客户端阶段证据，不能记录交付成功')
    return defaults
  }
  const byIndex = new Map<number, LocalDeliveryStageResult>()
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const index = Number(record.index)
    if (!Number.isInteger(index) || index < 0 || index >= stageDefinitions.length) continue
    const status = record.status
    if (status !== 'success' && status !== 'pending' && status !== 'failed') continue
    const log = typeof record.log === 'string' ? record.log.trim().slice(0, 4_000) : ''
    byIndex.set(index, { index, status, log: log || defaults[index].log })
  }
  const results = defaults.map((fallback) => byIndex.get(fallback.index) ?? fallback)
  if (!requireSuccess) return results
  if (results.some((result) => result.status === 'failed')) {
    throw unprocessable('客户端阶段存在失败结果，不能记录为成功交付')
  }
  if (results[2].status !== 'success') {
    throw unprocessable('缺少真实代码变更证据，不能记录为成功交付')
  }
  if (results[4].status !== 'success') {
    throw unprocessable('缺少本地提交证据，不能记录为成功交付')
  }
  return results
}

function failedStageIndexFrom(value: unknown): number | undefined {
  const index = Number(value)
  return Number.isInteger(index) && index >= 0 && index < stageDefinitions.length
    ? index
    : undefined
}

function reportFrom(value: unknown, fallbackKind: string): LocalDeliveryReport | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const candidateKind = typeof record.kind === 'string' ? record.kind.trim() : ''
  const kind = /^[a-z0-9][a-z0-9_-]{0,40}$/.test(candidateKind) ? candidateKind : fallbackKind
  const title = typeof record.title === 'string' ? record.title.trim().slice(0, 200) : ''
  const summary = typeof record.summary === 'string' ? record.summary.trim().slice(0, 2_000) : ''
  const content = typeof record.content === 'string' ? record.content.trim().slice(0, 256 * 1024) : ''
  if (!title || !summary || !content) return undefined
  return { kind, title, summary, content }
}

function reportsFrom(value: unknown): {
  design?: LocalDeliveryReport
  integration?: LocalDeliveryReport
  artifacts: LocalDeliveryReport[]
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { artifacts: [] }
  }
  const record = value as Record<string, unknown>
  const artifacts = Array.isArray(record.artifacts)
    ? record.artifacts
        .slice(0, 20)
        .map((entry, index) => reportFrom(entry, `artifact-${index + 1}`))
        .filter((entry): entry is LocalDeliveryReport => Boolean(entry))
    : []
  return {
    design: reportFrom(record.design, 'design'),
    integration: reportFrom(record.integration, 'integration'),
    artifacts,
  }
}

function insertLocalReport(
  db: AppDatabase,
  pipelineId: string,
  kind: string,
  report: LocalDeliveryReport,
  now: string,
): void {
  const suffix = pipelineId.replace('RUN-', '')
  const prefix =
    kind === 'design'
      ? 'DESIGN'
      : kind === 'integration'
        ? 'INTEGRATION'
        : kind.toUpperCase().replace(/[^A-Z0-9]+/g, '-')
  const id = `${prefix || 'ARTIFACT'}-${suffix}`
  db.prepare(
    `INSERT INTO pipeline_reports (id, pipeline_id, kind, title, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(pipeline_id, kind) DO UPDATE SET
       title = excluded.title,
       summary = excluded.summary,
       created_at = excluded.created_at`,
  ).run(id, pipelineId, kind, report.title, report.summary, now)
  db.prepare('DELETE FROM pipeline_report_sections WHERE report_id = ?').run(id)
  db.prepare(
    `INSERT INTO pipeline_report_sections (report_id, section_index, title, content)
     VALUES (?, 0, '报告正文', ?)`,
  ).run(id, report.content)
}

function pipelineIdForDeliveryJob(db: AppDatabase, deliveryJobId: string): string | undefined {
  const row = db
    .prepare('SELECT id FROM pipelines WHERE delivery_job_id = ?')
    .get(deliveryJobId) as { id: string } | undefined
  return row?.id
}

function runningLocalPipelineForWorkItem(
  db: AppDatabase,
  workItemId: string,
  repoId: string,
): { id: string; status: 'queued' | 'running' | 'success' | 'failed' } | undefined {
  const rows = db
    .prepare(
      `SELECT id, status FROM pipelines
       WHERE work_item_id = ? AND repo_id = ? AND status = 'running' AND triggered_by = ?
       ORDER BY created_at DESC LIMIT 2`,
    )
    .all(workItemId, repoId, CLIENT_DELIVERY_TRIGGER) as Array<{
    id: string
    status: 'queued' | 'running' | 'success' | 'failed'
  }>
  return rows.length === 1 ? rows[0] : undefined
}

export function syncLocalDeliveryPipelineFromAgentJob(
  db: AppDatabase,
  rawJob: unknown,
): PipelineRun | undefined {
  const job = progressJob(rawJob)
  if (!job) return undefined
  const workItem = db
    .prepare('SELECT id, type, title FROM work_items WHERE id = ?')
    .get(job.workItemId) as
    | { id: string; type: WorkItemType; title: string }
    | undefined
  const repository = db
    .prepare('SELECT id, name, branch, local_path, latest_version FROM repositories WHERE id = ?')
    .get(job.repoId) as
    | {
        id: string
        name: string
        branch: string
        local_path: string
        latest_version: string
      }
    | undefined
  if (!workItem || !repository) return undefined

  const deliveryJobId = job.commandId || job.id
  const existingId = pipelineIdForDeliveryJob(db, deliveryJobId)
  const now = nowIso()
  if (!existingId) {
    const pipelineId = `RUN-${nextSequence(db, 'pipeline', 2408)}`
    const states = stageStatesFromJob(job)
    const { progress, currentStage } = stageProgress(states)
    const status = job.status === 'failed' ? 'failed' : 'running'
    const branch = job.branch || repository.branch || 'unknown'
    const localPath = job.localPath || repository.local_path || ''
    db.transaction(() => {
      db.prepare(
        `INSERT INTO pipelines
          (id, work_item_id, title, item_type, repo_id, repo_name, branch, local_path,
           delivery_job_id, commit_hash, version, status, progress, current_stage, triggered_by,
           auto_commit, auto_close, simulation, created_at, updated_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '-', ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, ?, ?)`,
      ).run(
        pipelineId,
        workItem.id,
        workItem.title,
        workItem.type,
        repository.id,
        repository.name,
        branch,
        localPath,
        deliveryJobId,
        repository.latest_version,
        status,
        progress,
        currentStage,
        CLIENT_DELIVERY_TRIGGER,
        now,
        now,
        now,
        status === 'failed' ? now : null,
      )
      const insertStage = db.prepare(
        `INSERT INTO pipeline_stages
          (pipeline_id, stage_index, stage_key, name, description, status, duration, log, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, '本机执行', ?, ?, ?)`,
      )
      stageDefinitions.forEach((stage, index) => {
        const state = states[index]
        insertStage.run(
          pipelineId,
          index,
          stage.key,
          stage.name,
          stage.description,
          state.status,
          state.log,
          state.startedAt ?? null,
          state.finishedAt ?? null,
        )
      })
      db.prepare(
        "UPDATE work_items SET status = '进行中', updated_at = ? WHERE id = ? AND status != '已关闭'",
      ).run(now, workItem.id)
    })()
    return getPipeline(db, pipelineId)
  }

  const existing = db
    .prepare('SELECT status FROM pipelines WHERE id = ?')
    .get(existingId) as { status: 'queued' | 'running' | 'success' | 'failed' } | undefined
  if (!existing || existing.status !== 'running') return getPipeline(db, existingId)

  const previousStages = db
    .prepare(
      `SELECT stage_index, status, log, started_at, finished_at
       FROM pipeline_stages WHERE pipeline_id = ? ORDER BY stage_index ASC`,
    )
    .all(existingId) as Array<{
      stage_index: number
      status: 'pending' | 'running' | 'success' | 'failed'
      log: string | null
      started_at: string | null
      finished_at: string | null
    }>
  const existingStates = defaultStageStates().map((fallback, index) => {
    const row = previousStages.find((stage) => stage.stage_index === index)
    return row
      ? {
          status: row.status,
          log: row.log || fallback.log,
          startedAt: row.started_at ?? undefined,
          finishedAt: row.finished_at ?? undefined,
        }
      : fallback
  })
  const states = stageStatesFromJob(job, existingStates)
  const { progress, currentStage } = stageProgress(states)
  const status = job.status === 'failed' ? 'failed' : 'running'
  db.transaction(() => {
    db.prepare(
      `UPDATE pipelines SET
         branch = COALESCE(NULLIF(?, ''), branch),
         local_path = COALESCE(NULLIF(?, ''), local_path),
         status = ?, progress = ?, current_stage = ?, updated_at = ?, finished_at = ?
       WHERE id = ?`,
    ).run(
      job.branch ?? '',
      job.localPath ?? '',
      status,
      progress,
      currentStage,
      now,
      status === 'failed' ? now : null,
      existingId,
    )
    const updateStage = db.prepare(
      `UPDATE pipeline_stages SET status = ?, log = ?, started_at = COALESCE(?, started_at),
         finished_at = COALESCE(?, finished_at)
       WHERE pipeline_id = ? AND stage_index = ?`,
    )
    states.forEach((state, index) => {
      updateStage.run(
        state.status,
        state.log,
        state.startedAt ?? null,
        state.finishedAt ?? null,
        existingId,
        index,
      )
    })
    if (status === 'failed') {
      db.prepare(
        "UPDATE work_items SET status = '待处理', updated_at = ? WHERE id = ? AND status = '进行中'",
      ).run(now, workItem.id)
    }
  })()
  return getPipeline(db, existingId)
}

export function recordLocalDelivery(db: AppDatabase, rawInput: LocalDeliveryInput) {
  const workItemId = requiredText(rawInput.workItemId, '工作项', { max: 200 })
  const repoId = requiredText(rawInput.repoId, '代码仓库', { max: 200 })
  const deliveryJobId = optionalText(rawInput.deliveryJobId, '本机交付任务', 200)
  const outcome = oneOf(rawInput.outcome ?? 'success', '交付结果', ['success', 'failed'] as const)
  const errorMessage = optionalText(rawInput.error, '失败原因', 4_000)
  if (outcome === 'failed' && !errorMessage) throw unprocessable('失败交付必须包含失败原因')
  const stageResults = stageResultsFrom(rawInput.stageResults, outcome === 'success')
  const failedStageIndex =
    outcome === 'failed'
      ? failedStageIndexFrom(rawInput.failedStageIndex) ??
        Math.max(
          0,
          stageResults.findIndex((result) => result.status === 'failed'),
        )
      : undefined
  if (outcome === 'failed' && failedStageIndex !== undefined) {
    stageResults[failedStageIndex] = {
      ...stageResults[failedStageIndex],
      status: 'failed',
      log: errorMessage ?? '客户端交付失败',
    }
  }
  const commitInput = optionalText(rawInput.commit, '提交 SHA', 64)
  if (commitInput && !/^[0-9a-f]{7,64}$/i.test(commitInput)) {
    throw unprocessable('提交 SHA 格式不正确')
  }
  if (outcome === 'success' && !commitInput) {
    throw unprocessable('提交 SHA 不能为空')
  }
  const commit = commitInput ?? '-'
  const pushed = booleanValue(rawInput.pushed, '是否已推送', false)
  const autoCloseRequested =
    outcome === 'success' && booleanValue(rawInput.autoClose, '自动关闭缺陷', false)
  if (autoCloseRequested && (!pushed || stageResults[4].status !== 'success')) {
    throw unprocessable('自动关闭飞书缺陷要求代码已提交并推送成功')
  }
  const autoClose = autoCloseRequested
  const autoCommit =
    outcome === 'success'
      ? true
      : booleanValue(rawInput.autoCommit, '自动提交', stageResults[4].status === 'success')
  const summary = optionalText(rawInput.summary, '交付摘要', 2_000)
  const reports = reportsFrom(rawInput.reports)

  const workItem = db
    .prepare('SELECT id, type, title, branch FROM work_items WHERE id = ?')
    .get(workItemId) as
    | { id: string; type: WorkItemType; title: string; branch: string }
    | undefined
  if (!workItem) throw notFound('工作项')
  const repository = db
    .prepare('SELECT id, name, branch, local_path, latest_version FROM repositories WHERE id = ?')
    .get(repoId) as
    | {
        id: string
        name: string
        branch: string
        local_path: string
        latest_version: string
      }
    | undefined
  if (!repository) throw notFound('代码仓库')
  const branch =
    optionalText(rawInput.branch, '目标分支', 200) ||
    repository.branch ||
    workItem.branch ||
    'unknown'
  const localPath =
    optionalText(rawInput.localPath, '客户端代码路径', 1_000) ?? repository.local_path ?? ''
  if (outcome === 'success' && !localPath) {
    throw unprocessable('客户端代码路径不能为空')
  }

  const existingPipeline = deliveryJobId
    ? (db
        .prepare('SELECT id, status FROM pipelines WHERE delivery_job_id = ?')
        .get(deliveryJobId) as
        | { id: string; status: 'queued' | 'running' | 'success' | 'failed' }
        | undefined)
    : runningLocalPipelineForWorkItem(db, workItemId, repoId)
  if (existingPipeline && existingPipeline.status !== 'running') {
    return getPipeline(db, existingPipeline.id)
  }
  const pipelineId = existingPipeline?.id ?? `RUN-${nextSequence(db, 'pipeline', 2408)}`
  const now = nowIso()
  const finalStatus =
    outcome === 'success'
      ? workItem.type === 'defect' && autoClose
        ? '已关闭'
        : '已交付'
      : undefined
  const progress =
    outcome === 'success'
      ? 100
      : Math.round(
          (stageResults.filter((result) => result.status === 'success').length /
            stageDefinitions.length) *
            100,
        )
  const currentStage = outcome === 'success' ? 9 : failedStageIndex ?? 0

  db.transaction(() => {
    if (existingPipeline) {
      db.prepare(
        `UPDATE pipelines SET
           repo_name = ?, branch = ?, local_path = ?, commit_hash = ?, version = ?,
           status = ?, progress = ?, current_stage = ?, triggered_by = ?,
           auto_commit = ?, auto_close = ?, simulation = 0, updated_at = ?, finished_at = ?
         WHERE id = ?`,
      ).run(
        repository.name,
        branch,
        localPath,
        commit,
        repository.latest_version,
        outcome,
        progress,
        currentStage,
        CLIENT_DELIVERY_TRIGGER,
        autoCommit ? 1 : 0,
        autoClose ? 1 : 0,
        now,
        now,
        pipelineId,
      )
    } else {
      db.prepare(
        `INSERT INTO pipelines
          (id, work_item_id, title, item_type, repo_id, repo_name, branch, local_path,
           delivery_job_id, commit_hash, version, status, progress, current_stage, triggered_by,
           auto_commit, auto_close, simulation, created_at, updated_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).run(
        pipelineId,
        workItem.id,
        workItem.title,
        workItem.type,
        repository.id,
        repository.name,
        branch,
        localPath,
        deliveryJobId ?? null,
        commit,
        repository.latest_version,
        outcome,
        progress,
        currentStage,
        CLIENT_DELIVERY_TRIGGER,
        autoCommit ? 1 : 0,
        autoClose ? 1 : 0,
        now,
        now,
        now,
        now,
      )
    }

    const insertStage = db.prepare(
      `INSERT INTO pipeline_stages
        (pipeline_id, stage_index, stage_key, name, description, status, duration, log, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, '客户端本地', ?, ?, ?)
       ON CONFLICT(pipeline_id, stage_index) DO UPDATE SET
         status = excluded.status,
         duration = excluded.duration,
         log = excluded.log,
         started_at = excluded.started_at,
         finished_at = excluded.finished_at`,
    )
    stageDefinitions.forEach((stage, index) => {
      const result = stageResults[index]
      const log = index === 4 && result.status === 'success'
        ? `已创建本地提交 ${commit}${pushed ? `，已推送至 origin/${branch}` : '，尚未推送'}`
        : index === 8 && result.status === 'success' && summary
          ? summary
          : result.log
      insertStage.run(
        pipelineId,
        index,
        stage.key,
        stage.name,
        stage.description,
        result.status,
        log,
        now,
        now,
      )
    })

    if (reports.design) insertLocalReport(db, pipelineId, 'design', reports.design, now)
    if (reports.integration) insertLocalReport(db, pipelineId, 'integration', reports.integration, now)
    for (const artifact of reports.artifacts) {
      insertLocalReport(db, pipelineId, artifact.kind, artifact, now)
    }

    if (finalStatus) {
      db.prepare('UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?').run(
        finalStatus,
        now,
        workItem.id,
      )
      db.prepare('UPDATE repositories SET last_sync = ?, updated_at = ? WHERE id = ?').run(
        now,
        now,
        repository.id,
      )
      if (finalStatus === '已关闭') enqueueFeishuCloseOutbox(db, workItem.id)
    } else {
      db.prepare(
        "UPDATE work_items SET status = '待处理', updated_at = ? WHERE id = ? AND status = '进行中'",
      ).run(now, workItem.id)
    }
  })()

  return getPipeline(db, pipelineId)
}
