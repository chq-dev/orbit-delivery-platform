import {
  ArrowRight,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  GitBranch,
  GitCommit,
  PackageCheck,
  Plus,
  Rocket,
  ShieldCheck,
  Sparkles,
  TimerReset,
  TriangleAlert,
  UserRound,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useState, type CSSProperties } from 'react'
import { DeliveryDialog } from '../components/DeliveryDialog'
import { PipelineSteps } from '../components/PipelineSteps'
import { SectionHeading, StatusBadge } from '../components/ui'
import { WorkItemDialog } from '../components/WorkItemDialog'
import { useData } from '../store'
import type { PageKey } from '../types'

function MetricCard({
  icon: Icon,
  label,
  value,
  suffix,
  note,
  tone,
}: {
  icon: LucideIcon
  label: string
  value: string
  suffix?: string
  note: string
  tone: string
}) {
  return (
    <article className={`metric-card metric-tone-${tone}`}>
      <div className="metric-top">
        <span className="metric-icon">
          <Icon size={19} />
        </span>
      </div>
      <div className="metric-label">{label}</div>
      <div className="metric-value">
        {value}
        {suffix && <small>{suffix}</small>}
      </div>
      <div className="metric-bottom">
        <span>{note}</span>
      </div>
    </article>
  )
}

function recentStageLabel(stages: { status: string; name: string }[]) {
  const running = stages.find((stage) => stage.status === 'running')
  if (running) return `正在${running.name}`
  const failed = stages.find((stage) => stage.status === 'failed')
  if (failed) return `${failed.name}失败`
  return '全部阶段已完成'
}

