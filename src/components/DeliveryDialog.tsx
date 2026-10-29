import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  FileText,
  FolderGit2,
  GitBranch,
  GitMerge,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createPendingLocalDeliveryJob,
  markLocalDeliveryStartFailed,
  pipelineFromDeliveryResult,
  probeLocalDeliveryAgent,
  startLocalDelivery,
  waitForLocalDelivery,
  type LocalDeliveryAgentReadiness,
} from '../localDeliveryAgent'
import { useData } from '../store'
import type { LocalDeliveryJob, PipelineRun, WorkItem } from '../types'
import { searchWorkItems } from '../workItemSearch'
import { PipelineSteps } from './PipelineSteps'
import { Field, Modal, StatusBadge } from './ui'

const MAX_VISIBLE_WORK_ITEMS = 50

function deliveryStatusLabel(job: LocalDeliveryJob | null, error: string): string {
  if (error || job?.status === 'failed') return '本机执行失败'
  if (job?.status === 'succeeded') return '本机执行完成'
  if (job?.status === 'running') return '本机执行中'
  return '等待本机执行'
}

function WorkItemPicker({
  items,
  value,
  onChange,
}: {
  items: WorkItem[]
  value?: WorkItem
  onChange: (item: WorkItem | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const selectedLabel = value ? `${value.id} · ${value.title}` : ''
  const result = useMemo(
    () => searchWorkItems(items, searching ? query : '', MAX_VISIBLE_WORK_ITEMS),
    [items, query, searching],
  )
  const safeActiveIndex =
    result.items.length === 0 ? -1 : Math.min(activeIndex, result.items.length - 1)

  const close = () => {
    setOpen(false)
    setSearching(false)
    setQuery('')
  }

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  useEffect(() => {
    setActiveIndex(0)
  }, [open, query])

  const choose = (item: WorkItem) => {
    onChange(item)
    close()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setSearching(true)
        setQuery('')
      }
      setActiveIndex((current) =>
        result.items.length === 0 ? 0 : (Math.min(current, result.items.length - 1) + 1) % result.items.length,
      )
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setSearching(true)
        setQuery('')
      }
      setActiveIndex((current) =>
        result.items.length === 0
          ? 0
          : (Math.min(current, result.items.length - 1) - 1 + result.items.length) %
            result.items.length,
      )
      return
    }
    if (event.key === 'Enter' && open && safeActiveIndex >= 0) {
      event.preventDefault()
      choose(result.items[safeActiveIndex])
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  return (
    <div className="work-item-picker" ref={rootRef}>
      <div className={`work-item-picker-control ${open ? 'open' : ''}`}>
        <Search size={15} />
        <input
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="delivery-work-item-options"
          aria-activedescendant={
            open && safeActiveIndex >= 0
              ? `delivery-work-item-option-${safeActiveIndex}`
              : undefined
          }
          value={searching ? query : selectedLabel}
          placeholder="输入编号、标题、负责人或项目线模糊搜索"
          onFocus={() => {
            setOpen(true)
            setSearching(true)
            setQuery('')
          }}
          onChange={(event) => {
            setOpen(true)
            setSearching(true)
            setQuery(event.target.value)
          }}
          onKeyDown={handleKeyDown}
        />
        {value && !searching && (
          <button
            type="button"
            className="work-item-picker-clear"
            aria-label="清除已选工作项"
            onClick={() => {
              onChange(undefined)
              setOpen(true)
              setSearching(true)
              setQuery('')
            }}
          >
            <X size={13} />
          </button>
        )}
        <ChevronDown size={14} className={open ? 'picker-chevron open' : 'picker-chevron'} />
      </div>

      {open && (
        <div className="work-item-picker-menu">
          <div className="work-item-picker-meta">
            {result.total === 0
              ? '没有匹配的工作项'
              : result.total > result.items.length
                ? `命中 ${result.total} 条，显示前 ${result.items.length} 条`
                : `共 ${result.total} 条可交付工作项`}
          </div>
          <div className="work-item-picker-options" id="delivery-work-item-options" role="listbox">
            {result.items.length === 0 && (
              <div className="work-item-picker-empty">
                没有匹配项，试试编号、标题、负责人或项目线关键词
              </div>
            )}
            {result.items.map((item, index) => (
              <button
                type="button"
                role="option"
                aria-selected={item.id === value?.id}
                id={`delivery-work-item-option-${index}`}
                key={item.id}
                className={`work-item-option ${index === safeActiveIndex ? 'active' : ''} ${
                  item.id === value?.id ? 'selected' : ''
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(item)}
              >
                <span className={`work-item-option-type ${item.type}`}>
                  {item.type === 'requirement' ? '需求' : '缺陷'}
                </span>
                <span className="work-item-option-copy">
                  <strong>{item.title}</strong>
                  <small>
                    {[item.id, item.owner, item.projectLine].filter(Boolean).join(' · ')}
                  </small>
                </span>
                <span className="work-item-option-status">
                  {item.feishuStatus ?? item.status}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function DeliveryDialog({
  open,
  onClose,
  onStarted,
  initialWorkItemId,
}: {
  open: boolean
  onClose: () => void
  onStarted: (run: PipelineRun) => void
  initialWorkItemId?: string
}) {
  const {
    workItems,
    repositories,
    notify,
    reload,
    refreshWorkItems,
  } = useData()
  const [workItemId, setWorkItemId] = useState('')
  const [repoId, setRepoId] = useState('')
  const [autoCommit, setAutoCommit] = useState(true)
  const [pushAfterAcceptance, setPushAfterAcceptance] = useState(true)
  const [autoClose, setAutoClose] = useState(true)
  const [launching, setLaunching] = useState(false)
  const [deliveryJob, setDeliveryJob] = useState<LocalDeliveryJob | null>(null)
  const [deliveryError, setDeliveryError] = useState('')
  const progressRef = useRef<HTMLDivElement | null>(null)
  const progressVisible = Boolean(deliveryJob || deliveryError)
  const [localAgent, setLocalAgent] = useState<
    LocalDeliveryAgentReadiness & { checking: boolean }
  >({
    checking: true,
    online: false,
    configured: false,
    meegleAuthenticated: false,
    codexAvailable: false,
  })

  const availableItems = useMemo(
    () => workItems.filter((item) => item.status !== '已关闭' && !item.frontendOnly),
    [workItems],
  )
  const selectedItem = workItems.find((item) => item.id === workItemId)
  const selectedRepo = repositories.find((repo) => repo.id === repoId)
  const deliveryStages = useMemo(
    () =>
      (deliveryJob?.steps ?? []).map((step) => ({
        key: step.key,
        name: step.name,
        description: step.description,
        status: step.status,
        log: step.log,
      })),
    [deliveryJob?.steps],
  )

  useEffect(() => {
    if (!open) return
    const preferred = availableItems.find((item) => item.id === initialWorkItemId) ?? availableItems[0]
    setWorkItemId(preferred?.id ?? '')
    const preferredRepoId = preferred?.repoId ?? repositories[0]?.id ?? ''
    setRepoId(preferredRepoId)
    setAutoCommit(true)
    setPushAfterAcceptance(true)
    setAutoClose(true)
    setDeliveryJob(null)
    setDeliveryError('')
    // Selection should only reset when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialWorkItemId])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLocalAgent({
      checking: true,
      online: false,
      configured: false,
      meegleAuthenticated: false,
      codexAvailable: false,
    })
    void probeLocalDeliveryAgent().then((state) => {
      if (!cancelled) setLocalAgent({ ...state, checking: false })
    })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open || !progressVisible) return
    const frame = window.requestAnimationFrame(() => {
      progressRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open, progressVisible])

  const handleItemChange = (item: WorkItem | undefined) => {
    setWorkItemId(item?.id ?? '')
    setDeliveryJob(null)
    setDeliveryError('')
    if (item) handleRepoChange(item.repoId)
  }

  const handleRepoChange = (id: string) => {
    setRepoId(id)
    setDeliveryJob(null)
    setDeliveryError('')
  }

  const launch = async () => {
    if (launching) return
    if (!selectedRepo?.localPath) {
      notify('缺少客户端代码路径', '请先到代码仓库配置当前客户端的绝对路径', 'warning')
      return
    }
    if (!localAgent.online) {
      notify('本机代理离线', '请先在当前客户端运行 npm run feishu:agent', 'warning')
      return
    }
    if (!localAgent.configured) {
      notify('本机代理未绑定平台', '请先到账号中心完成本机代理绑定', 'warning')
      return
    }
    if (!localAgent.codexAvailable) {
      notify(
        '未找到 Codex CLI',
        '请先设置 CODEX_BIN 为 Codex 可执行文件绝对路径，再重启本机代理',
        'warning',
      )
      return
    }
    setLaunching(true)
    setDeliveryError('')
    const pending = createPendingLocalDeliveryJob({
      workItemId,
      repoId,
      autoCommit,
      pushAfterAcceptance,
      autoClose,
    })
    setDeliveryJob(pending)
    try {
      const started = await startLocalDelivery({
        workItemId,
        repoId,
        autoCommit,
        pushAfterAcceptance,
        autoClose,
      })
      setDeliveryJob(started)
      notify(
        '本机交付已启动',
        `${workItemId} · ${selectedRepo.name} · ${selectedRepo.branch}`,
        'info',
      )
      const completed = await waitForLocalDelivery(started.id, setDeliveryJob)
      setDeliveryJob(completed)
      await reload(true)
      await refreshWorkItems(true).catch(() => undefined)
      const run = pipelineFromDeliveryResult(completed.result)
      if (!run) {
        notify(
          '本机交付完成',
          '代码已在客户端执行完成，但平台未返回流水线记录，请刷新流水线列表查看',
          'warning',
        )
        onClose()
        return
      }
      notify('本机交付完成', `${run.id} · ${run.branch}`, 'success')
      onClose()
      onStarted(run)
    } catch (error) {
      const message = error instanceof Error ? error.message : '本机交付执行失败'
      setDeliveryJob((current) =>
        current?.status === 'failed'
          ? current
          : markLocalDeliveryStartFailed(current ?? pending, message),
      )
      setDeliveryError(message)
      notify('本机交付失败', message, 'warning')
      void probeLocalDeliveryAgent().then((state) =>
        setLocalAgent({ ...state, checking: false }),
      )
    } finally {
      setLaunching(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="启动一键交付"
      subtitle="在本机真实执行需求解析、设计、编码、集成验证与提交；构建、升级、测试仅在存在真实证据时完成"
      size="lg"
      footer={
        <>
          <span className="modal-footer-hint">
            <ShieldCheck size={15} />{' '}
            {localAgent.checking
              ? '正在检测当前客户端的本机交付代理'
              : !localAgent.online
                ? '本机代理离线，请先在客户端运行 npm run feishu:agent'
                : !localAgent.configured
                  ? '本机代理已启动但尚未绑定平台同步密钥，请先到账号中心完成绑定'
                  : !localAgent.codexAvailable
                    ? '未检测到 Codex CLI，请设置 CODEX_BIN 为可执行文件绝对路径后重启代理'
                    : '点击后由本机代理在配置路径直接执行 Codex，只有真实代码变更才会创建提交'}
          </span>
          <div className="modal-footer-actions">
            <button className="btn btn-secondary" onClick={onClose}>
              {launching ? '后台执行' : '取消'}
            </button>
            <button
              className="btn btn-primary"
              onClick={launch}
              disabled={
                !workItemId ||
                !repoId ||
                launching ||
                localAgent.checking ||
                !localAgent.online ||
                !localAgent.configured ||
                !localAgent.codexAvailable
              }
            >
              {launching ? '本机执行中…' : '一键本机执行'} <ArrowRight size={16} />
            </button>
          </div>
        </>
      }
    >
      <div className="delivery-dialog-grid">
        <div className="delivery-form">
          {(deliveryJob || deliveryError) && (
            <div
              ref={progressRef}
              className={`delivery-progress-panel ${deliveryJob?.status ?? 'failed'}`}
            >
              <div className="delivery-progress-head">
                <div>
                  <span className="eyebrow">
                    <Terminal size={13} /> LOCAL EXECUTION
                  </span>
                  <h3>{deliveryStatusLabel(deliveryJob, deliveryError)}</h3>
                </div>
                {deliveryJob && (
                  <span className={`delivery-progress-status ${deliveryJob.status}`}>
                    {deliveryJob.status === 'running'
                      ? '执行中'
                      : deliveryJob.status === 'succeeded'
                        ? '已完成'
                        : '已失败'}
                  </span>
                )}
              </div>
              {deliveryStages.length > 0 && <PipelineSteps stages={deliveryStages} compact />}
              <div className="delivery-progress-logs">
                {(deliveryJob?.steps ?? []).map((step) => (
                  <div className={`delivery-progress-log ${step.status}`} key={step.key}>
                    <span className="delivery-progress-log-dot" />
                    <strong>{step.name}</strong>
                    <span>{step.log ?? step.description}</span>
                  </div>
                ))}
                {deliveryError && (
                  <div className="delivery-progress-error">
                    <AlertTriangle size={15} />
                    <span>{deliveryError}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="field">
            <span className="field-label">
              选择需求或缺陷 <em>*</em>
              <small>{availableItems.length} 条可交付</small>
            </span>
            <WorkItemPicker
              items={availableItems}
              value={selectedItem}
              onChange={handleItemChange}
            />
          </div>
          <div className="field-row">
            <Field label="目标代码仓库" required>
              <select value={repoId} onChange={(event) => handleRepoChange(event.target.value)}>
                {repositories.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="目标分支" hint="来自仓库配置">
              <div className="input-with-icon readonly-input">
                <GitBranch size={15} />
                <span>{selectedRepo?.branch ?? '-'}</span>
              </div>
            </Field>
          </div>

          <Field label="执行位置" hint="代码只在本机执行，服务端不再提供模拟交付入口">
            <div className="input-with-icon readonly-input">
              <Terminal size={15} />
              <span>客户端本地 · 本机代理</span>
            </div>
          </Field>

          <Field
            label="客户端代码路径"
            hint={
              selectedRepo?.localPath
                ? '一键执行时由本机代理读取平台仓库配置并校验该绝对路径'
                : '未配置客户端路径，无法一键执行；请先到代码仓库填写'
            }
          >
            <div className="input-with-icon readonly-input">
              <FolderGit2 size={15} />
              <span>{selectedRepo?.localPath || '未配置'}</span>
            </div>
          </Field>

          <div className="automation-options">
            <label className="check-row">
              <input
                type="checkbox"
                checked={autoCommit}
                onChange={(e) => {
                  setAutoCommit(e.target.checked)
                  if (!e.target.checked) setPushAfterAcceptance(false)
                }}
              />
              <span className="custom-check" />
              <span>
                <strong>自动提交代码</strong>
                <small>由本机执行脚本在客户端路径创建提交，验收通过后按授权推送目标分支</small>
              </span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={pushAfterAcceptance}
                disabled={!autoCommit}
                onChange={(e) => setPushAfterAcceptance(e.target.checked)}
              />
              <span className="custom-check" />
              <span>
                <strong>验收通过后推送</strong>
                <small>勾选即授权；Codex 成功结束后自动将本地提交推送到目标分支</small>
              </span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={autoClose} onChange={(e) => setAutoClose(e.target.checked)} />
              <span className="custom-check" />
              <span>
                <strong>自动关闭缺陷</strong>
                <small>测试通过后同步关闭飞书缺陷单</small>
              </span>
            </label>
          </div>

          {(deliveryJob || deliveryError) && (
            <Field
              label="本机执行状态"
              hint={`本机代理 ${
                localAgent.checking
                  ? '检测中'
                  : localAgent.online
                    ? localAgent.configured
                      ? '在线'
                      : '未绑定'
                    : '离线'
              }`}
            >
              <div className="credential-note">
                <Terminal size={16} />
                <div>
                  <strong>{deliveryStatusLabel(deliveryJob, deliveryError)}</strong>
                  <p>{deliveryError || deliveryJob?.error || deliveryJob?.stage || '正在准备执行'}</p>
                  {deliveryJob?.localPath && (
                    <p>
                      <code>{deliveryJob.localPath}</code>
                      {deliveryJob.branch ? ` · ${deliveryJob.branch}` : ''}
                    </p>
                  )}
                  {deliveryJob?.result?.commit && (
                    <p>
                      提交 <code>{deliveryJob.result.commit.slice(0, 12)}</code>
                      {deliveryJob.result.changedFiles?.length
                        ? ` · ${deliveryJob.result.changedFiles.length} 个代码文件有变更`
                        : ''}
                    </p>
                  )}
                  {deliveryJob?.result?.changedFiles && deliveryJob.result.changedFiles.length > 0 && (
                    <p>
                      {deliveryJob.result.changedFiles.slice(0, 8).join(', ')}
                      {deliveryJob.result.changedFiles.length > 8 ? ' …' : ''}
                    </p>
                  )}
                </div>
              </div>
            </Field>
          )}

          <div className="credential-note">
            <CheckCircle2 size={16} />
            <div>
              <strong>客户端执行说明</strong>
              <p>
                点击“一键本机执行”后，页面直接请求当前客户端的 <code>npm run feishu:agent</code> 代理。代理从平台读取仓库路径与分支，在本地校验 Git 工作区后调用 Codex 完成设计、编码、验证与提交；勾选验收后推送时才会写入远程分支。
              </p>
            </div>
          </div>
        </div>

        <aside className="delivery-preview">
          <div className="delivery-preview-glow" />
          <span className="eyebrow light">
            <Sparkles size={13} /> DELIVERY PLAN
          </span>
          <h3>{selectedItem?.title ?? '请选择工作项'}</h3>
          <div className="preview-meta">
            {selectedItem && <StatusBadge status={selectedItem.type} />}
            {selectedItem && <StatusBadge status={selectedItem.priority} />}
            {selectedItem && <StatusBadge status={selectedItem.status} />}
          </div>
          <div className="preview-route">
            <div>
              <GitBranch size={15} />
              <span>{selectedRepo?.name ?? '-'}</span>
              <small>{selectedRepo?.branch ?? '-'}</small>
            </div>
            <div>
              <FileText size={15} />
              <span>解析 · 设计报告 · 自动编码</span>
              <small>生成技术方案、改动范围与测试策略</small>
            </div>
            <div>
              <GitMerge size={15} />
              <span>集成报告 · 提交 · 编译 · 升级 · 测试</span>
              <small>验证通过后推送 {selectedRepo?.branch ?? '目标分支'} 并生成测试报告</small>
            </div>
          </div>
          <div className="preview-footer">
            <span>9 个自动化阶段</span>
            <span>3 份交付报告</span>
          </div>
        </aside>
      </div>
    </Modal>
  )
}
