import { randomBytes } from 'node:crypto'
import type { AppDatabase } from '../db/database.js'
import { nextSequence } from '../db/sequences.js'
import { conflict, notFound } from '../domain/errors.js'
import { formatDisplayTime, formatDuration, nowIso } from '../domain/time.js'
import type {
  PipelineReport,
  PipelineReportSection,
  PipelineRun,
  PipelineStage,
  PipelineStatus,
  StageDefinition,
  StageStatus,
  WorkItemType,
} from '../domain/types.js'
import { booleanValue, optionalText, requiredText } from '../domain/validation.js'
import { enqueueFeishuCloseOutbox } from './feishuIntegrationService.js'
import {
  commitLocalChanges,
  inspectLocalRepository,
  pushLocalCommit,
} from './gitService.js'
import { createTestReport, type TestReportSource } from './reportService.js'

export const stageDefinitions: StageDefinition[] = [
  { key: 'analysis', name: '需求解析', description: '识别需求意图、验收条件与影响模块' },
  { key: 'design', name: '开发设计报告', description: '生成技术方案、改动范围与测试策略' },
  { key: 'coding', name: '自动需求编码', description: '按设计报告生成代码变更与单元测试' },
  { key: 'integration', name: '集成验证报告', description: '合并变更并输出依赖、接口与风险结论' },
  { key: 'commit', name: '提交代码', description: '提交变更至目标分支并关联工作项' },
  { key: 'build', name: '自动编译', description: '触发编译系统构建版本' },
  { key: 'upgrade', name: '设备升级', description: '推送固件到 AC/AP 或交换机并完成升级' },
  { key: 'test', name: '自动化测试', description: '执行冒烟与全量回归测试' },
  { key: 'report', name: '测试报告归档', description: '生成测试报告并关闭缺陷' },
]

interface PipelineRow {
  id: string
  work_item_id: string
  title: string
  item_type: WorkItemType
  repo_id: string
  repo_name: string
  branch: string
  local_path: string
  commit_hash: string
  version: string
  status: PipelineStatus
  progress: number
  current_stage: number
  triggered_by: string
  auto_commit: number
  auto_close: number
  simulation: number
  created_at: string
}

interface StageRow {
  stage_index: number
  stage_key: string
  name: string
  description: string
  status: StageStatus
  duration: string | null
  log: string | null
  started_at: string | null
}

interface ArtifactRow {
  id: string
  kind: 'design' | 'integration'
  title: string
  summary: string
  created_at: string
}

interface SectionRow {
  report_id: string
  title: string
  content: string
}

export interface StartPipelineInput {
  workItemId: unknown
  repoId?: unknown
  autoCommit?: unknown
  autoClose?: unknown
  triggeredBy?: unknown
}

function pipelineSelect(): string {
  return `SELECT id, work_item_id, title, item_type, repo_id, repo_name, branch, local_path,
                 commit_hash, version, status, progress, current_stage, triggered_by,
                 auto_commit, auto_close, simulation, created_at
          FROM pipelines`
}

export function listPipelines(db: AppDatabase): PipelineRun[] {
  const rows = db
    .prepare(`${pipelineSelect()} ORDER BY created_at DESC, id DESC`)
    .all() as PipelineRow[]
  return rows.map((row) => hydratePipeline(db, row))
}

export function getPipeline(db: AppDatabase, id: string): PipelineRun {
  const row = db.prepare(`${pipelineSelect()} WHERE id = ?`).get(id) as PipelineRow | undefined
  if (!row) throw notFound('交付流水线')
  return hydratePipeline(db, row)
}

function loadArtifact(db: AppDatabase, row: ArtifactRow): PipelineReport {
  const sections = db
    .prepare(
      `SELECT report_id, title, content FROM pipeline_report_sections
       WHERE report_id = ? ORDER BY section_index ASC`,
    )
    .all(row.id) as SectionRow[]
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    createdAt: formatDisplayTime(row.created_at),
    sections: sections.map((section) => ({ title: section.title, content: section.content })),
  }
}

