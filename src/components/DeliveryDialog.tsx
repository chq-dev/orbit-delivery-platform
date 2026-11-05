import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  FileText,
  FolderGit2,
  GitBranch,
  GitMerge,
  ImagePlus,
  Link2,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import {
  MAX_DELIVERY_SCREENSHOTS,
  MAX_DELIVERY_SCREENSHOTS_TOTAL_BYTES,
  REQUIREMENT_BREAKDOWN_MIN_LENGTH,
  isDeliveryScreenshotMimeType,
  requirementDeliveryContextIssue,
  type DeliveryScreenshotUpload,
} from '../deliveryContext'
import {
  createPendingLocalDeliveryJob,
  markLocalDeliveryStartFailed,
  pipelineFromDeliveryResult,
  probeLocalDeliveryAgent,
  startLocalDelivery,
  waitForLocalDelivery,
  type LocalDeliveryAgentReadiness,
} from '../localDeliveryAgent'
import { cancelLocalDeliveryJob, fetchLocalDeliveryJob } from '../feishuAgent'
import { prepareScreenshot } from '../screenshotCompression'
import { displayDeliveryStages } from '../deliveryStages'
import { useData } from '../store'
import type { LocalDeliveryJob, PipelineRun, WorkItem } from '../types'
import { searchWorkItems } from '../workItemSearch'
import { PipelineSteps } from './PipelineSteps'
import { Field, Modal, StatusBadge } from './ui'

const MAX_VISIBLE_WORK_ITEMS = 50

function deliveryStatusLabel(job: LocalDeliveryJob | null, error: string): string {
  if (error || job?.status === 'failed') return '客户端执行失败'
  if (job?.status === 'succeeded') return '客户端执行完成'
  if (job?.status === 'running') return '客户端执行中'
  return '等待客户端执行'
}

