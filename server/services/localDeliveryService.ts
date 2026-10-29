import type { AppDatabase } from '../db/database.js'
import { nextSequence } from '../db/sequences.js'
import { notFound, unprocessable } from '../domain/errors.js'
import { nowIso } from '../domain/time.js'
import type { WorkItemType } from '../domain/types.js'
import { booleanValue, optionalText, requiredText } from '../domain/validation.js'
import { enqueueFeishuCloseOutbox } from './feishuIntegrationService.js'
import { getPipeline, stageDefinitions } from './pipelineService.js'

export interface LocalDeliveryInput {
  workItemId?: unknown
  repoId?: unknown
  branch?: unknown
  localPath?: unknown
  commit?: unknown
  autoClose?: unknown
  pushed?: unknown
  summary?: unknown
}

export function recordLocalDelivery(db: AppDatabase, rawInput: LocalDeliveryInput) {
  const workItemId = requiredText(rawInput.workItemId, '工作项', { max: 200 })
  const repoId = requiredText(rawInput.repoId, '代码仓库', { max: 200 })
  const branch = requiredText(rawInput.branch, '目标分支', { max: 200 })
  const localPath = requiredText(rawInput.localPath, '客户端代码路径', { max: 1_000 })
  const commit = requiredText(rawInput.commit, '提交 SHA', { max: 64 })
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw unprocessable('提交 SHA 格式不正确')
  const autoClose = booleanValue(rawInput.autoClose, '自动关闭缺陷', false)
  const pushed = booleanValue(rawInput.pushed, '是否已推送', false)
  const summary = optionalText(rawInput.summary, '交付摘要', 2_000)

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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', 100, 9, '客户端本地交付', 1, ?, 0, ?, ?, ?, ?)`,
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
      autoClose ? 1 : 0,
      now,
      now,
      now,
      now,
    )

    const insertStage = db.prepare(
      `INSERT INTO pipeline_stages
        (pipeline_id, stage_index, stage_key, name, description, status, duration, log, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, 'success', '客户端本地', ?, ?, ?)`,
    )
    stageDefinitions.forEach((stage, index) => {
      const log = index === 4
        ? `客户端本地提交 ${commit}${pushed ? `，已推送至 origin/${branch}` : '，尚未推送'}`
        : index === 8
          ? summary || '客户端本地测试与报告归档完成'
          : `客户端本地执行完成：${stage.description}`
      insertStage.run(
        pipelineId,
        index,
        stage.key,
        stage.name,
        stage.description,
        log,
        now,
        now,
      )
    })

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
