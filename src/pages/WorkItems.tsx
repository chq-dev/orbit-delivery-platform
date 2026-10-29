import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  ClipboardCheck,
  ClipboardList,
  Clock3,
  CloudDownload,
  Copy,
  GitBranch,
  Plus,
  Rocket,
  Search,
  Sparkles,
  UserRound,
  Workflow,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { DeliveryDialog } from '../components/DeliveryDialog'
import { FeishuImportDialog } from '../components/FeishuImportDialog'
import { Avatar, Field, Modal, StatusBadge } from '../components/ui'
import { WorkItemDialog } from '../components/WorkItemDialog'
import { codingSkills } from '../codingSkills'
import { buildLocalSkillInstruction } from '../skillInstruction'
import { useData } from '../store'
import type { PageKey, WorkItem, WorkItemStatus, WorkItemType } from '../types'

type TabKey = 'all' | WorkItemType
type StatusFilter = 'all' | WorkItemStatus

export function WorkItems({
  onNavigate,
}: {
  onNavigate: (page: PageKey, runId?: string) => void
}) {
  const { workItems, repositories, pipelines, notify } = useData()
  const [tab, setTab] = useState<TabKey>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createType, setCreateType] = useState<WorkItemType>('requirement')
  const [deliveryItemId, setDeliveryItemId] = useState<string>()
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  const [detailItem, setDetailItem] = useState<WorkItem | null>(null)
  const [importMode, setImportMode] = useState<WorkItemType>('requirement')
  const [importOpen, setImportOpen] = useState(false)

  const counts = useMemo(
    () => ({
      all: workItems.length,
      requirement: workItems.filter((item) => item.type === 'requirement').length,
      defect: workItems.filter((item) => item.type === 'defect').length,
      open: workItems.filter((item) => item.status === '待处理' || item.status === '进行中').length,
      inProgress: workItems.filter((item) => item.status === '进行中').length,
      delivered: workItems.filter((item) => item.status === '已交付').length,
      closedDefects: workItems.filter(
        (item) => item.type === 'defect' && item.status === '已关闭',
      ).length,
    }),
    [workItems],
  )

  const filtered = useMemo(
    () =>
      workItems.filter((item) => {
        const tabMatches = tab === 'all' || item.type === tab
        const statusMatches = statusFilter === 'all' || item.status === statusFilter
        const textMatches = [item.id, item.title, item.owner, item.branch]
          .join(' ')
          .toLowerCase()
          .includes(search.toLowerCase())
        return tabMatches && statusMatches && textMatches
      }),
    [search, statusFilter, tab, workItems],
  )

  const openCreate = (type: WorkItemType) => {
    setCreateType(type)
    setCreateOpen(true)
  }

  const openDelivery = (id: string) => {
    setDeliveryItemId(id)
    setDeliveryOpen(true)
  }

  const openImport = (type: WorkItemType) => {
    setImportMode(type)
    setImportOpen(true)
  }

  const copySkillInstruction = async () => {
    if (!detailItem) return
    const repository = repositories.find((repo) => repo.id === detailItem.repoId)
    try {
      await navigator.clipboard.writeText(buildLocalSkillInstruction(detailItem, repository))
      notify('本地 Skill 指令已复制', `${detailItem.id} 已生成可执行指令`, 'success')
    } catch {
      notify('复制失败', '浏览器未授予剪贴板权限，请手动选择指令内容', 'warning')
    }
  }

  return (
    <div className="page-enter">
      <div className="page-header">
        <div>
          <span className="eyebrow">
            <ClipboardList size={13} /> WORK ITEMS
          </span>
          <h1>需求与缺陷</h1>
          <p>录入需求或修订缺陷，关联代码仓库后即可自动设计、编码、集成验证、提交、编译与测试。</p>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-secondary" onClick={() => openCreate('defect')}>
            <AlertTriangle size={16} /> 登记缺陷
          </button>
          <button className="btn btn-primary" onClick={() => openCreate('requirement')}>
            <Plus size={16} /> 创建需求
          </button>
        </div>
      </div>

      <div className="work-summary-grid">
        <div className="work-summary-item">
          <span className="summary-icon orange"><CircleDot size={18} /></span>
          <div><small>待处理</small><strong>{counts.open}</strong></div>
          <span className="work-summary-note">需要跟进</span>
        </div>
        <div className="work-summary-item">
          <span className="summary-icon blue"><Workflow size={18} /></span>
          <div><small>交付进行中</small><strong>{counts.inProgress}</strong></div>
          <span className="work-summary-note">自动执行</span>
        </div>
        <div className="work-summary-item">
          <span className="summary-icon green"><CheckCircle2 size={18} /></span>
          <div><small>累计已交付</small><strong>{counts.delivered}</strong></div>
          <span className="work-summary-note">真实记录</span>
        </div>
        <div className="work-summary-item">
          <span className="summary-icon indigo"><ClipboardCheck size={18} /></span>
          <div><small>已关闭缺陷</small><strong>{counts.closedDefects}</strong></div>
          <span className="work-summary-note">真实记录</span>
        </div>
      </div>

      <div className="integration-links-strip">
        <div className="integration-source">
          <span className="feishu-project-mark">飞书</span>
          <span>
            <strong>rjcloud 飞书项目</strong>
            <small>本地同步模式已连接，不打开外部项目页面</small>
          </span>
        </div>
        <div className="integration-link-actions">
          <button onClick={() => openImport('requirement')}>
            <CloudDownload size={14} /> 同步飞书需求
          </button>
          <button onClick={() => openImport('defect')}>
            <CloudDownload size={14} /> 同步飞书缺陷
          </button>
        </div>
      </div>

      <article className="card work-items-card">
        <div className="work-items-topbar">
          <div className="work-tabs">
            <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>
              全部 <span>{counts.all}</span>
            </button>
            <button className={tab === 'requirement' ? 'active' : ''} onClick={() => setTab('requirement')}>
              需求 <span>{counts.requirement}</span>
            </button>
            <button className={tab === 'defect' ? 'active' : ''} onClick={() => setTab('defect')}>
              缺陷 <span>{counts.defect}</span>
            </button>
          </div>
          <div className="toolbar-right">
            <select
              className="compact-select"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            >
              <option value="all">全部状态</option>
              <option value="待处理">待处理</option>
              <option value="进行中">进行中</option>
              <option value="已交付">已交付</option>
              <option value="已关闭">已关闭</option>
            </select>
            <label className="toolbar-search narrow">
              <Search size={15} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索编号、标题或负责人"
              />
            </label>
          </div>
        </div>

        <div className="table-wrap">
          <table className="data-table work-items-table">
            <thead>
              <tr>
                <th>工作项</th>
                <th>类型</th>
                <th>优先级</th>
                <th>状态</th>
                <th>关联仓库</th>
                <th>负责人</th>
                <th>最近更新</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
                const repo = repositories.find((entry) => entry.id === item.repoId)
                const latestRun = pipelines.find((run) => run.workItemId === item.id)
                return (
                  <tr key={item.id} onClick={() => setDetailItem(item)}>
                    <td>
                      <div className="work-item-title-cell">
                        <span className={`work-type-icon work-type-icon-${item.type}`}>
                          {item.type === 'defect' ? <AlertTriangle size={15} /> : <Sparkles size={15} />}
                        </span>
                        <div>
                          <strong>{item.title}</strong>
                          <small>
                            {item.source === 'feishu' && item.externalId ? `飞书 ${item.externalId} · ` : ''}
                            {item.id}{item.type === 'defect' && ' · 测试通过后自动关闭'}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td><StatusBadge status={item.type} /></td>
                    <td><StatusBadge status={item.priority} /></td>
                    <td><StatusBadge status={item.status} /></td>
                    <td>
                      <div className="table-repo-cell">
                        <strong>{repo?.name ?? '未关联'}</strong>
                        <small><GitBranch size={11} /> {item.branch}</small>
                      </div>
                    </td>
                    <td>
                      <span className="member-cell"><Avatar name={item.owner} size="sm" /> {item.owner}</span>
                    </td>
                    <td><span className="muted-cell">{item.updatedAt}</span></td>
                    <td>
                      <div className="table-actions">
                        {latestRun ? (
                          <button
                            className="btn btn-quiet btn-xs"
                            onClick={(event) => {
                              event.stopPropagation()
                              onNavigate('pipelines', latestRun.id)
                            }}
                          >
                            查看交付
                          </button>
                        ) : (
                          <button
                            className="btn btn-soft-primary btn-xs"
                            onClick={(event) => {
                              event.stopPropagation()
                              openDelivery(item.id)
                            }}
                            disabled={item.status === '已关闭'}
                          >
                            <Rocket size={13} /> 发起交付
                          </button>
                        )}
                        <ChevronRight size={15} className="row-chevron" />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="empty-state table-empty">
            <h3>{workItems.length === 0 ? '尚未同步到工作项' : '没有匹配的工作项'}</h3>
            <p>
              {workItems.length === 0
                ? '请检查部署环境中的飞书访问凭证并确认启动同步成功，列表会自动刷新。'
                : '调整筛选条件，或创建一个新的需求 / 缺陷。'}
            </p>
          </div>
        )}
        <div className="table-footer">
          <span>显示 {filtered.length} / {workItems.length} 个工作项</span>
          <div className="pagination">
            <button disabled>上一页</button>
            <button className="active">1</button>
            <button disabled>下一页</button>
          </div>
        </div>
      </article>

      <WorkItemDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        initialType={createType}
      />
      <DeliveryDialog
        open={deliveryOpen}
        onClose={() => setDeliveryOpen(false)}
        initialWorkItemId={deliveryItemId}
        onStarted={(run) => onNavigate('pipelines', run.id)}
      />
      <FeishuImportDialog
        open={importOpen}
        mode={importMode}
        onClose={() => setImportOpen(false)}
      />

      <Modal
        open={Boolean(detailItem)}
        onClose={() => setDetailItem(null)}
        title={detailItem?.title ?? ''}
        subtitle={detailItem ? `${detailItem.id} · ${detailItem.type === 'requirement' ? '需求' : '缺陷'}` : ''}
        size="lg"
        footer={
          <>
            <span className="modal-footer-hint">
              <Clock3 size={15} /> 最近更新 {detailItem?.updatedAt}
            </span>
            <div className="modal-footer-actions">
              <button className="btn btn-secondary" onClick={() => setDetailItem(null)}>
                关闭
              </button>
              {detailItem && (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setDetailItem(null)
                    openDelivery(detailItem.id)
                  }}
                  disabled={detailItem.status === '已关闭'}
                >
                  <Rocket size={15} /> 发起交付
                </button>
              )}
            </div>
          </>
        }
      >
        {detailItem && (
          <div className="work-item-detail">
            <div className="detail-badges">
              <StatusBadge status={detailItem.type} />
              <StatusBadge status={detailItem.priority} />
              <StatusBadge status={detailItem.status} />
            </div>
            <div className="detail-description">
              <span>描述</span>
              <p>{detailItem.description}</p>
            </div>
            <div className="detail-grid">
              <div>
                <small>关联仓库</small>
                <strong>{repositories.find((repo) => repo.id === detailItem.repoId)?.name}</strong>
              </div>
              <div>
                <small>目标分支</small>
                <strong><GitBranch size={13} /> {detailItem.branch}</strong>
              </div>
              <div>
                <small>负责人</small>
                <strong><UserRound size={13} /> {detailItem.owner}</strong>
              </div>
              <div>
                <small>创建时间</small>
                <strong>{detailItem.createdAt}</strong>
              </div>
            </div>
            <Field label="交付自动化说明">
              <div className="detail-automation-note">
                <ArrowRight size={14} />
                需求解析 → 开发设计报告 → 自动需求编码 → 集成验证报告 → 提交代码 → 编译 → 设备升级 → 自动化测试 → 归档报告
                {detailItem.type === 'defect' && ' → 关闭缺陷'}
              </div>
            </Field>
            <div className="skill-instruction-panel">
              <div className="skill-instruction-head">
                <span><Sparkles size={13} /> 本地 Skill 指令 · {codingSkills.length} 个组织级 Skill</span>
                <button className="btn btn-secondary btn-xs" onClick={copySkillInstruction}>
                  <Copy size={12} /> 复制指令
                </button>
              </div>
              <code>
                {buildLocalSkillInstruction(
                  detailItem,
                  repositories.find((repo) => repo.id === detailItem.repoId),
                )}
              </code>
              <div className="skill-chain">
                <span className="skill-chain-label">SDD 链</span>
                {codingSkills.map((skill) => (
                  <span className="skill-chip" key={skill.id} title={skill.stage}>
                    ${skill.id}
                  </span>
                ))}
              </div>
              <p>已接入 coding-skills 的 SDD 技能链；粘贴到 Codex 即可完成澄清、设计、编码、验证与评审，不打开外部页面。</p>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