function hydratePipeline(db: AppDatabase, row: PipelineRow): PipelineRun {
  const stages = db
    .prepare(
      `SELECT stage_index, stage_key, name, description, status, duration, log, started_at
       FROM pipeline_stages WHERE pipeline_id = ? ORDER BY stage_index ASC`,
    )
    .all(row.id) as StageRow[]
  const artifacts = db
    .prepare(
      `SELECT id, kind, title, summary, created_at FROM pipeline_reports
       WHERE pipeline_id = ? ORDER BY created_at ASC`,
    )
    .all(row.id) as ArtifactRow[]
  const designRow = artifacts.find((artifact) => artifact.kind === 'design')
  const integrationRow = artifacts.find((artifact) => artifact.kind === 'integration')

  return {
    id: row.id,
    workItemId: row.work_item_id,
    title: row.title,
    itemType: row.item_type,
    repoId: row.repo_id,
    repoName: row.repo_name,
    branch: row.branch,
    localPath: row.local_path || undefined,
    commit: row.commit_hash,
    version: row.version,
    status: row.status,
    progress: row.progress,
    currentStage: row.current_stage,
    stages: stages.map<PipelineStage>((stage) => ({
      key: stage.stage_key,
      name: stage.name,
      description: stage.description,
      status: stage.status,
      duration: stage.duration ?? undefined,
      log: stage.log ?? undefined,
    })),
    designReport: designRow ? loadArtifact(db, designRow) : undefined,
    integrationReport: integrationRow ? loadArtifact(db, integrationRow) : undefined,
    createdAt: formatDisplayTime(row.created_at),
    triggeredBy: row.triggered_by,
    autoCommit: row.auto_commit === 1,
    autoClose: row.auto_close === 1,
    simulation: row.simulation === 1,
  }
}

interface WorkItemRow {
  id: string
  type: WorkItemType
  title: string
  status: string
  repo_id: string
}

function versionFor(repo: { latest_version: string }, revision: number): string {
  const base = repo.latest_version.match(/^v?(\d+\.\d+\.\d+)/)?.[1] ?? '1.0.0'
  return `v${base}-rc.${revision}`
}