export function Dashboard({ onNavigate }: { onNavigate: (page: PageKey, runId?: string) => void }) {
  const { repositories, workItems, pipelines, reports } = useData()
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  const [workItemOpen, setWorkItemOpen] = useState(false)
  const activePipelines = pipelines.filter((run) => run.status === 'running')
  const pendingItems = workItems.filter(
    (item) => item.status === '待处理' || item.status === '进行中',
  )
  const pendingDefects = pendingItems.filter((item) => item.type === 'defect').length
  const activeRun = activePipelines[0] ?? pipelines[0]
  const pendingStage = activeRun?.stages.find((stage) => stage.status === 'running')
  const progressStyle = { '--progress': `${activeRun?.progress ?? 0}%` } as CSSProperties
  const completedRuns = pipelines.filter((run) => run.status === 'success')
  const failedRuns = pipelines.filter((run) => run.status === 'failed')
  const finishedRuns = completedRuns.length + failedRuns.length
  const successRate = finishedRuns ? (completedRuns.length / finishedRuns) * 100 : 0
  const successRateLabel = successRate.toFixed(1)
  const ringStyle = {
    background: `conic-gradient(#5b5ce2 0deg ${successRate * 3.6}deg, #e8eaf3 ${successRate * 3.6}deg 360deg)`,
  }
  const todayLabel = new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date())

  return (
    <div className="dashboard-page page-enter">
      <div className="page-header">
        <div>
          <span className="eyebrow">
            <Sparkles size={13} /> {todayLabel}
          </span>
          <h1>交付总览</h1>
          <p>面向无线路由、AC/AP 与交换设备的研发交付，让每一次业务变更安全、可追溯地抵达设备。</p>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-secondary" onClick={() => onNavigate('accounts')}>
            <ShieldCheck size={16} /> 账号中心
          </button>
          <button className="btn btn-secondary" onClick={() => setWorkItemOpen(true)}>
            <Plus size={16} /> 新建工作项
          </button>
          <button className="btn btn-primary btn-glow" onClick={() => setDeliveryOpen(true)}>
            <Rocket size={16} /> 启动交付
          </button>
        </div>
      </div>

      <div className="metrics-grid">
        <MetricCard
          icon={Workflow}
          label="活跃流水线"
          value={String(activePipelines.length)}
          note={
            activePipelines.length > 0
              ? `${pendingStage?.name ?? '报告归档'}执行中`
              : '当前没有执行中的流水线'
          }
          tone="indigo"
        />
        <MetricCard
          icon={PackageCheck}
          label="累计完成交付"
          value={String(completedRuns.length)}
          suffix="次"
          note={`${failedRuns.length} 次失败`}
          tone="green"
        />
        <MetricCard
          icon={Zap}
          label="交付成功率"
          value={successRateLabel}
          suffix="%"
          note={finishedRuns ? `基于 ${finishedRuns} 次已完成执行` : '暂无已完成执行'}
          tone="blue"
        />
        <MetricCard
          icon={TriangleAlert}
          label="待处理工作项"
          value={String(pendingItems.length)}
          note={`${pendingDefects} 个缺陷 · ${pendingItems.length - pendingDefects} 个需求`}
          tone="orange"
        />
      </div>

      <div className="dashboard-hero-grid">
        {activeRun ? (
          <article className="active-delivery-card">
            <div className="hero-grid-pattern" />
            <div className="hero-orb hero-orb-one" />
            <div className="hero-orb hero-orb-two" />
            <div className="active-delivery-head">
              <span className={`live-pill ${activeRun.status === 'running' ? '' : 'live-pill-idle'}`}>
                <span className="live-dot" /> {activeRun.status === 'running' ? 'LIVE' : 'HISTORY'}
              </span>
              <span className="run-id">{activeRun.id}</span>
            </div>
            <div className="active-delivery-title-row">
              <div>
                <span className="eyebrow light">
                  <CircleDot size={12} /> 当前交付
                </span>
                <h2>{activeRun.title}</h2>
              </div>
              <span className="hero-status-pill">
                {activeRun.status === 'running'
                  ? '执行中'
                  : activeRun.status === 'failed'
                    ? '执行失败'
                    : '已完成'}
              </span>
            </div>
            <div className="active-meta-row">
              <span>
                <GitBranch size={14} /> {activeRun.repoName} / {activeRun.branch}
              </span>
              <span>
                <GitCommit size={14} /> {activeRun.commit}
              </span>
              <span>
                <UserRound size={14} /> {activeRun.triggeredBy}
              </span>
              <span>
                <TimerReset size={14} /> {pendingStage ? `阶段 ${activeRun.currentStage + 1} / 9` : '执行结束'}
              </span>
            </div>

            <div className="hero-progress-head">
              <span>
                {pendingStage
                  ? `正在${pendingStage.name}`
                  : activeRun.status === 'failed'
                    ? '流水线执行失败'
                    : '交付已完成'}
                <small>{pendingStage?.description}</small>
              </span>
              <strong>{activeRun.progress}%</strong>
            </div>
            <div className="hero-progress-track">
              <span style={progressStyle} />
            </div>
            <div className="hero-pipeline-wrap">
              <PipelineSteps stages={activeRun.stages} compact />
            </div>
            <div className="active-delivery-footer">
              <div>
                <span className="version-label">目标版本</span>
                <strong>{activeRun.version}</strong>
              </div>
              <button className="hero-link" onClick={() => onNavigate('pipelines', activeRun.id)}>
                查看执行详情 <ArrowRight size={15} />
              </button>
            </div>
          </article>
        ) : (
          <article className="active-delivery-card active-delivery-empty">
            <span className="eyebrow light">
              <CircleDot size={12} /> 当前交付
            </span>
            <h2>暂无交付流水线</h2>
            <p>创建账号、接入代码仓库并录入工作项后，即可发起首次交付。</p>
            <button className="hero-link" onClick={() => setDeliveryOpen(true)}>
              启动交付 <ArrowRight size={15} />
            </button>
          </article>
        )}

        <article className="efficiency-card card">
          <SectionHeading
            title="交付质量"
            description="基于当前数据库记录"
            action={<span className="soft-tag">实时</span>}
          />
          <div className="efficiency-ring-wrap">
            <div className="efficiency-ring" style={ringStyle}>
              <div>
                <strong>{successRateLabel}<small>%</small></strong>
                <span>交付成功率</span>
              </div>
            </div>
            <div className="efficiency-summary">
              <span>
                <i className="dot-green" /> 成功 <strong>{completedRuns.length}</strong>
              </span>
              <span>
                <i className="dot-red" /> 失败 <strong>{failedRuns.length}</strong>
              </span>
              <span>
                <i className="dot-gray" /> 执行中 <strong>{activePipelines.length}</strong>
              </span>
            </div>
          </div>
          <div className="efficiency-list">
            <div>
              <span className="efficiency-icon build">
                <Boxes size={15} />
              </span>
              <span>已归档测试报告</span>
              <strong>{reports.length}</strong>
            </div>
            <div>
              <span className="efficiency-icon test">
                <CheckCircle2 size={15} />
              </span>
              <span>累计流水线</span>
              <strong>{pipelines.length}</strong>
            </div>
            <div>
              <span className="efficiency-icon device">
                <Rocket size={15} />
              </span>
              <span>已接入仓库</span>
              <strong>{repositories.length}</strong>
            </div>
          </div>
          <div className="runner-online-row">
            <span>
              <span className="online-dot" /> 后端数据服务已连接
            </span>
            <span>SQLite 持久化</span>
          </div>
        </article>
      </div>

      <div className="dashboard-lower-grid">
        <article className="card project-status-card">
          <SectionHeading
            title="项目交付状态"
            description={`已接入 ${repositories.length} 个代码仓库`}
            action={
              <button className="text-btn" onClick={() => onNavigate('repositories')}>
                管理仓库 <ArrowUpRight size={14} />
              </button>
            }
          />
          <div className="repo-status-list">
            {repositories.slice(0, 4).map((repo, index) => {
              const repoRuns = pipelines.filter((run) => run.repoId === repo.id)
              const latest = repoRuns[0]
              return (
                <button
                  key={repo.id}
                  className="repo-status-row"
                  onClick={() => onNavigate('repositories')}
                >
                  <span className={`repo-logo repo-logo-${index % 4}`}>
                    {repo.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="repo-status-name">
                    <strong>{repo.name}</strong>
                    <small>
                      <GitBranch size={12} /> {repo.branch} · {repo.language}
                    </small>
                  </span>
                  <span className="repo-version">
                    <small>最新版本</small>
                    <strong>{repo.latestVersion}</strong>
                  </span>
                  <span className={`repo-health repo-health-${repo.status}`}>
                    <span />
                    {repo.status === 'healthy' ? '健康' : '需关注'}
                  </span>
                  <span className="repo-last-run">
                    {latest ? (
                      <>
                        <StatusBadge status={latest.status} />
                        <small>{latest.createdAt}</small>
                      </>
                    ) : (
                      <small>暂无交付</small>
                    )}
                  </span>
                  <ChevronRight size={16} className="row-chevron" />
                </button>
              )
            })}
            {repositories.length === 0 && (
              <div className="empty-state">
                <h3>尚未接入代码仓库</h3>
                <p>前往代码仓库页面绑定 Git 账号并接入首个仓库。</p>
              </div>
            )}
          </div>
        </article>

        <article className="card attention-card">
          <SectionHeading
            title="需要关注"
            description={`${pendingItems.length} 个工作项待处理`}
            action={
              <button className="text-btn" onClick={() => onNavigate('work-items')}>
                全部 <ArrowRight size={14} />
              </button>
            }
          />
          <div className="attention-list">
            {pendingItems.slice(0, 4).map((item) => (
              <button className="attention-item" key={item.id} onClick={() => onNavigate('work-items')}>
                <span className={`attention-type attention-type-${item.type}`}>
                  {item.type === 'defect' ? <TriangleAlert size={15} /> : <Sparkles size={15} />}
                </span>
                <span className="attention-copy">
                  <strong>{item.title}</strong>
                  <small>
                    {item.id} · {item.owner}
                  </small>
                </span>
                <StatusBadge status={item.priority} />
              </button>
            ))}
            {pendingItems.length === 0 && (
              <div className="empty-state">
                <h3>当前没有待处理工作项</h3>
                <p>新建需求或缺陷后会显示在这里。</p>
              </div>
            )}
          </div>
        </article>
      </div>

      <article className="card recent-runs-card">
        <SectionHeading
          title="最近交付"
          description="所有自动化流水线的执行记录"
          action={
            <button className="text-btn" onClick={() => onNavigate('pipelines')}>
              查看全部 <ArrowRight size={14} />
            </button>
          }
        />
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>流水线</th>
                <th>工作项</th>
                <th>仓库 / 分支</th>
                <th>版本</th>
                <th>阶段</th>
                <th>状态</th>
                <th>时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pipelines.slice(0, 4).map((run) => (
                <tr key={run.id} onClick={() => onNavigate('pipelines', run.id)}>
                  <td>
                    <div className="run-id-cell">
                      <span className={`run-dot run-dot-${run.status}`} />
                      <div>
                        <strong>{run.id}</strong>
                        <small>{run.triggeredBy} 发起</small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="table-title-cell">
                      <strong>{run.title}</strong>
                      <small>{run.workItemId}</small>
                    </div>
                  </td>
                  <td>
                    <div className="table-repo-cell">
                      <strong>{run.repoName}</strong>
                      <small>
                        <GitBranch size={11} /> {run.branch}
                      </small>
                    </div>
                  </td>
                  <td>
                    <span className="version-chip">{run.version}</span>
                  </td>
                  <td>
                    <span className="stage-summary-cell">{recentStageLabel(run.stages)}</span>
                  </td>
                  <td>
                    <StatusBadge status={run.status} />
                  </td>
                  <td>
                    <span className="muted-cell">{run.createdAt}</span>
                  </td>
                  <td>
                    <ChevronRight size={16} className="row-chevron" />
                  </td>
                </tr>
              ))}
              {pipelines.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state table-empty">
                      <h3>暂无交付记录</h3>
                      <p>发起交付流水线后，执行记录会显示在这里。</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>

      <DeliveryDialog
        open={deliveryOpen}
        onClose={() => setDeliveryOpen(false)}
        onStarted={(run) => onNavigate('pipelines', run.id)}
      />
      <WorkItemDialog open={workItemOpen} onClose={() => setWorkItemOpen(false)} />
    </div>
  )
}
