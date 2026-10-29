import {
  AlertTriangle,
  ArrowRight,
  Box,
  Check,
  CheckCircle2,
  ChevronRight,
  CirclePlay,
  Clock3,
  Code2,
  FileBarChart2,
  FileText,
  FolderGit2,
  GitBranch,
  GitCommit,
  GitMerge,
  LoaderCircle,
  RefreshCw,
  Rocket,
  Search,
  ServerCog,
  Smartphone,
  Sparkles,
  Terminal,
  TestTube2,
  TimerReset,
  UserRound,
  Workflow,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { DeliveryDialog } from '../components/DeliveryDialog'
import { PipelineSteps } from '../components/PipelineSteps'
import { Modal, StatusBadge } from '../components/ui'
import { averageDuration } from '../duration'
import { useData } from '../store'
import type { PageKey, PipelineReport, PipelineRun, PipelineStage } from '../types'

type RunFilter = 'all' | 'running' | 'success' | 'failed'

const stageIcons: Record<string, ReactNode> = {
  analysis: <Sparkles size={16} />,
  design: <FileText size={16} />,
  coding: <Code2 size={16} />,
  integration: <GitMerge size={16} />,
  commit: <GitCommit size={16} />,
  build: <Box size={16} />,
  upgrade: <Smartphone size={16} />,
  test: <TestTube2 size={16} />,
  report: <FileBarChart2 size={16} />,
}

function stageIcon(stage: PipelineStage) {
  if (stage.status === 'success') return <Check size={14} strokeWidth={3} />
  if (stage.status === 'failed') return <X size={14} strokeWidth={3} />
  if (stage.status === 'running') return <LoaderCircle size={14} className="spin" />
  return stageIcons[stage.key]
}

function RunListCard({
  run,
  selected,
  onClick,
}: {
  run: PipelineRun
  selected: boolean
  onClick: () => void
}) {
  return (
    <button className={`run-list-item ${selected ? 'selected' : ''}`} onClick={onClick}>
      <span className={`run-list-status run-list-status-${run.status}`}>
        {run.status === 'running' ? (
          <LoaderCircle size={15} className="spin" />
        ) : run.status === 'success' ? (
          <Check size={15} strokeWidth={3} />
        ) : run.status === 'failed' ? (
          <X size={15} strokeWidth={3} />
        ) : (
          <Clock3 size={15} />
        )}
      </span>
      <span className="run-list-content">
        <span className="run-list-top">
          <strong>{run.title}</strong>
          <small>{run.createdAt}</small>
        </span>
        <span className="run-list-meta">
          {run.id} · {run.version}
          {!run.clientExecuted ? ' · 无客户端执行证据' : ''}
        </span>
        {run.status === 'running' && (
          <span className="run-list-progress">
            <span style={{ width: `${run.progress}%` }} />
          </span>
        )}
      </span>
      <ChevronRight size={15} className="run-list-chevron" />
    </button>
  )
}

export function Pipelines({
  selectedRunId,
  onNavigate,
}: {
  selectedRunId?: string
  onNavigate: (page: PageKey, id?: string) => void
}) {
  const { pipelines, reports } = useData()
  const [filter, setFilter] = useState<RunFilter>('all')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState(selectedRunId ?? pipelines[0]?.id ?? '')
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  const [artifactReport, setArtifactReport] = useState<PipelineReport | null>(null)

  useEffect(() => {
    if (selectedRunId) setSelectedId(selectedRunId)
  }, [selectedRunId])

  const filteredRuns = useMemo(
    () =>
      pipelines.filter((run) => {
        const filterMatches = filter === 'all' || run.status === filter
        const textMatches = [
          run.title,
          run.id,
          run.workItemId,
          run.repoName,
          run.branch,
          run.localPath,
        ]
          .join(' ')
          .toLowerCase()
          .includes(search.toLowerCase())
        return filterMatches && textMatches
      }),
    [filter, pipelines, search],
  )

  const run = pipelines.find((entry) => entry.id === selectedId) ?? pipelines[0]
  const report = reports.find((entry) => entry.pipelineId === run?.id)
  const stageByKey = new Map((run?.stages ?? []).map((stage) => [stage.key, stage]))
  const commitStage = stageByKey.get('commit')
  const upgradeStage = stageByKey.get('upgrade')
  const testStage = stageByKey.get('test')
  const progressStyle = { '--progress': `${run?.progress ?? 0}%` } as CSSProperties
  const runningCount = pipelines.filter((entry) => entry.status === 'running').length
  const successCount = pipelines.filter((entry) => entry.status === 'success').length
  const failedCount = pipelines.filter((entry) => entry.status === 'failed').length
  const averageTestDuration = averageDuration(reports.map((entry) => entry.duration))

  return (
    <div className="page-enter">
      <div className="page-header">
        <div>
          <span className="eyebrow">
            <Workflow size={13} /> DELIVERY PIPELINE
          </span>
          <h1>交付流水线</h1>
          <p>实时跟踪网络设备业务从设计与编码、固件构建，到 AC/AP、交换机升级和自动化测试的完整链路。</p>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-secondary" onClick={() => setFilter('running')}>
            <CirclePlay size={16} /> 运行中 {runningCount}
          </button>
          <button className="btn btn-primary" onClick={() => setDeliveryOpen(true)}>
            <Rocket size={16} /> 启动交付
          </button>
        </div>
      </div>

      <div className="pipeline-stats-row">
        <div><span className="dot-blue" /><small>执行中</small><strong>{runningCount}</strong></div>
        <div><span className="dot-green" /><small>累计成功</small><strong>{successCount}</strong></div>
        <div><span className="dot-red" /><small>累计失败</small><strong>{failedCount}</strong></div>
        <div><TimerReset size={15} /><small>平均测试耗时</small><strong>{averageTestDuration}</strong></div>
        <div className="pipeline-live-note"><span className="online-dot" /> 实时更新中</div>
      </div>

      <div className="pipeline-layout">
        <aside className="card run-list-panel">
          <div className="run-list-panel-head">
            <div>
              <h2>执行记录</h2>
              <p>{pipelines.length} 条流水线</p>
            </div>
            <button className="icon-btn" aria-label="刷新"><RefreshCw size={16} /></button>
          </div>
          <label className="toolbar-search run-search">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索流水线"
            />
          </label>
          <div className="run-filters">
            {([
              ['all', '全部'],
              ['running', '执行中'],
              ['success', '成功'],
              ['failed', '失败'],
            ] as const).map(([key, label]) => (
              <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>
                {label}
              </button>
            ))}
          </div>
          <div className="run-list">
            {filteredRuns.map((item) => (
              <RunListCard
                key={item.id}
                run={item}
                selected={item.id === run?.id}
                onClick={() => setSelectedId(item.id)}
              />
            ))}
            {filteredRuns.length === 0 && <div className="run-list-empty">没有匹配的流水线</div>}
          </div>
        </aside>

        {run && (
          <section className="pipeline-detail">
            <article className="pipeline-detail-card card">
              {(run.simulation || !run.clientExecuted) && (
                <div className="feishu-live-warning" style={{ marginBottom: 14 }}>
                  <AlertTriangle size={15} />
                  <span>
                    {run.clientExecuted
                      ? '这是服务端模拟记录，没有真实执行 Codex、构建、设备升级或测试。请重新使用“一键本机执行”发起真实交付。'
                      : '这是旧版服务端流水线，没有客户端 Codex 执行与代码变更证据；即使阶段显示成功，也不能视为真实交付。请重新使用“一键本机执行”。'}
                  </span>
                </div>
              )}
              <div className="pipeline-detail-head">
                <div>
                  <div className="pipeline-detail-meta-top">
                    <span className={`live-pill ${run.status === 'running' ? '' : 'live-pill-idle'}`}>
                      <span className="live-dot" /> {run.status === 'running' ? 'LIVE' : run.status.toUpperCase()}
                    </span>
                    <span>{run.id}</span>
                    <span>·</span>
                    <span>{run.itemType === 'defect' ? '缺陷修复' : '需求交付'}</span>
                  </div>
                  <h2>{run.title}</h2>
                  <div className="pipeline-detail-submeta">
                    <span><GitBranch size={13} /> {run.repoName} / {run.branch}</span>
                    <span><GitCommit size={13} /> {run.commit}</span>
                    <span><UserRound size={13} /> {run.triggeredBy} 发起</span>
                  </div>
                </div>
                <div className="pipeline-head-actions">
                  <StatusBadge status={run.status} />
                  {run.designReport && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setArtifactReport(run.designReport ?? null)}
                    >
                      <FileText size={15} /> 设计报告
                    </button>
                  )}
                  {run.integrationReport && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setArtifactReport(run.integrationReport ?? null)}
                    >
                      <GitMerge size={15} /> 集成报告
                    </button>
                  )}
                  {report && (
                    <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('reports', report.id)}>
                      <FileBarChart2 size={15} /> 测试报告
                    </button>
                  )}
                  {run.status === 'failed' && (
                    <button className="btn btn-primary btn-sm" onClick={() => setDeliveryOpen(true)}>
                      <RefreshCw size={15} /> 重新执行
                    </button>
                  )}
                </div>
              </div>

              <div className="pipeline-progress-area">
                <div className="pipeline-progress-label">
                  <span>
                    {run.status === 'running'
                      ? `正在执行 · ${run.stages.find((stage) => stage.status === 'running')?.name ?? '即将完成'}`
                      : run.status === 'success'
                        ? !run.clientExecuted
                          ? '旧版服务端记录，无客户端代码执行证据'
                          : run.stages.some((stage) => stage.status === 'pending')
                            ? '代码交付已完成，未取得证据的阶段未执行'
                            : '所有阶段已完成'
                        : run.status === 'failed'
                          ? '流水线执行中断'
                          : '等待执行'}
                  </span>
                  <strong>{run.progress}%</strong>
                </div>
                <div className={`pipeline-progress-track pipeline-progress-${run.status}`}>
                  <span style={progressStyle} />
                </div>
              </div>

              <div className="pipeline-steps-detail">
                <PipelineSteps stages={run.stages} />
              </div>
            </article>

            <div className="pipeline-detail-grid">
              <article className="card stage-timeline-card">
                <div className="card-section-head">
                  <div>
                    <h2>执行阶段</h2>
                    <p>每个阶段的耗时与执行摘要</p>
                  </div>
                  <span className="soft-tag">
                    <ServerCog size={13} /> {run.clientExecuted ? '客户端 runner' : '旧版服务端记录'}
                  </span>
                </div>
                <div className="stage-timeline">
                  {run.stages.map((stage, index) => (
                    <div className={`stage-timeline-item stage-${stage.status}`} key={stage.key}>
                      <div className="stage-timeline-main">
                        <span className="stage-icon-circle">{stageIcon(stage)}</span>
                        <div className="stage-timeline-copy">
                          <div>
                            <strong>{stage.name}</strong>
                            <span className={`stage-status-label stage-status-${stage.status}`}>
                              {stage.status === 'success'
                                ? '已完成'
                                : stage.status === 'running'
                                  ? '执行中'
                                  : stage.status === 'failed'
                                    ? '失败'
                                    : '待执行'}
                            </span>
                          </div>
                          <p>{stage.log ?? stage.description}</p>
                          {(stage.duration || stage.status === 'running') && (
                            <small>
                              <Clock3 size={11} />
                              {stage.duration ?? '执行中…'}
                            </small>
                          )}
                          {stage.key === 'design' && run.designReport && (
                            <button
                              className="stage-artifact-link"
                              onClick={() => setArtifactReport(run.designReport ?? null)}
                            >
                              <FileText size={11} /> 查看开发设计报告
                            </button>
                          )}
                          {stage.key === 'integration' && run.integrationReport && (
                            <button
                              className="stage-artifact-link"
                              onClick={() => setArtifactReport(run.integrationReport ?? null)}
                            >
                              <GitMerge size={11} /> 查看集成报告
                            </button>
                          )}
                        </div>
                      </div>
                      {index < run.stages.length - 1 && <span className="stage-timeline-line" />}
                    </div>
                  ))}
                </div>
              </article>

              <div className="pipeline-side-column">
                <article className="card run-info-card">
                  <div className="card-section-head">
                    <div>
                      <h2>运行信息</h2>
                      <p>本次交付配置</p>
                    </div>
                  </div>
                  <div className="run-info-list">
                    <div><small>目标版本</small><strong className="version-strong">{run.version}</strong></div>
                    <div><small>代码仓库</small><strong>{run.repoName}</strong></div>
                    <div><small>目标分支</small><strong><GitBranch size={12} /> {run.branch}</strong></div>
                    <div>
                      <small>本地路径</small>
                      <strong className="mono run-path" title={run.localPath || '未配置'}>
                        <FolderGit2 size={12} /> {run.localPath || '未记录客户端路径'}
                      </strong>
                    </div>
                    <div><small>提交哈希</small><strong className="mono">{run.commit}</strong></div>
                    <div>
                      <small>执行模式</small>
                      <strong>
                        {run.clientExecuted
                          ? '客户端本机执行'
                          : '旧版服务端记录（无代码执行证据）'}
                      </strong>
                    </div>
                    <div><small>开始时间</small><strong>{run.createdAt}</strong></div>
                    <div><small>执行节点</small><strong>{run.clientExecuted ? '当前客户端' : '旧版服务端 runner'}</strong></div>
                  </div>
                  <div className="run-config-flags">
                    <span>
                      {commitStage?.status === 'success' ? <CheckCircle2 size={13} /> : <Clock3 size={13} />}
                      {commitStage?.status === 'success' ? '本地提交已创建' : '提交阶段未完成'}
                    </span>
                    <span>
                      {upgradeStage?.status === 'success' ? <CheckCircle2 size={13} /> : <Clock3 size={13} />}
                      {upgradeStage?.status === 'success' ? '设备升级有证据' : '设备升级未执行'}
                    </span>
                    <span>
                      {testStage?.status === 'success' ? <CheckCircle2 size={13} /> : <Clock3 size={13} />}
                      {testStage?.status === 'success'
                        ? run.autoClose
                          ? '测试有证据，缺陷自动关闭'
                          : '测试有证据，缺陷人工关闭'
                        : '测试未执行'}
                    </span>
                  </div>
                </article>

                {report ? (
                  <article className="card report-mini-card">
                    <div className="card-section-head">
                      <div>
                        <h2>测试结果</h2>
                        <p>{report.id} · {report.duration}</p>
                      </div>
                      <span className="report-pass-rate">
                        {Math.round((report.passed / report.total) * 100)}%
                      </span>
                    </div>
                    <div className="report-mini-bar">
                      <span style={{ width: `${(report.passed / report.total) * 100}%` }} />
                    </div>
                    <div className="report-mini-stats">
                      <div><small>用例</small><strong>{report.total}</strong></div>
                      <div><small>通过</small><strong className="text-green">{report.passed}</strong></div>
                      <div><small>失败</small><strong className="text-red">{report.failed}</strong></div>
                      <div><small>跳过</small><strong>{report.skipped}</strong></div>
                    </div>
                    <button className="report-link-btn" onClick={() => onNavigate('reports', report.id)}>
                      查看完整测试报告 <ArrowRight size={14} />
                    </button>
                  </article>
                ) : (
                  <article className="card report-pending-card">
                    <span className="report-pending-icon"><FileBarChart2 size={20} /></span>
                    <div>
                      <strong>测试报告待生成</strong>
                      <p>自动化测试完成后，报告将在这里自动归档。</p>
                    </div>
                  </article>
                )}
              </div>
            </div>

            <article className="terminal-card">
              <div className="terminal-head">
                <span><Terminal size={15} /> 实时执行日志</span>
                <div>
                  <span className="terminal-dot red" />
                  <span className="terminal-dot amber" />
                  <span className="terminal-dot green" />
                </div>
              </div>
              <div className="terminal-body">
                <div><span className="term-info">INFO</span> pipeline {run.id} started by {run.triggeredBy}</div>
                <div><span className="term-info">INFO</span> resolve work item: {run.workItemId}</div>
                <div><span className="term-info">INFO</span> checkout: {run.localPath || '未记录'}</div>
                {run.stages.filter((stage) => stage.status !== 'pending').map((stage) => (
                  <div key={stage.key}>
                    <span className={stage.status === 'failed' ? 'term-error' : 'term-success'}>
                      {stage.status === 'failed' ? 'ERROR' : 'OK'}
                    </span>
                    [{stage.name}] {stage.log ?? stage.description}
                  </div>
                ))}
                {run.status === 'running' && <div className="terminal-cursor-line"><span className="terminal-cursor" /> 等待下一阶段输出…</div>}
              </div>
            </article>
          </section>
        )}
        {!run && (
          <section className="pipeline-detail">
            <article className="pipeline-detail-card card">
              <div className="empty-state">
                <h3>暂无交付流水线</h3>
                <p>请先创建账号、接入仓库并录入工作项，然后启动交付。</p>
                <button className="btn btn-primary" onClick={() => setDeliveryOpen(true)}>
                  <Rocket size={15} /> 启动交付
                </button>
              </div>
            </article>
          </section>
        )}
      </div>

      <DeliveryDialog
        open={deliveryOpen}
        onClose={() => setDeliveryOpen(false)}
        onStarted={(started) => setSelectedId(started.id)}
      />

      <Modal
        open={Boolean(artifactReport)}
        onClose={() => setArtifactReport(null)}
        title={artifactReport?.title ?? ''}
        subtitle={
          artifactReport
            ? `${artifactReport.id} · ${run?.repoName ?? ''}/${run?.branch ?? ''} · ${artifactReport.createdAt}`
            : undefined
        }
        size="lg"
        footer={
          <>
            <span className="modal-footer-hint">
              <FileBarChart2 size={15} /> 报告随流水线本地归档，可追溯至对应工作项
            </span>
            <div className="modal-footer-actions">
              <button className="btn btn-primary" onClick={() => setArtifactReport(null)}>
                关闭
              </button>
            </div>
          </>
        }
      >
        {artifactReport && (
          <div className="artifact-report">
            <div className="artifact-report-hero">
              <span className={`artifact-report-icon ${artifactReport.id.startsWith('INTEGRATION') ? 'integration' : ''}`}>
                {artifactReport.id.startsWith('INTEGRATION') ? <GitMerge size={21} /> : <FileText size={21} />}
              </span>
              <div className="artifact-report-copy">
                <div className="artifact-report-meta">
                  <StatusBadge status="success" label="报告已生成" />
                  <span className="soft-tag">{run?.workItemId}</span>
                </div>
                <p>{artifactReport.summary}</p>
              </div>
            </div>
            <div className="artifact-report-sections">
              {artifactReport.sections.map((section, index) => (
                <section className="artifact-report-section" key={section.title}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <h3>{section.title}</h3>
                    <p>{section.content}</p>
                  </div>
                </section>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