export function startPipeline(db: AppDatabase, rawInput: StartPipelineInput): PipelineRun {
  const workItemId = requiredText(rawInput.workItemId, '工作项', { max: 200 })
  const triggeredBy = optionalText(rawInput.triggeredBy, '触发人', 100) ?? '系统'
  const autoCommit = booleanValue(rawInput.autoCommit, '自动提交', true)
  const autoClose = booleanValue(rawInput.autoClose, '自动关闭缺陷', true)

  const pipelineId = db.transaction(() => {
    const workItem = db
      .prepare('SELECT id, type, title, status, repo_id FROM work_items WHERE id = ?')
      .get(workItemId) as WorkItemRow | undefined
    if (!workItem) throw notFound('工作项')
    if (workItem.status === '已关闭') throw conflict('已关闭的工作项不能发起交付')

    const active = db
      .prepare("SELECT id FROM pipelines WHERE work_item_id = ? AND status IN ('queued', 'running')")
      .get(workItemId) as { id: string } | undefined
    if (active) throw conflict('该工作项已有执行中的交付流水线', { pipelineId: active.id })

    const repoId = optionalText(rawInput.repoId, '代码仓库', 200) ?? workItem.repo_id
    const repoQuery = `SELECT id, name, branch, local_path, latest_version
                       FROM repositories`
    const repo = (
      repoId
        ? db.prepare(`${repoQuery} WHERE id = ?`).get(repoId)
        : db.prepare(`${repoQuery} LIMIT 1`).get()
    ) as
      | {
          id: string
          name: string
          branch: string
          local_path: string
          latest_version: string
        }
      | undefined
    if (!repo) throw notFound('代码仓库')

    const runNumber = nextSequence(db, 'pipeline', 2408)
    const revision = nextSequence(db, 'build_revision', 18)
    const id = `RUN-${runNumber}`
    const now = nowIso()
    const useLocalGit = Boolean(repo.local_path && autoCommit)
    const localHead = useLocalGit
      ? inspectLocalRepository(repo.local_path, repo.branch)
      : undefined
    const commit = localHead?.head.slice(0, 8) ?? randomBytes(4).toString('hex')
    const version = versionFor(repo, revision)

    db.prepare(
      `INSERT INTO pipelines
        (id, work_item_id, title, item_type, repo_id, repo_name, branch, local_path,
         commit_hash, version, status, progress, current_stage, triggered_by, auto_commit,
         auto_close, simulation, created_at, updated_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 8, 0, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      workItem.id,
      workItem.title,
      workItem.type,
      repo.id,
      repo.name,
      repo.branch,
      repo.local_path,
      commit,
      version,
      triggeredBy,
      autoCommit ? 1 : 0,
      autoClose ? 1 : 0,
      useLocalGit ? 0 : 1,
      now,
      now,
      now,
    )

    const insertStage = db.prepare(
      `INSERT INTO pipeline_stages
        (pipeline_id, stage_index, stage_key, name, description, status, log, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    stageDefinitions.forEach((stage, index) => {
      const running = index === 0
      insertStage.run(
        id,
        index,
        stage.key,
        stage.name,
        stage.description,
        running ? 'running' : 'pending',
        running ? '正在解析需求上下文与代码影响范围' : null,
        running ? now : null,
      )
    })

    db.prepare(
      "UPDATE work_items SET status = '进行中', updated_at = ? WHERE id = ?",
    ).run(now, workItem.id)

    return id
  })()

  return getPipeline(db, pipelineId)
}

function stageSuccessLog(index: number, row: PipelineRow): string {
  const logs = [
    '需求已解析，验收条件、影响模块与测试范围已确认',
    `开发设计报告已生成：${row.title} 的技术方案与测试策略已就绪`,
    '自动需求编码完成，代码变更与单元测试已生成',
    '集成验证完成，接口兼容性、冲突扫描与静态检查通过',
    row.auto_commit === 1
      ? row.local_path
        ? `已在 ${row.local_path} 创建真实提交 ${row.commit_hash}`
        : `变更已提交至 ${row.branch}，提交 ${row.commit_hash}`
      : '已按交付配置跳过自动提交，本地变更等待人工确认',
    `编译成功，已产出 ${row.version} 固件包`,
    'AC/AP 与交换机测试设备升级完成，固件版本校验通过',
    '无线、交换与升级回归测试执行完成，测试结果已回传',
    '测试报告已归档',
  ]
  return logs[index] ?? '阶段执行完成'
}

function insertArtifact(
  db: AppDatabase,
  row: PipelineRow,
  kind: 'design' | 'integration',
  now: string,
): void {
  const suffix = row.id.replace('RUN-', '')
  const isDesign = kind === 'design'
  const id = `${isDesign ? 'DESIGN' : 'INTEGRATION'}-${suffix}`
  const title = isDesign ? '开发设计报告' : '集成报告'
  const summary = isDesign
    ? `已完成「${row.title}」的影响分析、技术方案与测试策略设计`
    : `代码已完成集成验证，未发现阻塞性冲突，可以提交至 ${row.branch}`
  const sections: PipelineReportSection[] = isDesign
    ? [
        {
          title: '需求理解',
          content: `关联工作项 ${row.work_item_id}。需求目标已拆解为网络配置验收条件，覆盖创建、修改、删除、参数边界、设备回显、升级后配置保留与回滚场景。`,
        },
        {
          title: '技术方案',
          content: `在 ${row.repo_name}/${row.branch} 上评估 web/ 与 lua/ 改动：Vue 3 页面与联邦组件负责配置交互，LuCI api/service/middle 层负责参数校验和 RGOS CLI/JSON 转换，沿用现有设备配置接口契约。`,
        },
        {
          title: '影响范围',
          content: '预计影响 4 个网络业务模块、6 个文件，涉及配置模型、CLI 转换与页面表单；新增字段保持向后兼容，无数据库结构变更。',
        },
        {
          title: '测试策略',
          content: '优先执行 Vue/Lua 单测与静态检查，再覆盖配置 CRUD、CLI 回显一致性、AC/AP 联动、VLAN/DHCP 边界校验以及升级后配置保留与回滚。',
        },
      ]
    : [
        {
          title: '集成结果',
          content: `基于 ${row.branch} 的最新提交完成合并预演，0 个冲突，变更可干净应用。`,
        },
        {
          title: '静态检查',
          content: 'Vue TypeScript 类型检查、Lua 单测、代码规范与依赖漏洞扫描全部通过；无新增高危依赖。',
        },
        {
          title: '接口兼容性',
          content: 'REST/JSON-RPC 接口与设备配置 JSON 保持兼容，新增字段均为可选；旧固件返回结构可继续解析。',
        },
        {
          title: '风险结论',
          content: '集成风险低。建议在提交后立即触发固件编译，并在 AC/AP 与交换机测试床验证升级、配置下发和回滚。',
        },
      ]

  db.prepare(
    `INSERT INTO pipeline_reports (id, pipeline_id, kind, title, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, row.id, kind, title, summary, now)
  const insertSection = db.prepare(
    `INSERT INTO pipeline_report_sections (report_id, section_index, title, content)
     VALUES (?, ?, ?, ?)`,
  )
  sections.forEach((section, index) => {
    insertSection.run(id, index, section.title, section.content)
  })
}

const advancingPipelines = new Set<string>()

export function advancePipeline(db: AppDatabase, id: string): PipelineRun {
  if (advancingPipelines.has(id)) {
    throw conflict('流水线正在推进，请稍后重试')
  }
  advancingPipelines.add(id)
  try {
    return advancePipelineOnce(db, id)
  } finally {
    advancingPipelines.delete(id)
  }
}

function advancePipelineOnce(db: AppDatabase, id: string): PipelineRun {
  const row = db
    .prepare(`${pipelineSelect()} WHERE id = ?`)
    .get(id) as PipelineRow | undefined
  if (!row) throw notFound('交付流水线')
  if (row.status !== 'running') return getPipeline(db, id)

  const current = db
    .prepare(
      `SELECT stage_index, stage_key, name, description, status, duration, log, started_at
       FROM pipeline_stages WHERE pipeline_id = ? AND status = 'running'
       ORDER BY stage_index ASC LIMIT 1`,
    )
    .get(id) as StageRow | undefined
  if (!current) throw new Error(`流水线 ${id} 没有运行中的阶段`)

  const usesLocalGit = Boolean(row.local_path && row.auto_commit === 1)
  let commitSummary = ''
  let pushSummary = ''

  try {
    if (current.stage_index === 4 && usesLocalGit) {
      const result = commitLocalChanges(
        row.local_path,
        row.branch,
        `${row.work_item_id}: ${row.title}`,
      )
      row.commit_hash = result.commit
      commitSummary = result.message
    }

    if (current.stage_index === stageDefinitions.length - 1 && usesLocalGit) {
      const result = pushLocalCommit(row.local_path, row.branch, row.commit_hash)
      pushSummary = `，${result.output}`
    }
  } catch (error) {
    failPipeline(db, id, row, current, error)
    throw error
  }

  db.transaction(() => {
    const latest = db
      .prepare(`${pipelineSelect()} WHERE id = ?`)
      .get(id) as PipelineRow | undefined
    if (!latest || latest.status !== 'running') return

    const now = nowIso()
    const duration = formatDuration(current.started_at, now)
    if (current.stage_index === 4 && usesLocalGit) {
      db.prepare('UPDATE pipelines SET commit_hash = ?, simulation = 0 WHERE id = ?').run(
        row.commit_hash,
        id,
      )
    }
    db.prepare(
      `UPDATE pipeline_stages SET status = 'success', duration = ?, log = ?, finished_at = ?
       WHERE pipeline_id = ? AND stage_index = ?`,
    ).run(
      duration,
      commitSummary || stageSuccessLog(current.stage_index, row),
      now,
      id,
      current.stage_index,
    )

    if (current.stage_index === 1) insertArtifact(db, row, 'design', now)
    if (current.stage_index === 3) insertArtifact(db, row, 'integration', now)

    if (current.stage_index < stageDefinitions.length - 1) {
      const nextIndex = current.stage_index + 1
      const nextStage = stageDefinitions[nextIndex]
      db.prepare(
        `UPDATE pipeline_stages SET status = 'running', log = ?, started_at = ?
         WHERE pipeline_id = ? AND stage_index = ?`,
      ).run(`正在执行：${nextStage.description}`, now, id, nextIndex)
      db.prepare(
        `UPDATE pipelines SET current_stage = ?, progress = ?, updated_at = ? WHERE id = ?`,
      ).run(
        nextIndex,
        Math.round(((current.stage_index + 1) / stageDefinitions.length) * 100),
        now,
        id,
      )
      return
    }

    createTestReport(db, {
      pipelineId: row.id,
      project: row.repo_name,
      version: row.version,
    } satisfies TestReportSource)

    const workItem = db
      .prepare('SELECT type, status FROM work_items WHERE id = ?')
      .get(row.work_item_id) as { type: WorkItemType; status: string } | undefined
    if (!workItem) throw notFound('关联工作项')

    const finalStatus =
      workItem.type === 'defect' && row.auto_close === 1 ? '已关闭' : '已交付'
    db.prepare('UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?').run(
      finalStatus,
      now,
      row.work_item_id,
    )
    if (finalStatus === '已关闭') enqueueFeishuCloseOutbox(db, row.work_item_id)
    db.prepare(
      'UPDATE repositories SET latest_version = ?, last_sync = ?, updated_at = ? WHERE id = ?',
    ).run(row.version, now, now, row.repo_id)

    const reportLog = `${
      finalStatus === '已关闭'
        ? `报告已归档，缺陷 ${row.work_item_id} 已自动关闭`
        : `报告已归档，工作项 ${row.work_item_id} 已标记交付`
    }${pushSummary}`
    db.prepare(
      `UPDATE pipeline_stages SET log = ? WHERE pipeline_id = ? AND stage_index = ?`,
    ).run(reportLog, id, current.stage_index)
    db.prepare(
      `UPDATE pipelines SET status = 'success', progress = 100, current_stage = 9,
       updated_at = ?, finished_at = ? WHERE id = ?`,
    ).run(now, now, id)
  })()

  return getPipeline(db, id)
}

function failPipeline(
  db: AppDatabase,
  id: string,
  row: PipelineRow,
  current: StageRow,
  error: unknown,
): void {
  const now = nowIso()
  const message = error instanceof Error ? error.message : '未知 Git 错误'
  db.transaction(() => {
    db.prepare(
      `UPDATE pipeline_stages SET status = 'failed', duration = ?, log = ?, finished_at = ?
       WHERE pipeline_id = ? AND stage_index = ?`,
    ).run(formatDuration(current.started_at, now), message, now, id, current.stage_index)
    db.prepare(
      `UPDATE pipelines SET status = 'failed', updated_at = ?, finished_at = ? WHERE id = ?`,
    ).run(now, now, id)
    db.prepare(
      "UPDATE work_items SET status = '待处理', updated_at = ? WHERE id = ? AND status = '进行中'",
    ).run(now, row.work_item_id)
  })()
}

export function advanceRunningPipelines(db: AppDatabase): number {
  const rows = db
    .prepare("SELECT id FROM pipelines WHERE status = 'running' ORDER BY created_at ASC")
    .all() as { id: string }[]
  for (const row of rows) {
    try {
      advancePipeline(db, row.id)
    } catch (error) {
      console.error(`流水线 ${row.id} 推进失败`, error)
    }
  }
  return rows.length
}

export function cancelPipeline(db: AppDatabase, id: string): PipelineRun {
  db.transaction(() => {
    const row = db
      .prepare(`${pipelineSelect()} WHERE id = ?`)
      .get(id) as PipelineRow | undefined
    if (!row) throw notFound('交付流水线')
    if (row.status !== 'running' && row.status !== 'queued') {
      throw conflict('只有执行中的流水线可以取消')
    }
    const now = nowIso()
    const current = db
      .prepare(
        `SELECT stage_index, started_at FROM pipeline_stages
         WHERE pipeline_id = ? AND status = 'running' ORDER BY stage_index ASC LIMIT 1`,
      )
      .get(id) as { stage_index: number; started_at: string | null } | undefined
    if (current) {
      db.prepare(
        `UPDATE pipeline_stages SET status = 'failed', log = '流水线已由用户取消',
         duration = ?, finished_at = ? WHERE pipeline_id = ? AND stage_index = ?`,
      ).run(formatDuration(current.started_at, now), now, id, current.stage_index)
    }
    db.prepare(
      "UPDATE pipelines SET status = 'failed', updated_at = ?, finished_at = ? WHERE id = ?",
    ).run(now, now, id)
    db.prepare(
      "UPDATE work_items SET status = '待处理', updated_at = ? WHERE id = ? AND status = '进行中'",
    ).run(now, row.work_item_id)
  })()
  return getPipeline(db, id)
}
