import type { AppDatabase } from '../db/database.js'
import { nextSequence } from '../db/sequences.js'
import { notFound, unprocessable } from '../domain/errors.js'
import { nowIso } from '../domain/time.js'
import type { WorkItemType } from '../domain/types.js'
import { booleanValue, optionalText, requiredText } from '../domain/validation.js'
import { enqueueFeishuCloseOutbox } from './feishuIntegrationService.js'
import {
  CLIENT_DELIVERY_TRIGGER,
  getPipeline,
  stageDefinitions,
} from './pipelineService.js'

export interface LocalDeliveryInput {
  workItemId?: unknown
  repoId?: unknown
  branch?: unknown
  localPath?: unknown
  commit?: unknown
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
  title: string
  summary: string
  content: string
}

function stageResultsFrom(value: unknown): LocalDeliveryStageResult[] {
  const defaults = stageDefinitions.map((_stage, index) => ({
    index,
    status: 'pending' as const,
    log: '未检测到真实执行证据，本阶段未执行',
  }))
  if (!Array.isArray(value)) {
    throw unprocessable('缺少客户端阶段证据，不能记录交付成功')
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

function reportFrom(value: unknown): LocalDeliveryReport | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const title = typeof record.title === 'string' ? record.title.trim().slice(0, 200) : ''
  const summary = typeof record.summary === 'string' ? record.summary.trim().slice(0, 2_000) : ''
  const content = typeof record.content === 'string' ? record.content.trim().slice(0, 256 * 1024) : ''
  if (!title || !summary || !content) return undefined
  return { title, summary, content }
}

function reportsFrom(value: unknown): { design?: LocalDeliveryReport; integration?: LocalDeliveryReport } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  return {
    design: reportFrom(record.design),
    integration: reportFrom(record.integration),
  }
}

function insertLocalReport(
  db: AppDatabase,
  pipelineId: string,
  kind: 'design' | 'integration',
  report: LocalDeliveryReport,
  now: string,
): void {
  const suffix = pipelineId.replace('RUN-', '')
  const id = `${kind === 'design' ? 'DESIGN' : 'INTEGRATION'}-${suffix}`
  db.prepare(
    `INSERT INTO pipeline_reports (id, pipeline_id, kind, title, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, pipelineId, kind, report.title, report.summary, now)
  db.prepare(
    `INSERT INTO pipeline_report_sections (report_id, section_index, title, content)
     VALUES (?, 0, '报告正文', ?)`,
  ).run(id, report.content)
}

export function recordLocalDelivery(db: AppDatabase, rawInput: LocalDeliveryInput) {
  const workItemId = requiredText(rawInput.workItemId, '工作项', { max: 200 })
  const repoId = requiredText(rawInput.repoId, '代码仓库', { max: 200 })
  const branch = requiredText(rawInput.branch, '目标分支', { max: 200 })
  const localPath = requiredText(rawInput.localPath, '客户端代码路径', { max: 1_000 })
  const commit = requiredText(rawInput.commit, '提交 SHA', { max: 64 })
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw unprocessable('提交 SHA 格式不正确')
  const stageResults = stageResultsFrom(rawInput.stageResults)
  const autoCloseRequested = booleanValue(rawInput.autoClose, '自动关闭缺陷', false)
  if (autoCloseRequested && stageResults[7].status !== 'success') {
    throw unprocessable('测试阶段没有真实证据，不能自动关闭缺陷')
  }
  const autoClose = autoCloseRequested
  const pushed = booleanValue(rawInput.pushed, '是否已推送', false)
  const summary = optionalText(rawInput.summary, '交付摘要', 2_000)
  const reports = reportsFrom(rawInput.reports)

  const workItem = db
    .prepare('SELECT id, type, title FROM work_items WHERE id = ?')
    .get(workItemId) as { id: string; type: WorkItemType; title: string } | undefined
  if (!workItem) throw notFound('工作项')
  const repository = db
    .prepare('SELECT id, name, latest_version FROM repositories WHERE id = ?')
    .get(repoId) as { id: string; name: string; latest_version: string } | undefined
  if (!repository) throw notFound('代码仓库')

  const pipelineId = `RUN-${nextSequence(db, 'pipeline', 2408)}`
  const now = nowIso()
  const finalStatus = workItem.type === 'defect' && autoClose ? '已关闭' : '已交付'

  db.transaction(() => {
    db.prepare(
      `INSERT INTO pipelines
        (id, work_item_id, title, item_type, repo_id, repo_name, branch, local_path,
         commit_hash, version, status, progress, current_stage, triggered_by, auto_commit,
         auto_close, simulation, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', 100, 9, ?, 1, ?, 0, ?, ?, ?, ?)`,
    ).run(
      pipelineId,
      workItem.id,
      workItem.title,
      workItem.type,
      repository.id,
      repository.name,
      branch,
      localPath,
      commit,
      repository.latest_version,
      CLIENT_DELIVERY_TRIGGER,
      autoClose ? 1 : 0,
      now,
      now,
      now,
      now,
    )

    const insertStage = db.prepare(
      `INSERT INTO pipeline_stages
        (pipeline_id, stage_index, stage_key, name, description, status, duration, log, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, '客户端本地', ?, ?, ?)`,
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
  })()

  return getPipeline(db, pipelineId)
}