function activityLabel(value?: string): string {
  if (!value) return '未知'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return '未知'
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000))
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟前`
  return `${Math.floor(seconds / 3_600)} 小时前`
}

function elapsedLabel(value?: string, finishedAt?: string): string {
  if (!value) return '未知'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return '未知'
  const finishedTimestamp = finishedAt ? Date.parse(finishedAt) : Date.now()
  const seconds = Math.max(
    0,
    Math.round(((Number.isFinite(finishedTimestamp) ? finishedTimestamp : Date.now()) - timestamp) / 1_000),
  )
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}

function stepDurationLabel(
  step: NonNullable<LocalDeliveryJob['steps']>[number],
): string {
  if (!step.startedAt) return step.status === 'running' ? '执行中' : '未开始'
  return elapsedLabel(step.startedAt, step.finishedAt)
}

function ageSeconds(value?: string): number | undefined {
  if (!value) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, Math.round((Date.now() - timestamp) / 1_000)) : undefined
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
    accounts,
    notify,
    reload,
    refreshWorkItems,
    feishuAgentClients,
    selectedFeishuAgentClientId,
    localFeishuAgentClientId,
    selectFeishuAgentClient,
  } = useData()
  const [workItemId, setWorkItemId] = useState('')
  const [repoId, setRepoId] = useState('')
  const [autoCommit, setAutoCommit] = useState(true)
  const [pushAfterAcceptance, setPushAfterAcceptance] = useState(true)
  const [runBuild, setRunBuild] = useState(true)
  const [autoClose, setAutoClose] = useState(true)
  const [requirementBreakdown, setRequirementBreakdown] = useState('')
  const [designReference, setDesignReference] = useState('')
  const [screenshots, setScreenshots] = useState<DeliveryScreenshotUpload[]>([])
  const [screenshotError, setScreenshotError] = useState('')
  const [compressingScreenshots, setCompressingScreenshots] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [deliveryJob, setDeliveryJob] = useState<LocalDeliveryJob | null>(null)
  const [deliveryError, setDeliveryError] = useState('')
  const [localDeliveryJob, setLocalDeliveryJob] = useState<LocalDeliveryJob | null>(null)
  const [terminatingLocal, setTerminatingLocal] = useState(false)
  const progressRef = useRef<HTMLDivElement | null>(null)
  const waitAbortRef = useRef<AbortController | null>(null)
  const terminationRequestedRef = useRef(false)
  const screenshotInputRef = useRef<HTMLInputElement | null>(null)
  const requirementContextDirtyRef = useRef(false)
  const canControlLocalAgent = Boolean(
    localFeishuAgentClientId &&
      selectedFeishuAgentClientId === localFeishuAgentClientId,
  )
  const localJobInScope =
    localDeliveryJob && localDeliveryJob.workItemId === workItemId
      ? localDeliveryJob
      : null
  const localJobRunning = localJobInScope?.status === 'running'
  const localJobIsNewer = Boolean(
    localJobInScope &&
      (!deliveryJob ||
        Date.parse(localJobInScope.startedAt) >= Date.parse(deliveryJob.startedAt)),
  )
  const effectiveDeliveryJob = localJobIsNewer ? localJobInScope : deliveryJob
  const effectiveDeliveryError =
    localJobIsNewer && localJobInScope && localJobInScope.status !== 'running'
      ? localJobInScope.error ?? ''
      : deliveryError
  const heartbeatAgeSeconds = ageSeconds(effectiveDeliveryJob?.lastActivityAt)
  const workspaceAgeSeconds = ageSeconds(effectiveDeliveryJob?.workspaceChangedAt)
  const artifactAgeSeconds = ageSeconds(effectiveDeliveryJob?.artifactChangedAt)
  const jobAgeSeconds = ageSeconds(effectiveDeliveryJob?.startedAt)
  const codingStepRunning =
    effectiveDeliveryJob?.steps?.find((step) => step.key === 'coding')?.status === 'running'
  const processExited =
    effectiveDeliveryJob?.status === 'running' && effectiveDeliveryJob.processAlive === false
  const heartbeatStale =
    effectiveDeliveryJob?.status === 'running' &&
    heartbeatAgeSeconds !== undefined &&
    heartbeatAgeSeconds > 30
  const workspaceStale =
    codingStepRunning &&
    !processExited &&
    (Math.min(
      workspaceAgeSeconds ?? Number.POSITIVE_INFINITY,
      artifactAgeSeconds ?? Number.POSITIVE_INFINITY,
      jobAgeSeconds ?? Number.POSITIVE_INFINITY,
    ) > 5 * 60)
  const progressVisible = Boolean(deliveryJob || deliveryError || localJobInScope)
  const [localAgent, setLocalAgent] = useState<
    LocalDeliveryAgentReadiness & { checking: boolean }
  >({
    checking: true,
    online: false,
    platformReady: false,
    configured: false,
    meegleAuthenticated: false,
    codexAvailable: false,
    repoPaths: {},
  })

  const availableItems = useMemo(
    () => workItems.filter((item) => item.status !== '已关闭' && !item.frontendOnly),
    [workItems],
  )
  const selectedItem = workItems.find((item) => item.id === workItemId)
  const selectedRepo = repositories.find((repo) => repo.id === repoId)
  const buildAccounts = accounts.filter(
    (account) => account.platform === 'build' && Boolean(account.serviceUrl),
  )
  const selectedBuildAccount =
    accounts.find(
      (account) =>
        account.id === selectedRepo?.buildAccountId && account.platform === 'build',
    ) ?? buildAccounts[0]
  const buildAvailable = Boolean(
    selectedRepo?.buildEnabled !== false && selectedBuildAccount?.serviceUrl,
  )
  const selectedClient = feishuAgentClients.find(
    (client) => client.clientId === selectedFeishuAgentClientId,
  )
  const deliveryWaitTimeoutMs = Math.max(
    60 * 60_000,
    (selectedClient?.health?.deliveryTimeoutMs ?? 210 * 60_000) + 5 * 60_000,
  )
  const localRepoPath = localAgent.repoPaths[repoId]
  const effectiveLocalPath = localRepoPath || selectedRepo?.localPath
  const savedScreenshotCount = selectedItem?.requirementScreenshotCount ?? 0
  const effectiveScreenshotCount =
    screenshots.length > 0 ? screenshots.length : savedScreenshotCount
  const requirementContextIssue =
    selectedItem?.type === 'requirement'
      ? requirementDeliveryContextIssue({
          requirementBreakdown,
          designReference,
          screenshotCount: effectiveScreenshotCount,
        })
      : undefined
  const deliveryStages = useMemo(
    () => {
      const stages = (effectiveDeliveryJob?.steps ?? []).map((step) => ({
        key: step.key,
        name: step.name,
        description: step.description,
        status: step.status,
        log: step.log,
      }))
      const evidence = effectiveDeliveryJob?.result?.evidence
      const optionalStages: typeof stages = []
      if (evidence?.buildReport) {
        optionalStages.push({
          key: 'build',
          name: '自动编译',
          description: '推送后触发项目配置的编译系统',
          status: 'success',
          log: '内部编译已按项目配置触发',
        })
      }
      if (evidence?.upgradeReport) {
        optionalStages.push({
          key: 'upgrade',
          name: '设备升级',
          description: '推送固件到测试设备并完成升级',
          status: 'success',
          log: '检测到真实设备升级证据',
        })
      }
      if (optionalStages.length > 0) {
        const writebackIndex = stages.findIndex((stage) => stage.key === 'writeback')
        if (writebackIndex >= 0) stages.splice(writebackIndex, 0, ...optionalStages)
        else stages.push(...optionalStages)
      }
      return displayDeliveryStages(stages)
    },
    [effectiveDeliveryJob?.result?.evidence, effectiveDeliveryJob?.steps],
  )

  useEffect(() => {
    if (!open) return
    const preferred = availableItems.find((item) => item.id === initialWorkItemId) ?? availableItems[0]
    setWorkItemId(preferred?.id ?? '')
    const preferredRepoId = preferred?.repoId ?? repositories[0]?.id ?? ''
    setRepoId(preferredRepoId)
    const preferredRepo = repositories.find((repo) => repo.id === preferredRepoId)
    setRunBuild(preferredRepo?.buildEnabled ?? true)
    setAutoCommit(true)
    setPushAfterAcceptance(true)
    setAutoClose(true)
    setRequirementBreakdown(preferred?.requirementBreakdown ?? '')
    setDesignReference(preferred?.designReference ?? '')
    setScreenshots([])
    setScreenshotError('')
    setCompressingScreenshots(false)
    requirementContextDirtyRef.current = false
    setDeliveryJob(null)
    setDeliveryError('')
    // Selection should only reset when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialWorkItemId])

  useEffect(() => {
    if (!open || !workItemId || selectedItem?.type !== 'requirement') return
    let cancelled = false
    void api
      .getWorkItemDeliveryContext(workItemId)
      .then((context) => {
        if (cancelled || requirementContextDirtyRef.current) return
        setRequirementBreakdown(context.requirementBreakdown ?? '')
        setDesignReference(context.designReference ?? '')
        setScreenshots(
          context.screenshots.flatMap((screenshot) =>
            isDeliveryScreenshotMimeType(screenshot.mimeType)
              ? [{ ...screenshot, mimeType: screenshot.mimeType }]
              : [],
          ),
        )
        setScreenshotError('')
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open, workItemId, selectedItem?.type])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLocalAgent({
      checking: true,
      online: false,
      platformReady: false,
      configured: false,
      meegleAuthenticated: false,
      codexAvailable: false,
      repoPaths: {},
    })
    void probeLocalDeliveryAgent(selectedFeishuAgentClientId).then((state) => {
      if (!cancelled) setLocalAgent({ ...state, checking: false })
    })
    return () => {
      cancelled = true
    }
  }, [open, selectedFeishuAgentClientId])

  useEffect(() => {
    if (!open || !canControlLocalAgent) {
      setLocalDeliveryJob(null)
      return
    }
    let cancelled = false
    const refresh = async () => {
      try {
        const job = await fetchLocalDeliveryJob()
        if (!cancelled) setLocalDeliveryJob(job)
      } catch {
        if (!cancelled) setLocalDeliveryJob(null)
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [open, canControlLocalAgent])

  useEffect(() => {
    if (open) return
    waitAbortRef.current?.abort()
  }, [open])

  useEffect(() => {
    if (terminatingLocal && localJobInScope?.status !== 'running') {
      setTerminatingLocal(false)
    }
  }, [localJobInScope?.status, terminatingLocal])

  useEffect(
    () => () => {
      waitAbortRef.current?.abort()
    },
    [],
  )

  useEffect(() => {
    if (!open || !progressVisible) return
    const frame = window.requestAnimationFrame(() => {
      progressRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open, progressVisible])

  const handleItemChange = (item: WorkItem | undefined) => {
    setWorkItemId(item?.id ?? '')
    setRequirementBreakdown(item?.requirementBreakdown ?? '')
    setDesignReference(item?.designReference ?? '')
    setScreenshots([])
    setScreenshotError('')
    requirementContextDirtyRef.current = false
    setDeliveryJob(null)
    setDeliveryError('')
    if (item) handleRepoChange(item.repoId)
  }

  const handleRepoChange = (id: string) => {
    setRepoId(id)
    const repository = repositories.find((repo) => repo.id === id)
    setRunBuild(repository?.buildEnabled ?? true)
    setDeliveryJob(null)
    setDeliveryError('')
  }

  const handleClientChange = (clientId: string) => {
    setDeliveryJob(null)
    setDeliveryError('')
    setLocalAgent((current) => ({ ...current, checking: true }))
    void selectFeishuAgentClient(clientId)
  }

  const addScreenshotFiles = async (files: File[]) => {
    if (selectedItem?.type !== 'requirement' || files.length === 0) return
    const available = MAX_DELIVERY_SCREENSHOTS - screenshots.length
    if (available <= 0) {
      notify('截图数量已达上限', `每条需求最多上传 ${MAX_DELIVERY_SCREENSHOTS} 张截图`, 'warning')
      return
    }
    if (files.length > available) {
      notify(
        '部分截图未添加',
        `最多保留 ${MAX_DELIVERY_SCREENSHOTS} 张截图，本次仅处理前 ${available} 张`,
        'warning',
      )
    }

    setCompressingScreenshots(true)
    setScreenshotError('')
    requirementContextDirtyRef.current = true
    const accepted: DeliveryScreenshotUpload[] = []
    const errors: string[] = []
    let totalBytes = screenshots.reduce((total, screenshot) => total + screenshot.sizeBytes, 0)
    for (const file of files.slice(0, available)) {
      try {
        const prepared = await prepareScreenshot(file)
        if (totalBytes + prepared.sizeBytes > MAX_DELIVERY_SCREENSHOTS_TOTAL_BYTES) {
          errors.push(
            `截图合计不能超过 ${Math.floor(MAX_DELIVERY_SCREENSHOTS_TOTAL_BYTES / 1024)}KB，请删除部分截图后重试`,
          )
          continue
        }
        accepted.push(prepared)
        totalBytes += prepared.sizeBytes
      } catch (error) {
        errors.push(error instanceof Error ? error.message : '截图处理失败')
      }
    }
    if (accepted.length > 0) {
      setScreenshots((current) => [...current, ...accepted].slice(0, MAX_DELIVERY_SCREENSHOTS))
    }
    if (errors.length > 0) {
      const message = errors[0]
      setScreenshotError(message)
      notify('截图处理失败', message, 'warning')
    }
    setCompressingScreenshots(false)
  }

  const launch = async () => {
    if (launching) return
    const clientId = selectedFeishuAgentClientId
    if (!clientId) {
      notify('未选择执行客户端', '请先启动客户端代理并在页面选择执行客户端', 'warning')
      return
    }
    if (selectedItem?.type === 'requirement' && requirementContextIssue) {
      notify('缺少需求交付上下文', requirementContextIssue, 'warning')
      return
    }
    if (!selectedRepo) {
      notify('未选择代码仓库', '请先选择一个目标代码仓库', 'warning')
      return
    }
    if (!effectiveLocalPath) {
      notify(
        '缺少客户端代码路径',
        '请先到代码仓库配置绝对路径，或在所选执行客户端的 repoPaths 中配置本机路径',
        'warning',
      )
      return
    }
    if (!localAgent.online) {
      notify('执行客户端离线', '请先在目标机器运行 npm run feishu:agent', 'warning')
      return
    }
    if (!localAgent.configured) {
      notify('执行客户端未绑定平台', '请先到账号中心完成客户端代理绑定', 'warning')
      return
    }
    if (!localAgent.codexAvailable) {
      notify(
        '未找到 Codex CLI',
        '请先在该执行客户端设置 CODEX_BIN 为 Codex 可执行文件绝对路径，再重启代理',
        'warning',
      )
      return
    }
    if (canControlLocalAgent && localDeliveryJob?.status === 'running') {
      notify(
        '本机已有执行中的任务',
        `当前本机代理仍报告 ${localDeliveryJob.workItemId} 正在执行（PID ${localDeliveryJob.processId ?? '未知'}），请先等待完成或终止该任务`,
        'warning',
      )
      return
    }
    const controller = new AbortController()
    terminationRequestedRef.current = false
    waitAbortRef.current = controller
    setLaunching(true)
    setDeliveryError('')
    try {
      if (selectedItem?.type === 'requirement') {
        await api.saveWorkItemDeliveryContext(workItemId, {
          requirementBreakdown: requirementBreakdown.trim(),
          designReference: designReference.trim(),
          ...(screenshots.length > 0 ? { screenshots } : {}),
        })
      }
      const pending = createPendingLocalDeliveryJob({
        workItemId,
        repoId,
        autoCommit,
        pushAfterAcceptance,
        runBuild: runBuild && pushAfterAcceptance && autoCommit && buildAvailable,
        autoClose: autoClose && pushAfterAcceptance && autoCommit,
      })
      setDeliveryJob(pending)
      const started = await startLocalDelivery(
        {
          workItemId,
          repoId,
          autoCommit,
          pushAfterAcceptance,
          runBuild: runBuild && pushAfterAcceptance && autoCommit && buildAvailable,
          autoClose: autoClose && pushAfterAcceptance && autoCommit,
        },
        clientId,
      )
      setDeliveryJob(started)
      void reload(true)
      notify(
        '客户端交付已启动',
        `${workItemId} · ${selectedClient?.clientName ?? clientId} · ${selectedRepo.name}`,
        'info',
      )
      const completed = await waitForLocalDelivery(
        started.id,
        clientId,
        setDeliveryJob,
        deliveryWaitTimeoutMs,
        controller.signal,
      )
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
      if (error instanceof Error && error.name === 'AbortError') {
        if (!terminationRequestedRef.current) {
          notify(
            '执行视图已关闭',
            '本机交付仍在后台继续执行，可从右下角执行入口重新打开查看',
            'info',
          )
        }
        return
      }
      try {
        const localJob = await fetchLocalDeliveryJob()
        if (
          localJob?.status === 'running' &&
          localJob.workItemId === workItemId &&
          localJob.processAlive !== false
        ) {
          setLocalDeliveryJob(localJob)
          setDeliveryError('')
          notify(
            '平台状态已中断，但本机仍在执行',
            `本机 Codex 进程 PID ${localJob.processId ?? '未知'} 仍存活，最近活动于 ${activityLabel(localJob.lastActivityAt)}；可在弹窗中查看或终止`,
            'warning',
          )
          return
        }
      } catch {
        // The platform error remains authoritative when the local agent cannot be reached.
      }
      const message = error instanceof Error ? error.message : '本机交付执行失败'
      setDeliveryJob((current) => {
        if (!current || current.status === 'failed') return current
        return markLocalDeliveryStartFailed(current, message)
      })
      setDeliveryError(message)
      await reload(true).catch(() => undefined)
      notify('本机交付失败', message, 'warning')
      void probeLocalDeliveryAgent(selectedFeishuAgentClientId).then((state) =>
        setLocalAgent({ ...state, checking: false }),
      )
    } finally {
      if (waitAbortRef.current === controller) waitAbortRef.current = null
      setLaunching(false)
    }
  }

  const closeDeliveryView = () => {
    waitAbortRef.current?.abort()
    onClose()
  }

  const terminateLocalTask = async () => {
    if (!localJobInScope || terminatingLocal) return
    terminationRequestedRef.current = true
    setTerminatingLocal(true)
    try {
      const job = await cancelLocalDeliveryJob(localJobInScope.id)
      waitAbortRef.current?.abort()
      setLocalDeliveryJob(job)
      setDeliveryJob(job)
      setDeliveryError('')
      notify(
        '已终止全部操作',
        '已停止本机 Codex 进程组、阶段追踪和页面等待；未提交的代码变更会保留在工作区',
        'info',
      )
    } catch (error) {
      terminationRequestedRef.current = false
      const message = error instanceof Error ? error.message : '终止本机任务失败'
      setDeliveryError(message)
      notify('终止本机任务失败', message, 'warning')
    } finally {
      if (!terminationRequestedRef.current) setTerminatingLocal(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={closeDeliveryView}
      closeOnBackdrop={false}
      closeOnEscape
      title="启动一键交付"
      subtitle="在本机真实执行需求分析、业务 LDD、编码、集成验证、提交与推送；推送后按项目配置决定是否触发系统编译，升级与测试仍仅在真实证据时完成"
      size="lg"
      footer={
        <>
          <span className="modal-footer-hint">
            <ShieldCheck size={15} />{' '}
            {effectiveDeliveryJob?.status === 'running'
              ? `任务正在 ${selectedClient?.clientName ?? '执行客户端'} 执行；页面刷新或关闭只影响查看，不会终止本机 Codex`
              : localAgent.checking
              ? '正在检测所选执行客户端'
              : requirementContextIssue
                ? requirementContextIssue
              : !localFeishuAgentClientId
                ? feishuAgentClients.length > 0
                  ? '当前页面所在终端未注册执行代理；下方客户端属于其他机器。请先在本机项目目录运行 npm run feishu:agent'
                  : '当前终端未检测到执行代理，请先在本机项目目录运行 npm run feishu:agent'
              : !selectedFeishuAgentClientId
                ? feishuAgentClients.length > 0
                  ? '请先明确选择执行客户端，平台不会再自动选择机器'
                  : '尚未发现执行客户端，请先在目标机器运行 npm run feishu:agent'
              : !localAgent.platformReady
                ? localAgent.error || '平台服务端未升级，当前无法下发本机交付'
              : !localAgent.online
                ? localAgent.error || '执行客户端离线，请先在目标机器运行 npm run feishu:agent'
                : !localAgent.configured
                  ? '执行客户端已启动但尚未绑定平台同步密钥，请先到账号中心完成绑定'
                  : !localAgent.codexAvailable
                    ? '未检测到 Codex CLI，请设置 CODEX_BIN 为可执行文件绝对路径后重启代理'
                    : localJobRunning
                      ? `本机任务仍在执行${localJobInScope?.processId ? `（PID ${localJobInScope.processId}）` : ''}；最近活动 ${activityLabel(localJobInScope?.lastActivityAt)}`
                    : '点击后由所选执行客户端在配置路径直接执行 Codex，只有真实代码变更才会创建提交'}
          </span>
          <div className="modal-footer-actions">
            {canControlLocalAgent && localJobInScope?.status === 'running' && (
              <button
                className="btn btn-danger"
                onClick={() => void terminateLocalTask()}
                disabled={terminatingLocal}
                title="终止本机 Codex 进程组、全部子进程、阶段追踪和页面等待"
              >
                {terminatingLocal ? '正在终止…' : '终止全部操作'}
              </button>
            )}
            <button
              className="btn btn-secondary"
              onClick={closeDeliveryView}
              title={
                effectiveDeliveryJob?.status === 'running'
                  ? '只关闭当前视图并停止页面等待，本机执行继续运行；可从右下角执行入口重新打开'
                  : undefined
              }
            >
              {effectiveDeliveryJob?.status === 'running' ? '仅关闭视图' : '关闭'}
            </button>
            <button
              className="btn btn-primary"
              onClick={launch}
              disabled={
                !workItemId ||
                !repoId ||
                Boolean(requirementContextIssue) ||
                compressingScreenshots ||
                launching ||
                localJobRunning ||
                !selectedFeishuAgentClientId ||
                localAgent.checking ||
                !localAgent.online ||
                !localAgent.platformReady ||
                !localAgent.configured ||
                !localAgent.codexAvailable
              }
            >
              {launching ? '客户端执行中…' : '一键客户端执行'} <ArrowRight size={16} />
            </button>
          </div>
        </>
      }
    >
      <div className="delivery-dialog-grid">
        <div className="delivery-form">
          {(effectiveDeliveryJob || effectiveDeliveryError || localJobInScope) && (
            <div
              ref={progressRef}
              className={`delivery-progress-panel ${effectiveDeliveryJob?.status ?? 'failed'}`}
            >
              <div className="delivery-progress-head">
                <div>
                  <span className="eyebrow">
                    <Terminal size={13} /> LOCAL EXECUTION
                  </span>
                  <h3>{deliveryStatusLabel(effectiveDeliveryJob, effectiveDeliveryError)}</h3>
                </div>
                {effectiveDeliveryJob && (
                  <span className={`delivery-progress-status ${effectiveDeliveryJob.status}`}>
                    {effectiveDeliveryJob.status === 'running'
                      ? '执行中'
                      : effectiveDeliveryJob.status === 'succeeded'
                        ? '已完成'
                        : '已失败'}
                  </span>
                )}
              </div>
              {effectiveDeliveryJob && (
                <div className="delivery-progress-metrics">
                  <div>
                    <span>{effectiveDeliveryJob.status === 'running' ? '已运行' : '总耗时'}</span>
                    <strong>
                      {elapsedLabel(effectiveDeliveryJob.startedAt, effectiveDeliveryJob.finishedAt)}
                    </strong>
                  </div>
                  <div>
                    <span>最近心跳</span>
                    <strong className={heartbeatStale ? 'warning' : ''}>
                      {activityLabel(effectiveDeliveryJob.lastActivityAt)}
                    </strong>
                  </div>
                  <div>
                    <span>本机进程</span>
                    <strong className={processExited ? 'warning' : ''}>
                      {processExited
                        ? '已退出'
                        : effectiveDeliveryJob.status !== 'running'
                          ? effectiveDeliveryJob.status === 'succeeded'
                            ? '已完成'
                            : '已结束'
                          : effectiveDeliveryJob.processAlive
                            ? `存活${effectiveDeliveryJob.processId ? ` #${effectiveDeliveryJob.processId}` : ''}`
                            : '等待上报'}
                    </strong>
                  </div>
                  <div>
                    <span>代码变更</span>
                    <strong>
                      {effectiveDeliveryJob.changedFileCount === undefined
                        ? effectiveDeliveryJob.status === 'running'
                          ? '等待检测'
                          : '未采集'
                        : `${effectiveDeliveryJob.changedFileCount} 个文件`}
                    </strong>
                  </div>
                  <div>
                    <span>最近产物</span>
                    <strong>
                      {activityLabel(effectiveDeliveryJob.artifactChangedAt)}
                    </strong>
                  </div>
                  <div>
                    <span>差异行</span>
                    <strong>
                      +{effectiveDeliveryJob.diffAddedLines ?? 0} / -{effectiveDeliveryJob.diffRemovedLines ?? 0}
                    </strong>
                  </div>
                </div>
              )}
              {effectiveDeliveryJob?.status === 'running' && (
                <p className="delivery-progress-note">
                  <ShieldCheck size={13} />
                  “仅关闭视图”只会关闭当前界面，执行会继续；“终止全部操作”会停止本机 Codex 进程组、全部子进程和页面等待。
                </p>
              )}
              {effectiveDeliveryJob?.status === 'running' && heartbeatStale && (
                <p className="delivery-progress-warning">
                  <AlertTriangle size={14} />
                  已超过 30 秒没有收到本机进度上报，可能是网络或代理心跳延迟。
                </p>
              )}
              {processExited && (
                <p className="delivery-progress-warning">
                  <AlertTriangle size={14} />
                  本机 Codex 进程已退出，但平台仍显示执行中；代理可能正在收尾，或需要重新检查执行日志。
                </p>
              )}
              {workspaceStale && (
                <p className="delivery-progress-warning">
                  <AlertTriangle size={14} />
                  {effectiveDeliveryJob?.changedFileCount
                    ? '代码和交付产物已连续 5 分钟没有更新'
                    : '编码阶段已运行 5 分钟，仍未检测到代码或交付产物更新'}
                  ，可能正在执行测试/构建，也可能已停在等待状态。
                  {effectiveDeliveryJob?.workspaceChangedAt
                    ? ` 最近文件变化：${activityLabel(effectiveDeliveryJob.workspaceChangedAt)}`
                    : ''}
                </p>
              )}
              {(effectiveDeliveryJob?.recentChangedFiles?.length ?? 0) > 0 && (
                <p className="delivery-progress-files">
                  最近变更：{effectiveDeliveryJob?.recentChangedFiles?.join('、')}
                </p>
              )}
              {effectiveDeliveryJob?.artifactChangedFile && (
                <p className="delivery-progress-files">
                  最近更新产物：{effectiveDeliveryJob.artifactChangedFile}
                  {effectiveDeliveryJob.artifactChangedAt
                    ? ` · ${activityLabel(effectiveDeliveryJob.artifactChangedAt)}`
                    : ''}
                </p>
              )}
              {localJobInScope && (
                <div className={`delivery-local-process ${localJobInScope.status}`}>
                  <div>
                    <strong>
                      本机代理：{localJobInScope.status === 'running'
                        ? localJobInScope.processAlive === false
                          ? '进程已退出，代理状态尚未收尾'
                          : 'Codex 仍在执行'
                        : localJobInScope.status === 'succeeded'
                          ? '已执行完成'
                          : '已执行失败'}
                    </strong>
                    <span>
                      PID {localJobInScope.processId ?? '未知'} · 最近活动{' '}
                      {activityLabel(localJobInScope.lastActivityAt)}
                    </span>
                  </div>
                  {localJobInScope.stage && <p>{localJobInScope.stage}</p>}
                </div>
              )}
              {deliveryStages.length > 0 && <PipelineSteps stages={deliveryStages} compact />}
              <div className="delivery-progress-logs">
                {(effectiveDeliveryJob?.steps ?? []).map((step) => (
                  <div className={`delivery-progress-log ${step.status}`} key={step.key}>
                    <span className="delivery-progress-log-dot" />
                    <strong>{step.name}</strong>
                    <span className="delivery-progress-log-copy">
                      {step.log ?? step.description}
                    </span>
                    <span className="delivery-progress-log-duration">
                      {stepDurationLabel(step)}
                    </span>
                  </div>
                ))}
                {effectiveDeliveryError && (
                  <div className="delivery-progress-error">
                    <AlertTriangle size={15} />
                    <span>{effectiveDeliveryError}</span>
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

          {selectedItem?.type === 'requirement' && (
            <section
              className={`requirement-context ${requirementContextIssue ? 'incomplete' : 'ready'}`}
            >
              <div className="requirement-context-head">
                <div>
                  <span className="eyebrow">
                    <FileText size={13} /> REQUIREMENT INPUT
                  </span>
                  <strong>需求交付上下文</strong>
                  <small>需求拆解、设计稿、设计截图三选一，Codex 会在编码前先读取</small>
                </div>
                <span className={`requirement-context-state ${requirementContextIssue ? 'missing' : 'ready'}`}>
                  {requirementContextIssue ? '待补充' : '已就绪'}
                </span>
              </div>

              <div className="field">
                <span className="field-label">
                  需求拆解
                  <small>
                    {requirementBreakdown.trim().length} / 至少 {REQUIREMENT_BREAKDOWN_MIN_LENGTH} 字
                  </small>
                </span>
                <textarea
                  value={requirementBreakdown}
                  onChange={(event) => {
                    requirementContextDirtyRef.current = true
                    setRequirementBreakdown(event.target.value)
                  }}
                  placeholder="填写目标、范围、验收标准、影响模块；例如：新增第三方设备私有指标采集，覆盖列表展示与详情抽屉，兼容旧设备数据，并提供单元测试。"
                  rows={4}
                />
              </div>

              <div className="field">
                <span className="field-label">
                  设计稿链接或本地路径
                  <small>支持飞书/Figma 链接或客户端绝对路径</small>
                </span>
                <div className="input-with-icon">
                  <Link2 size={15} />
                  <input
                    value={designReference}
                    onChange={(event) => {
                      requirementContextDirtyRef.current = true
                      setDesignReference(event.target.value)
                    }}
                    placeholder="https://… 或 /Users/…/design.md"
                  />
                </div>
              </div>

              <div className="field screenshot-field">
                <span className="field-label">
                  设计截图
                  <small>
                    {screenshots.length}/{MAX_DELIVERY_SCREENSHOTS} 张 · 单张自动压缩到 500KB 内
                  </small>
                </span>
                <div
                  className={`screenshot-uploader ${compressingScreenshots ? 'busy' : ''}`}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault()
                    void addScreenshotFiles(
                      Array.from(event.dataTransfer.files).filter((file) =>
                        file.type.startsWith('image/'),
                      ),
                    )
                  }}
                  onPaste={(event) => {
                    const files = Array.from(event.clipboardData.files).filter((file) =>
                      file.type.startsWith('image/'),
                    )
                    if (files.length === 0) return
                    event.preventDefault()
                    void addScreenshotFiles(files)
                  }}
                >
                  <input
                    ref={screenshotInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    hidden
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? [])
                      event.target.value = ''
                      void addScreenshotFiles(files)
                    }}
                  />
                  {screenshots.map((screenshot, index) => (
                    <div className="screenshot-thumb" key={`${screenshot.name}-${index}`}>
                      <img src={screenshot.dataUrl} alt={screenshot.name} />
                      <button
                        type="button"
                        aria-label={`删除截图 ${screenshot.name}`}
                        onClick={() => {
                          requirementContextDirtyRef.current = true
                          setScreenshots((current) => current.filter((_, itemIndex) => itemIndex !== index))
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                      <span title={screenshot.name}>{screenshot.name}</span>
                    </div>
                  ))}
                  {screenshots.length < MAX_DELIVERY_SCREENSHOTS && (
                    <button
                      type="button"
                      className="screenshot-add"
                      disabled={compressingScreenshots}
                      onClick={() => screenshotInputRef.current?.click()}
                    >
                      <ImagePlus size={20} />
                      <span>{compressingScreenshots ? '压缩中…' : '添加截图'}</span>
                      <small>点击 / 拖拽 / 粘贴</small>
                    </button>
                  )}
                </div>
                {savedScreenshotCount > 0 && screenshots.length === 0 && (
                  <small className="screenshot-saved-note">
                    已保存 {savedScreenshotCount} 张截图，正在读取预览或将在执行时继续使用
                  </small>
                )}
                {screenshotError && <div className="form-error">{screenshotError}</div>}
              </div>

              {requirementContextIssue && (
                <div className="form-error requirement-context-error">
                  <AlertTriangle size={14} />
                  <span>{requirementContextIssue}</span>
                </div>
              )}
            </section>
          )}
          <Field
            label="执行客户端"
            required
            hint={
              selectedClient
                ? `${selectedClient.online ? '在线' : '离线'} · ${selectedClient.machineName || '未知机器'} · ${selectedClient.clientId.slice(0, 8)} · ${Object.keys(selectedClient.health?.config.repoPaths ?? {}).length} 个仓库专属路径`
                : '请先启动至少一个 feishu:agent 客户端代理'
            }
          >
            <select
              value={selectedFeishuAgentClientId ?? ''}
              onChange={(event) => handleClientChange(event.target.value)}
              disabled={launching || feishuAgentClients.length === 0}
            >
              {!selectedFeishuAgentClientId && (
                <option value="">
                  {feishuAgentClients.length > 0 ? '请选择执行客户端' : '未发现执行客户端'}
                </option>
              )}
              {feishuAgentClients.map((client) => (
                <option
                  key={client.clientId}
                  value={client.clientId}
                  disabled={!client.online && client.clientId !== selectedFeishuAgentClientId}
                >
                  {client.clientName}
                  {client.clientId === localFeishuAgentClientId ? '（当前终端）' : ''}
                  {client.machineName && client.machineName !== client.clientName
                    ? ` · ${client.machineName}`
                    : ''}{' '}
                  · {client.online ? '在线' : '离线'} ·{' '}
                  {client.clientId.slice(0, 8)}
                </option>
              ))}
            </select>
          </Field>

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
            <Field
              label="目标分支"
              hint={
                deliveryJob?.branch
                  ? '本机实际分支'
                  : '平台默认值，执行时以本机实际分支为准'
              }
            >
              <div className="input-with-icon readonly-input">
                <GitBranch size={15} />
                <span>{deliveryJob?.branch ?? selectedRepo?.branch ?? '-'}</span>
              </div>
            </Field>
          </div>

          <Field label="执行位置" hint="代码只在所选执行客户端运行，服务端不提供模拟交付入口">
            <div className="input-with-icon readonly-input">
              <Terminal size={15} />
              <span>
                客户端本地 ·{' '}
                {selectedClient
                  ? `${selectedClient.clientName}${selectedClient.clientId === localFeishuAgentClientId ? '（当前终端）' : ''}${selectedClient.machineName && selectedClient.machineName !== selectedClient.clientName ? ` (${selectedClient.machineName})` : ''}`
                  : selectedFeishuAgentClientId ?? '未选择'}
              </span>
            </div>
          </Field>

          <Field
            label="客户端代码路径"
            hint={
              selectedClient && selectedClient.clientId !== localFeishuAgentClientId
                ? `当前路径来自所选客户端 ${selectedClient.clientName}；代码会在这台客户端执行，不会在页面所在终端执行`
                : localRepoPath
                  ? '当前终端代理已为这个仓库配置专属路径，优先于平台共享路径'
                  : effectiveLocalPath
                    ? '使用平台仓库路径；如当前终端路径不同，请为代理配置 repoPaths'
                    : '当前终端代理未配置代码路径，无法一键执行；请先到代码仓库填写'
            }
          >
            <div className="input-with-icon readonly-input">
              <FolderGit2 size={15} />
              <span>{effectiveLocalPath || '未配置'}</span>
            </div>
          </Field>

          <div className="automation-options">
            <label className="check-row">
              <input
                type="checkbox"
                checked={autoCommit}
                onChange={(e) => {
                  setAutoCommit(e.target.checked)
                  if (!e.target.checked) {
                    setPushAfterAcceptance(false)
                    setAutoClose(false)
                  }
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
                onChange={(e) => {
                  setPushAfterAcceptance(e.target.checked)
                  if (!e.target.checked) setAutoClose(false)
                }}
              />
              <span className="custom-check" />
              <span>
                <strong>验收通过后推送</strong>
                <small>勾选即授权；推送成功后按本次选择决定是否触发系统编译</small>
              </span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={runBuild && pushAfterAcceptance && buildAvailable}
                disabled={!pushAfterAcceptance || !buildAvailable}
                onChange={(event) => setRunBuild(event.target.checked)}
              />
              <span className="custom-check" />
              <span>
                <strong>执行系统编译</strong>
                <small>
                  {selectedRepo && selectedRepo.buildEnabled === false
                    ? '仓库已关闭“推送后执行系统编译”；本次交付跳过编译，提交、推送与缺陷关闭继续执行'
                    : selectedBuildAccount
                    ? `${selectedBuildAccount.label} · ${selectedBuildAccount.serviceUrl}；关闭后本次交付不触发编译`
                    : '当前项目未绑定带服务地址的编译系统，请先到代码仓库配置'}
                </small>
              </span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={autoClose && pushAfterAcceptance}
                disabled={!pushAfterAcceptance}
                onChange={(e) => setAutoClose(e.target.checked)}
              />
              <span className="custom-check" />
              <span>
                <strong>自动关闭缺陷</strong>
                <small>代码提交并推送成功后，将飞书缺陷状态更新为已解决</small>
              </span>
            </label>
          </div>

          {(effectiveDeliveryJob || effectiveDeliveryError) && (
            <Field
              label={`${selectedClient?.clientName ?? '执行客户端'}状态`}
              hint={`执行客户端 ${
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
                  <strong>{deliveryStatusLabel(effectiveDeliveryJob, effectiveDeliveryError)}</strong>
                  <p>{effectiveDeliveryError || effectiveDeliveryJob?.error || effectiveDeliveryJob?.stage || '正在准备执行'}</p>
                  {localJobInScope && (
                    <p>
                      本机代理 PID <code>{localJobInScope.processId ?? '未知'}</code> · 最近活动 {activityLabel(localJobInScope.lastActivityAt)}
                      {localJobInScope.processAlive === false ? ' · 进程已退出' : ''}
                    </p>
                  )}
                  {effectiveDeliveryJob?.localPath && (
                    <p>
                      <code>{effectiveDeliveryJob.localPath}</code>
                      {effectiveDeliveryJob.branch ? ` · ${effectiveDeliveryJob.branch}` : ''}
                    </p>
                  )}
                  {effectiveDeliveryJob?.result?.commit && (
                    <p>
                      提交 <code>{effectiveDeliveryJob.result.commit.slice(0, 12)}</code>
                      {effectiveDeliveryJob.result.changedFiles?.length
                        ? ` · ${effectiveDeliveryJob.result.changedFiles.length} 个代码文件有变更`
                        : ''}
                    </p>
                  )}
                  {effectiveDeliveryJob?.result?.changedFiles && effectiveDeliveryJob.result.changedFiles.length > 0 && (
                    <p>
                      {effectiveDeliveryJob.result.changedFiles.slice(0, 8).join(', ')}
                      {effectiveDeliveryJob.result.changedFiles.length > 8 ? ' …' : ''}
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
                点击“一键本机执行”后，页面通过平台命令队列把任务只下发给所选执行客户端的 <code>npm run feishu:agent</code> 代理。代理从平台读取仓库路径与分支，在本地校验 Git 工作区后调用 Codex 完成设计、编码、验证与提交；勾选验收后推送时才会写入远程分支。
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
              <small>{deliveryJob?.branch ?? selectedRepo?.branch ?? '-'}</small>
            </div>
            <div>
              <FileText size={15} />
              <span>需求分析 · 业务 LDD · 自动编码</span>
              <small>确认影响范围、生成本次业务 LDD 并实现代码</small>
            </div>
            <div>
              <GitMerge size={15} />
              <span>检查证据 · 提交推送 · 回写并关闭缺陷</span>
              <small>验证通过后推送本机实际分支，并按配置追加编译与设备升级</small>
            </div>
          </div>
          <div className="preview-footer">
            <span>{deliveryStages.length || 7} 个执行阶段</span>
            <span>3 份交付报告</span>
          </div>
        </aside>
      </div>
    </Modal>
  )
}
