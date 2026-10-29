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
  KeyRound,
  Plus,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  UserRound,
  Workflow,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DeliveryDialog } from '../components/DeliveryDialog'
import { FeishuImportDialog } from '../components/FeishuImportDialog'
import { FeishuLiveSyncCard } from '../components/FeishuLiveSyncCard'
import { Avatar, Field, Modal, StatusBadge } from '../components/ui'
import { WorkItemDialog } from '../components/WorkItemDialog'
import { codingSkills } from '../codingSkills'
import { buildFeishuSyncInstruction } from '../feishuSyncInstruction'
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  buildPageTokens,
  clampPage,
  getPageCount,
  paginateItems,
  type PageSize,
} from '../pagination'
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
  const {
    workItems,
    workItemsLoading,
    workItemsError,
    repositories,
    pipelines,
    notify,
    feishuIntegration,
    refreshFeishuInbox,
    feishuSnapshot,
    feishuAgent,
    syncFeishu,
    getWorkItemDetail,
    refreshWorkItems,
  } = useData()
  const [tab, setTab] = useState<TabKey>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createType, setCreateType] = useState<WorkItemType>('requirement')
  const [deliveryItemId, setDeliveryItemId] = useState<string>()
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  const [detailItem, setDetailItem] = useState<WorkItem | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [importMode, setImportMode] = useState<WorkItemType>('requirement')
  const [importOpen, setImportOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [syncingType, setSyncingType] = useState<WorkItemType | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE)
  const tableCardRef = useRef<HTMLElement | null>(null)

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

  const pageCount = getPageCount(filtered.length, pageSize)
  const safePage = clampPage(page, filtered.length, pageSize)
  const paged = useMemo(
    () => paginateItems(filtered, safePage, pageSize),
    [filtered, pageSize, safePage],
  )
  const pageTokens = useMemo(() => buildPageTokens(safePage, pageCount), [pageCount, safePage])
  const rangeStart = filtered.length === 0 ? 0 : (safePage - 1) * pageSize + 1
  const rangeEnd = Math.min(safePage * pageSize, filtered.length)

  useEffect(() => {
    setPage(1)
  }, [pageSize, search, statusFilter, tab])

  useEffect(() => {
    if (page !== safePage) setPage(safePage)
  }, [page, safePage])

  const changePage = (nextPage: number) => {
    const target = clampPage(nextPage, filtered.length, pageSize)
    if (target === safePage) return
    setPage(target)
    tableCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const openDetail = async (item: WorkItem) => {
    setDetailItem(item)
    if (item.description) return
    setDetailLoading(true)
    try {
      const detail = await getWorkItemDetail(item.id)
      setDetailItem((current) => (current?.id === item.id ? detail : current))
    } catch (error) {
      notify(
        '工作项详情读取失败',
        error instanceof Error ? error.message : '请稍后重试',
        'warning',
      )
    } finally {
      setDetailLoading(false)
    }
  }

  const openCreate = (type: WorkItemType) => {
    setCreateType(type)
    setCreateOpen(true)
  }

  const openDelivery = (id: string) => {
    setDeliveryItemId(id)
    setDeliveryOpen(true)
  }

  const directFeishuSync =
    feishuIntegration.connected &&
    (feishuIntegration.authMode === 'token' || feishuIntegration.authMode === 'plugin')
  const externalFeishuSync =
    feishuIntegration.connected && feishuIntegration.authMode === 'cli'
  const localAgentReady =
    feishuAgent.online &&
    Boolean(feishuAgent.health?.config.configured) &&
    Boolean(feishuAgent.health?.meegle.authenticated)
  const frontendFeishuSync = feishuSnapshot.configured
  const backendFeishuCount = workItems.filter(
    (item) => item.source === 'feishu' && !item.frontendOnly,
  ).length

  const openFeishuSync = async (type: WorkItemType) => {
    setImportMode(type)
    if (directFeishuSync) {
      setSyncingType(type)
      try {
        await syncFeishu()
        setImportOpen(true)
      } catch {
        // The data provider already reports the API error as a toast.
      } finally {
        setSyncingType(null)
      }
      return
    }
    if (externalFeishuSync) {
      setSyncingType(type)
      try {
        await syncFeishu()
      } catch {
        setGuideOpen(true)
      } finally {
        setSyncingType(null)
      }
      return
    }
    if (frontendFeishuSync) {
      setSyncingType(type)
      try {
        await syncFeishu()
      } catch {
        if (!feishuIntegration.connected) setGuideOpen(true)
      } finally {
        setSyncingType(null)
      }
      return
    }
    try {
      const inbox = await refreshFeishuInbox()
      if (inbox.some((item) => item.type === type)) {
        setImportOpen(true)
        return
      }
    } catch {
      // The data provider exposes the inbox error inside the import dialog.
    }
    setGuideOpen(true)
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

  const copyFeishuSyncInstruction = async () => {
    const instruction = buildFeishuSyncInstruction({
      apiBase: window.location.origin,
      projectKey: feishuIntegration.projectKey,
    })
    try {
      await navigator.clipboard.writeText(instruction)
      notify('Codex 飞书同步指令已复制', '粘贴到本机 Codex 即可拉取实时数据并回写平台', 'success')
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
            <small>
              {backendFeishuCount > 0
                ? `平台已加载 ${backendFeishuCount} 条飞书工作项`
                : frontendFeishuSync
                ? feishuSnapshot.loading
                  ? '正在读取前端同步快照…'
                  : feishuSnapshot.error
                    ? `前端快照不可用：${feishuSnapshot.error}`
                    : `前端快照 ${feishuSnapshot.itemCount} 条${feishuSnapshot.lastUpdatedAt ? ` · 更新于 ${feishuSnapshot.lastUpdatedAt}` : ''}`
                : !feishuIntegration.connected
                ? '飞书同步尚未配置，点击同步按钮查看设置步骤'
                : externalFeishuSync
                  ? localAgentReady
                    ? '本机同步代理已连接，刷新页面会自动拉取飞书实时数据'
                    : '外部 Meegle 同步已连接；启动本机代理并完成授权后可自动更新'
                  : '后端飞书直连已连接，可立即同步需求和缺陷'}
            </small>
          </span>
        </div>
        <div className="integration-link-actions">
          <button onClick={() => void openFeishuSync('requirement')} disabled={syncingType !== null}>
            <CloudDownload size={14} /> {syncingType === 'requirement' ? '同步中…' : '同步飞书需求'}
          </button>
          <button onClick={() => void openFeishuSync('defect')} disabled={syncingType !== null}>
            <CloudDownload size={14} /> {syncingType === 'defect' ? '同步中…' : '同步飞书缺陷'}
          </button>
        </div>
      </div>

      <FeishuLiveSyncCard />

      <article className="card work-items-card" ref={tableCardRef}>
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
              {paged.map((item) => {
                const repo = repositories.find((entry) => entry.id === item.repoId)
                const latestRun = pipelines.find((run) => run.workItemId === item.id)
                return (
                  <tr key={item.id} onClick={() => void openDetail(item)}>
                    <td>
                      <div className="work-item-title-cell">
                        <span className={`work-type-icon work-type-icon-${item.type}`}>
                          {item.type === 'defect' ? <AlertTriangle size={15} /> : <Sparkles size={15} />}
                        </span>
                        <div>
                          <strong>{item.title}</strong>
                          <small>
                            {item.source === 'feishu' && item.externalId ? `飞书 ${item.externalId} · ` : ''}
                            {item.id}
                            {item.frontendOnly && ' · 前端快照'}
                            {item.type === 'defect' && ' · 测试通过后自动关闭'}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td><StatusBadge status={item.type} /></td>
                    <td><StatusBadge status={item.priority} /></td>
                    <td>
                      <div className="status-stack">
                        <StatusBadge status={item.status} />
                        {item.feishuStatus && (
                          <small className="feishu-status-hint">
                            飞书 · {item.feishuStatus}
                          </small>
                        )}
                      </div>
                    </td>
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
                            disabled={item.status === '已关闭' || item.frontendOnly || !repo}
                            title={
                              item.frontendOnly || !repo
                                ? '前端快照仅用于展示，需先由后端同步后才能发起交付'
                                : undefined
                            }
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
            <h3>
              {workItemsLoading && workItems.length === 0
                ? '正在加载工作项…'
                : workItems.length === 0
                  ? '尚未同步到工作项'
                  : '没有匹配的工作项'}
            </h3>
            <p>
              {workItemsError
                ? `工作项加载失败：${workItemsError}`
                : workItemsLoading && workItems.length === 0
                  ? '列表数据较大，正在后台加载，页面其他区域可以继续使用。'
                  : workItems.length === 0
                ? '请确认前端快照地址可访问，或在能访问飞书的机器上运行 npm run sync:feishu；快照更新后列表会自动刷新。'
                : '调整筛选条件，或创建一个新的需求 / 缺陷。'}
            </p>
            {workItemsError && (
              <button className="btn btn-secondary btn-sm" onClick={() => void refreshWorkItems(true)}>
                重新加载
              </button>
            )}
          </div>
        )}
        <div className="table-footer">
          <div className="table-footer-meta">
            <span>
              显示 {filtered.length === 0 ? '0' : `${rangeStart}-${rangeEnd}`} / {filtered.length} 个匹配项，共 {workItems.length} 个工作项
            </span>
            <label className="page-size-control">
              每页
              <select
                className="compact-select"
                value={pageSize}
                onChange={(event) => {
                  setPage(1)
                  setPageSize(Number(event.target.value) as PageSize)
                }}
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>{size}</option>
                ))}
              </select>
              条
            </label>
          </div>
          <nav className="pagination" aria-label="工作项分页">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => changePage(safePage - 1)}
            >
              上一页
            </button>
            {pageTokens.map((token, index) =>
              token === 'ellipsis' ? (
                <span key={`ellipsis-${index}`} className="pagination-ellipsis">…</span>
              ) : (
                <button
                  key={token}
                  type="button"
                  className={token === safePage ? 'active' : ''}
                  aria-current={token === safePage ? 'page' : undefined}
                  aria-label={`第 ${token} 页`}
                  onClick={() => changePage(token)}
                >
                  {token}
                </button>
              ),
            )}
            <button
              type="button"
              disabled={safePage >= pageCount}
              onClick={() => changePage(safePage + 1)}
            >
              下一页
            </button>
          </nav>
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
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        title="配置飞书实时同步"
        subtitle="飞书项目需要一次授权或服务端凭证，之后工作项会自动写入当前列表"
        size="lg"
        footer={
          <div className="modal-footer-actions">
            <button className="btn btn-secondary" onClick={() => void copyFeishuSyncInstruction()}>
              <Copy size={15} /> 复制 Codex 同步指令
            </button>
            <button className="btn btn-primary" onClick={() => setGuideOpen(false)}>
              我知道了
            </button>
          </div>
        }
      >
        <div className="feishu-connect-form">
          <Field label="方案 A：页面驱动本机同步代理（推荐）">
            <div className="credential-note">
              <KeyRound size={16} />
              <div>
                <p>
                  在已登录飞书的当前电脑启动代理，然后使用上方“本机飞书实时同步”卡片完成
                  密钥绑定和授权。页面刷新会自动触发同步，无需复制飞书 Cookie。
                </p>
                <code style={{ display: 'block', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                  {`npm install -g @lark-project/meegle@1.0.27
meegle config set host project.feishu.cn
meegle auth login --device-code
npm run feishu:agent`}
                </code>
              </div>
            </div>
          </Field>
          <Field label="方案 B：通过本机 Codex Skill 执行（降级）">
            <div className="credential-note">
              <Sparkles size={16} />
              <div>
                <p>
                  Codex 在能访问飞书的客户端执行 Skill，拉取实时需求/缺陷后写回当前平台。
                  点击下方“复制 Codex 同步指令”，粘贴到本机 Codex 即可。
                </p>
                <code style={{ display: 'block', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                  {`Use $feishu-project-sync to sync live rjcloud data into ${window.location.origin}
FEISHU_SYNC_FULL=true npm run sync:feishu
npm run sync:feishu:watch`}
                </code>
              </div>
            </div>
          </Field>
          <div className="credential-note">
            <ShieldCheck size={16} />
            <div>
              <strong>为什么不能完全匿名获取</strong>
              <p>
                飞书项目页面需要登录，浏览器跨域也无法直接读取 project.feishu.cn 的数据。
                因此必须提供一次凭证；凭证只保存在服务端或同步机，不会写入前端代码或浏览器。
              </p>
            </div>
          </div>
          <Field label="方案 C：命令行常驻同步（备选）">
            <div className="credential-note">
              <Terminal size={16} />
              <div>
                <p>在登录过飞书的电脑执行一次授权，然后常驻同步：</p>
                <code style={{ display: 'block', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                  {`npm install -g @lark-project/meegle@1.0.27
meegle config set host project.feishu.cn
meegle auth login --device-code

export PLATFORM_BASE_URL=http://8.145.45.84:8787
export PLATFORM_SYNC_TOKEN=<页面生成后仅展示一次，或服务器 FEISHU_INGEST_TOKEN>
export FEISHU_PROJECT_KEY=rjcloud

npm run sync:feishu
npm run sync:feishu:watch`}
                </code>
              </div>
            </div>
          </Field>
          <Field label="方案 D：服务器直连（需要能访问飞书）">
            <div className="credential-note">
              <ShieldCheck size={16} />
              <div>
                <p>在服务器配置长期插件凭证后，服务启动即自动同步，无需再运行同步器：</p>
                <code style={{ display: 'block', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                  {`FEISHU_AUTO_SYNC=true
FEISHU_PLUGIN_ID=<飞书项目插件 ID>
FEISHU_PLUGIN_SECRET=<飞书项目插件 Secret>
FEISHU_USER_KEY=<插件授权用户 user_key>
FEISHU_PROJECT_KEY=rjcloud
FEISHU_REQUIREMENT_TYPE_KEY=story
FEISHU_DEFECT_TYPE_KEY=issue`}
                </code>
              </div>
            </div>
          </Field>
          <Field label="方案 E：纯前端快照（仅展示，不会触发飞书同步）">
            <div className="credential-note">
              <CloudDownload size={16} />
              <div>
                <p>在已授权的同步机生成同源 JSON，前端每 60 秒直接读取并刷新列表：</p>
                <code style={{ display: 'block', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                  {`meegle auth login --device-code
export FEISHU_SNAPSHOT_PATH=./data/feishu-work-items.json
npm run sync:feishu:snapshot:watch`}
                </code>
              </div>
            </div>
          </Field>
          <p>
            插件凭证在飞书项目的空间管理 → 插件 → 访问凭证中获取。不要使用浏览器 Cookie
            或短期抓包 Token 做长期部署。
          </p>
        </div>
      </Modal>

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
                  disabled={
                    detailItem.status === '已关闭' ||
                    detailItem.frontendOnly ||
                    !repositories.some((repo) => repo.id === detailItem.repoId)
                  }
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
              {detailItem.feishuStatus && (
                <StatusBadge
                  status={detailItem.feishuStatus}
                  label={`飞书 · ${detailItem.feishuStatus}`}
                />
              )}
            </div>
            <div className="detail-description">
              <span>描述</span>
              <p>
                {detailLoading
                  ? '正在加载描述…'
                  : detailItem.description || '暂无描述'}
              </p>
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
                <button
                  className="btn btn-secondary btn-xs"
                  onClick={copySkillInstruction}
                  disabled={detailLoading}
                >
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
