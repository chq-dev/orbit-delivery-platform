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
  TrendingUp,
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

const sparkPaths = [
  'M2 28 C10 27, 14 19, 22 21 S34 27, 41 18 S54 12, 63 14 S76 8, 88 9',
  'M2 27 C10 23, 16 27, 23 20 S36 12, 44 16 S57 20, 65 11 S77 14, 88 7',
  'M2 25 C12 22, 15 14, 24 16 S35 22, 43 13 S55 9, 63 12 S75 6, 88 5',
  'M2 12 C11 14, 17 8, 26 14 S39 24, 47 17 S57 10, 66 18 S79 24, 88 20',
]

function MetricCard({
  icon: Icon,
  label,
  value,
  suffix,
  note,
  trend,
  tone,
  sparkIndex,
}: {
  icon: LucideIcon
  label: string
  value: string
  suffix?: string
  note: string
  trend?: string
  tone: string
  sparkIndex: number
}) {
  return (
    <article className={`metric-card metric-tone-${tone}`}>
      <div className="metric-top">
        <span className="metric-icon">
          <Icon size={19} />
        </span>
        {trend && (
          <span className="metric-trend">
            <TrendingUp size={12} /> {trend}
          </span>
        )}
      </div>
      <div className="metric-label">{label}</div>
      <div className="metric-value">
        {value}
        {suffix && <small>{suffix}</small>}
      </div>
      <div className="metric-bottom">
        <span>{note}</span>
        <svg viewBox="0 0 90 32" className="sparkline" aria-hidden="true">
          <path d={sparkPaths[sparkIndex]} className="spark-fill" />
          <path d={sparkPaths[sparkIndex]} className="spark-line" />
        </svg>
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
  const { repositories, workItems, pipelines } = useData()
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  const [workItemOpen, setWorkItemOpen] = useState(false)
  const activePipelines = pipelines.filter((run) => run.status === 'running')
  const pendingItems = workItems.filter(
    (item) => item.status === '待处理' || item.status === '进行中',
  )
  const pendingDefects = pendingItems.filter((item) => item.type === 'defect').length
  const activeRun = activePipelines[0] ?? pipelines[0]
  const pendingStage = activeRun.stages.find((stage) => stage.status === 'running')
  const progressStyle = { '--progress': `${activeRun.progress}%` } as CSSProperties
  const ringStyle = {
    background: 'conic-gradient(#5b5ce2 0deg 347deg, #e8eaf3 347deg 360deg)',
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
          value={String(Math.max(activePipelines.length, 1))}
          note={`${pendingStage?.name ?? '报告归档'}执行中`}
          tone="indigo"
          sparkIndex={0}
        />
        <MetricCard
          icon={PackageCheck}
          label="本周完成交付"
          value="28"
          suffix="次"
          note="较上周多 6 次"
          trend="+18.6%"
          tone="green"
          sparkIndex={1}
        />
        <MetricCard
          icon={Zap}
          label="交付成功率"
          value="96.4"
          suffix="%"
          note="连续 3 周保持提升"
          trend="+2.4%"
          tone="blue"
          sparkIndex={2}
        />
        <MetricCard
          icon={TriangleAlert}
          label="待处理工作项"
          value={String(pendingItems.length)}
          note={`${pendingDefects} 个缺陷 · ${pendingItems.length - pendingDefects} 个需求`}
          tone="orange"
          sparkIndex={3}
        />
      </div>

      <div className="dashboard-hero-grid">
        <article className="active-delivery-card">
          <div className="hero-grid-pattern" />
          <div className="hero-orb hero-orb-one" />
          <div className="hero-orb hero-orb-two" />
          <div className="active-delivery-head">
            <span className="live-pill">
              <span className="live-dot" /> LIVE
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
              {activeRun.status === 'running' ? '执行中' : '已完成'}
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
              <TimerReset size={14} /> 预计剩余 8 分钟
            </span>
          </div>

          <div className="hero-progress-head">
            <span>
              {pendingStage ? `正在${pendingStage.name}` : '交付已完成'}
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

        <article className="efficiency-card card">
          <SectionHeading
            title="自动化引擎"
            description="本周运行质量"
            action={<span className="soft-tag">实时</span>}
          />
          <div className="efficiency-ring-wrap">
            <div className="efficiency-ring" style={ringStyle}>
              <div>
                <strong>96.4<small>%</small></strong>
                <span>交付成功率</span>
              </div>
            </div>
            <div className="efficiency-summary">
              <span>
                <i className="dot-green" /> 成功 <strong>132</strong>
              </span>
              <span>
                <i className="dot-red" /> 失败 <strong>5</strong>
              </span>
              <span>
                <i className="dot-gray" /> 取消 <strong>2</strong>
              </span>
            </div>
          </div>
          <div className="efficiency-list">
            <div>
              <span className="efficiency-icon build">
                <Boxes size={15} />
              </span>
              <span>平均编译耗时</span>
              <strong>6m 42s</strong>
            </div>
            <div>
              <span className="efficiency-icon test">
                <CheckCircle2 size={15} />
              </span>
              <span>平均测试耗时</span>
              <strong>18m 52s</strong>
            </div>
            <div>
              <span className="efficiency-icon device">
                <Rocket size={15} />
              </span>
              <span>设备升级成功率</span>
              <strong>99.1%</strong>
            </div>
          </div>
          <div className="runner-online-row">
            <span>
              <span className="online-dot" /> 4 个运行器在线
            </span>
            <span>负载 42%</span>
          </div>
        </article>
      </div>

      <div className="dashboard-lower-grid">
        <article className="card project-status-card">
          <SectionHeading
            title="项目交付状态"
            description="已接入 4 个代码仓库"
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
