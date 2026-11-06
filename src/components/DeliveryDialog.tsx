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
  getCloudDeliveryReadiness,
  markLocalDeliveryStartFailed,
  pipelineFromDeliveryResult,
  probeLocalDeliveryAgent,
  startLocalDelivery,
  startCloudDelivery,
  waitForLocalDelivery,
  waitForCloudDelivery,
  type CloudDeliveryReadiness,
  type LocalDeliveryAgentReadiness,
} from '../localDeliveryAgent'
import { prepareScreenshot } from '../screenshotCompression'
import { useData } from '../store'
import type { LocalDeliveryJob, PipelineRun, WorkItem } from '../types'
import { searchWorkItems } from '../workItemSearch'
import { PipelineSteps } from './PipelineSteps'
import { Field, Modal, StatusBadge } from './ui'

const MAX_VISIBLE_WORK_ITEMS = 50

function deliveryStatusLabel(job: LocalDeliveryJob | null, error: string): string {
  if (error || job?.status === 'failed') return '交付执行失败'
  if (job?.status === 'succeeded') return '交付执行完成'
  if (job?.status === 'running') return '交付执行中'
  return '等待交付执行'
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
    feishuAgentClients,
    selectedFeishuAgentClientId,
    localFeishuAgentClientId,
    selectFeishuAgentClient,
  } = useData()
  const [workItemId, setWorkItemId] = useState('')
  const [repoId, setRepoId] = useState('')
  const [autoCommit, setAutoCommit] = useState(true)
  const [pushAfterAcceptance, setPushAfterAcceptance] = useState(true)
  const [autoClose, setAutoClose] = useState(true)
  const [executionMode, setExecutionMode] = useState<'auto' | 'mac' | 'server'>('auto')
  const [cloudReadiness, setCloudReadiness] = useState<CloudDeliveryReadiness | null>(null)
  const [cloudReadinessChecking, setCloudReadinessChecking] = useState(false)
  const [requirementBreakdown, setRequirementBreakdown] = useState('')
  const [designReference, setDesignReference] = useState('')
  const [screenshots, setScreenshots] = useState<DeliveryScreenshotUpload[]>([])
  const [screenshotError, setScreenshotError] = useState('')
  const [compressingScreenshots, setCompressingScreenshots] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [deliveryJob, setDeliveryJob] = useState<LocalDeliveryJob | null>(null)
  const [deliveryError, setDeliveryError] = useState('')
  const progressRef = useRef<HTMLDivElement | null>(null)
  const waitAbortRef = useRef<AbortController | null>(null)
  const screenshotInputRef = useRef<HTMLInputElement | null>(null)
  const requirementContextDirtyRef = useRef(false)
  const progressVisible = Boolean(deliveryJob || deliveryError)
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
  const selectedClient = feishuAgentClients.find(
    (client) => client.clientId === selectedFeishuAgentClientId,
  )
  const localMacSelected = Boolean(
    localFeishuAgentClientId && selectedFeishuAgentClientId === localFeishuAgentClientId,
  )
  const localRepoPath = localAgent.repoPaths[repoId]
  const effectiveLocalPath = localRepoPath || selectedRepo?.localPath
  const macAgentReady = Boolean(
    selectedFeishuAgentClientId &&
      localAgent.online &&
      localAgent.platformReady &&
      localAgent.configured &&
      localAgent.codexAvailable,
  )
  const canUseMacAutomatically = macAgentReady && Boolean(effectiveLocalPath || localMacSelected)
  const serverExecution =
    executionMode === 'server' ||
    (executionMode === 'auto' && !canUseMacAutomatically)
  const macExecution = !serverExecution
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
    setExecutionMode('auto')
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
    if (!open) return
    let cancelled = false
    setCloudReadinessChecking(true)
    void getCloudDeliveryReadiness()
      .then((state) => {
        if (!cancelled) setCloudReadiness(state)
      })
      .catch((error) => {
        if (!cancelled) {
          setCloudReadiness({
            available: false,
            gitAvailable: false,
            runnerAvailable: false,
            codexAvailable: false,
            allowedGitHostsConfigured: false,
            platformUrlConfigured: false,
            busy: false,
            reason: error instanceof Error ? error.message : '无法读取服务器执行状态',
          })
        }
      })
      .finally(() => {
        if (!cancelled) setCloudReadinessChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (open) return
    waitAbortRef.current?.abort()
  }, [open])

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
    if (selectedItem?.type === 'requirement' && requirementContextIssue) {
      notify('缺少需求交付上下文', requirementContextIssue, 'warning')
      return
    }
    if (!selectedRepo) {
      notify('未选择代码仓库', '请先选择一个目标代码仓库', 'warning')
      return
    }
    if (macExecution) {
      if (!clientId) {
        notify('未选择执行客户端', '请先启动客户端代理并在页面选择执行客户端', 'warning')
        return
      }
      if (!localAgent.online) {
        notify('执行客户端离线', '请先在目标机器启动代理，或改用服务器临时检出', 'warning')
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
    } else if (!cloudReadiness?.available || cloudReadiness.busy) {
      notify(
        '服务器执行暂不可用',
        cloudReadiness?.busy ? '服务器已有临时交付任务运行，请稍后重试' : cloudReadiness?.reason || '服务器执行环境未就绪',
        'warning',
      )
      return
    }
    const deliveryInput = {
      workItemId,
      repoId,
      autoCommit: serverExecution || autoCommit,
      pushAfterAcceptance: serverExecution || pushAfterAcceptance,
      autoClose,
      temporaryCheckout: serverExecution,
    }
    const controller = new AbortController()
    waitAbortRef.current = controller
    setLaunching(true)
    setDeliveryError('')
    let usedServerFallback = false
    try {
      if (selectedItem?.type === 'requirement') {
        await api.saveWorkItemDeliveryContext(workItemId, {
          requirementBreakdown: requirementBreakdown.trim(),
          designReference: designReference.trim(),
          ...(screenshots.length > 0 ? { screenshots } : {}),
        })
      }
      const pending = createPendingLocalDeliveryJob({
        ...deliveryInput,
      })
      setDeliveryJob(pending)
      let completed: LocalDeliveryJob
      if (serverExecution) {
        const started = await startCloudDelivery(deliveryInput)
        setDeliveryJob(started)
        notify('服务器临时交付已启动', `${workItemId} · 服务器临时检出 · ${selectedRepo.name}`, 'info')
        completed = await waitForCloudDelivery(started.id, setDeliveryJob, 60 * 60_000, controller.signal)
      } else {
        const started = await startLocalDelivery(deliveryInput, clientId!)
        setDeliveryJob(started)
        notify(
          'Mac 本地交付已启动',
          `${workItemId} · ${selectedClient?.clientName ?? clientId} · ${selectedRepo.name}`,
          'info',
        )
        try {
          completed = await waitForLocalDelivery(
            started.id,
            clientId!,
            setDeliveryJob,
            45 * 60_000,
            controller.signal,
          )
        } catch (error) {
          const localJob =
            error instanceof Error
              ? (error as Error & { localDeliveryJob?: LocalDeliveryJob }).localDeliveryJob
              : undefined
          const checkoutLog = localJob?.steps?.find((step) => step.key === 'checkout')?.log ?? ''
          const repositoryMissing =
            executionMode === 'auto' &&
            localJob?.status === 'failed' &&
            /尚未配置当前客户端的代码路径|不存在代码目录|不是 Git 工作区|读取 Git 工作区失败/.test(checkoutLog)
          if (!repositoryMissing) throw error
          if (!deliveryInput.autoCommit || !deliveryInput.pushAfterAcceptance) {
            throw new Error('Mac 未找到该仓库；服务器临时检出需要启用自动提交和推送，请确认后重试')
          }
          if (!cloudReadiness?.available || cloudReadiness.busy) {
            throw new Error(
              `Mac 未找到该仓库，且服务器临时执行不可用：${cloudReadiness?.reason || '服务器正忙'}`,
            )
          }
          usedServerFallback = true
          setExecutionMode('server')
          setDeliveryJob(localJob)
          notify('Mac 未找到仓库，已回退服务器', '服务器将临时检出目标仓库，完成后清理', 'info')
          const serverInput = {
            ...deliveryInput,
            autoCommit: true,
            pushAfterAcceptance: true,
            temporaryCheckout: true,
          }
          const cloudJob = await startCloudDelivery(serverInput)
          setDeliveryJob(cloudJob)
          completed = await waitForCloudDelivery(
            cloudJob.id,
            setDeliveryJob,
            60 * 60_000,
            controller.signal,
          )
        }
      }
      setDeliveryJob(completed)
      await reload(true)
      await refreshWorkItems(true).catch(() => undefined)
      const run = pipelineFromDeliveryResult(completed.result)
      if (!run) {
        notify(
          '交付完成',
          '代码已执行完成，但平台未返回流水线记录，请刷新流水线列表查看',
          'warning',
        )
        onClose()
        return
      }
      notify('交付完成', `${run.id} · ${run.branch}`, 'success')
      onClose()
      onStarted(run)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        notify(
          '已停止等待',
          serverExecution || usedServerFallback
            ? '服务器任务仍会在后台运行，可稍后刷新查看结果'
            : 'Mac 交付仍会在客户端后台继续执行，可稍后在流水线中查看结果',
          'info',
        )
        return
      }
      const message = error instanceof Error ? error.message : '交付执行失败'
      setDeliveryJob((current) => {
        if (!current || current.status === 'failed') return current
        return markLocalDeliveryStartFailed(current, message)
      })
      setDeliveryError(message)
      notify('交付失败', message, 'warning')
      if (macExecution && !usedServerFallback) {
        void probeLocalDeliveryAgent(selectedFeishuAgentClientId).then((state) =>
          setLocalAgent({ ...state, checking: false }),
        )
      }
    } finally {
      if (waitAbortRef.current === controller) waitAbortRef.current = null
      setLaunching(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="启动一键交付"
      subtitle="优先使用当前 Mac 的现有仓库；本机没有仓库路径时可在服务器临时检出并清理"
      size="lg"
      footer={
        <>
          <span className="modal-footer-hint">
            <ShieldCheck size={15} />{' '}
            {requirementContextIssue
              ? requirementContextIssue
              : serverExecution
                ? cloudReadinessChecking
                  ? '正在检查服务器 Git、Codex 和仓库主机白名单'
                  : !cloudReadiness?.available
                    ? cloudReadiness?.reason || '服务器临时执行环境未就绪'
                    : cloudReadiness.busy
                      ? '服务器已有临时交付任务运行，请稍后重试'
                      : '服务器会临时检出仓库，提交推送成功后清理工作区'
                : localAgent.checking
                  ? '正在检测 Mac 执行客户端'
                  : !localFeishuAgentClientId
                    ? '当前浏览器没有 Mac 执行客户端；可切换到自动模式使用服务器临时检出'
                    : !selectedFeishuAgentClientId
                      ? '请选择已绑定的 Mac 执行客户端'
                      : !effectiveLocalPath
                        ? 'Mac 代理会先按 Git 地址查找已有仓库；需要服务器回退时请使用自动模式'
                        : !localAgent.platformReady
                          ? localAgent.error || '平台服务端未升级，当前无法下发 Mac 交付'
                          : !localAgent.online
                            ? localAgent.error || 'Mac 执行客户端离线'
                            : !localAgent.configured
                              ? 'Mac 执行客户端尚未绑定平台同步密钥'
                              : !localAgent.codexAvailable
                                ? '未检测到 Mac 上的 Codex CLI，请设置 CODEX_BIN 后重启代理'
                                : '将使用 Mac 已有仓库执行；只有真实代码变更才会创建提交'}
          </span>
          <div className="modal-footer-actions">
            <button
              className="btn btn-secondary"
              onClick={onClose}
              title={launching ? '停止页面轮询，交付任务会在后台继续执行' : undefined}
            >
              {launching ? '停止等待' : '取消'}
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
                (serverExecution
                  ? cloudReadinessChecking || !cloudReadiness?.available || Boolean(cloudReadiness?.busy)
                  : !selectedFeishuAgentClientId ||
                    localAgent.checking ||
                    !localAgent.online ||
                    !localAgent.platformReady ||
                    !localAgent.configured ||
                    !localAgent.codexAvailable)
              }
            >
              {launching
                ? serverExecution ? '服务器执行中…' : 'Mac 执行中…'
                : serverExecution ? '一键服务器临时执行' : '一键 Mac 执行'} <ArrowRight size={16} />
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
                    <Terminal size={13} /> {serverExecution ? 'SERVER EXECUTION' : 'MAC EXECUTION'}
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
            label="执行位置"
            required
            hint={
              executionMode === 'auto'
                ? serverExecution
                  ? localAgent.checking
                    ? '正在检测 Mac 代理；不可用时将使用服务器临时检出'
                    : !macAgentReady
                      ? 'Mac 代理未就绪，将使用服务器临时检出'
                      : 'Mac 没有找到仓库，将使用服务器临时检出'
                  : effectiveLocalPath
                  ? '已配置 Mac 仓库路径，默认直接使用现有工作区；没有路径时自动回退到服务器临时检出'
                  : 'Mac 代理会按 Git 地址搜索常用工作区；找不到该仓库时自动回退到服务器临时检出'
                : serverExecution
                  ? cloudReadinessChecking
                    ? '正在检查服务器的 Git、Codex 和仓库主机白名单'
                    : cloudReadiness?.reason || '服务器任务完成后会清理临时仓库，提交必须推送成功'
                  : effectiveLocalPath
                    ? '使用当前 Mac 已有仓库，不会临时检出或清理本机代码'
                    : '当前仓库没有配置 Mac 路径，请选择自动或服务器临时检出'
            }
          >
            <select
              value={executionMode}
              onChange={(event) => setExecutionMode(event.target.value as 'auto' | 'mac' | 'server')}
              disabled={launching}
            >
              <option value="auto">自动：优先使用 Mac 现有仓库，找不到时服务器临时检出</option>
              <option value="mac">当前 Mac：使用已有仓库并自动查找路径</option>
              <option value="server">服务器：临时检出并在结束后清理</option>
            </select>
          </Field>

          {macExecution && (
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
                    · {client.online ? '在线' : '离线'} · {client.clientId.slice(0, 8)}
                  </option>
                ))}
              </select>
            </Field>
          )}

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
                  ? (serverExecution ? '服务器临时检出的目标分支' : 'Mac 本机实际分支')
                  : '平台仓库默认分支'
              }
            >
              <div className="input-with-icon readonly-input">
                <GitBranch size={15} />
                <span>{deliveryJob?.branch ?? selectedRepo?.branch ?? '-'}</span>
              </div>
            </Field>
          </div>

          {macExecution ? (
            <Field
              label="Mac 本机代码路径"
              hint={
                selectedClient && selectedClient.clientId !== localFeishuAgentClientId
                  ? `路径来自所选客户端 ${selectedClient.clientName}；该机器需已存在此仓库`
                  : localRepoPath
                    ? '使用当前 Mac 代理的仓库专属路径'
                    : effectiveLocalPath
                      ? '使用平台仓库设置的本机路径'
                      : 'Mac 代理会按 Git 地址查找常用工作区；找不到时请使用自动模式回退到服务器'
              }
            >
              <div className="input-with-icon readonly-input">
                <FolderGit2 size={15} />
                <span>{effectiveLocalPath || '未配置'}</span>
              </div>
            </Field>
          ) : (
            <Field
              label="服务器临时执行环境"
              hint={cloudReadinessChecking ? '正在检查服务器环境' : cloudReadiness?.reason || '服务器工作区仅在任务期间保留'}
            >
              <div className="input-with-icon readonly-input">
                <Terminal size={15} />
                <span>
                  {cloudReadiness?.available
                    ? cloudReadiness.busy
                      ? '服务器正在执行其他交付'
                      : 'Git、Codex 和仓库白名单已就绪'
                    : '服务器执行环境尚未就绪'}
                </span>
              </div>
            </Field>
          )}

          <div className="automation-options">
            <label className="check-row">
              <input
                type="checkbox"
                checked={serverExecution || autoCommit}
                disabled={serverExecution}
                onChange={(e) => {
                  setAutoCommit(e.target.checked)
                  if (!e.target.checked) setPushAfterAcceptance(false)
                }}
              />
              <span className="custom-check" />
              <span>
                <strong>自动提交代码</strong>
                <small>
                  {serverExecution
                    ? '服务器临时工作区必须创建提交并推送，才能在任务结束后安全清理'
                    : '由本机执行脚本在现有仓库创建提交；可按授权推送目标分支'}
                </small>
              </span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={serverExecution || pushAfterAcceptance}
                disabled={serverExecution || !autoCommit}
                onChange={(e) => setPushAfterAcceptance(e.target.checked)}
              />
              <span className="custom-check" />
              <span>
                <strong>验收通过后推送</strong>
                <small>
                  {serverExecution
                    ? '服务器临时检出完成后自动推送到配置分支'
                    : '勾选即授权；Codex 成功结束后自动将本地提交推送到目标分支'}
                </small>
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
              label={`${serverExecution ? '服务器' : selectedClient?.clientName ?? 'Mac 客户端'}状态`}
              hint={serverExecution
                ? cloudReadiness?.busy ? '执行中' : '服务器临时任务'
                : `Mac 客户端 ${
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
              <strong>{serverExecution ? '服务器执行说明' : 'Mac 执行说明'}</strong>
              <p>
                {serverExecution
                  ? '服务器从仓库 Git 地址临时检出目标分支，使用平台关联的 Git 账号与服务端 Codex 完成开发；自动提交并推送成功后清理临时工作区。'
                  : `任务下发给 ${selectedClient?.clientName ?? '所选 Mac'} 的本机代理，使用已配置的现有仓库执行 Codex；按上方选项创建提交并推送。`}
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
              <span>解析 · 设计报告 · 自动编码</span>
              <small>生成技术方案、改动范围与测试策略</small>
            </div>
            <div>
              <GitMerge size={15} />
              <span>集成报告 · 提交 · 编译 · 升级 · 测试</span>
              <small>验证通过后推送本机实际分支并生成测试报告</small>
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
