import { AlertTriangle, CheckCircle2, LoaderCircle, Terminal, X } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { DeliveryDialog } from './components/DeliveryDialog'
import { fetchLocalDeliveryJob } from './feishuAgent'
import { useData } from './store'
import type { LocalDeliveryJob, LocalDeliveryJobStatus, PipelineRun } from './types'

interface DeliveryUiContextValue {
  openDeliveryDialog: (workItemId?: string) => void
}

const DeliveryUiContext = createContext<DeliveryUiContextValue | null>(null)

export function useDeliveryUi(): DeliveryUiContextValue {
  const value = useContext(DeliveryUiContext)
  if (!value) throw new Error('useDeliveryUi 必须在 DeliveryUiProvider 内使用')
  return value
}

function recentlyFinished(job: LocalDeliveryJob): boolean {
  if (job.status === 'running') return true
  const timestamp = Date.parse(job.finishedAt ?? job.lastActivityAt ?? '')
  return Number.isFinite(timestamp) && Date.now() - timestamp < 15 * 60_000
}

function dockStatus(job: LocalDeliveryJob): {
  title: string
  detail: string
  icon: ReactNode
} {
  if (job.status === 'running') {
    return {
      title: '本机交付执行中',
      detail: `${job.workItemId} · ${job.stage} · 点击重新打开执行视图`,
      icon: <LoaderCircle size={18} className="spin" />,
    }
  }
  if (job.status === 'succeeded') {
    return {
      title: '本机交付已完成',
      detail: `${job.workItemId} · 点击查看执行结果`,
      icon: <CheckCircle2 size={18} />,
    }
  }
  return {
    title: '本机交付已结束',
    detail: `${job.workItemId} · 点击查看失败原因`,
    icon: <AlertTriangle size={18} />,
  }
}

export function DeliveryUiProvider({
  children,
  onStarted,
}: {
  children: ReactNode
  onStarted: (run: PipelineRun) => void
}) {
  const {
    localFeishuAgentClientId,
    selectedFeishuAgentClientId,
    notify,
  } = useData()
  const canControlLocalAgent = Boolean(
    localFeishuAgentClientId &&
      selectedFeishuAgentClientId === localFeishuAgentClientId,
  )
  const [dialogOpen, setDialogOpen] = useState(false)
  const [initialWorkItemId, setInitialWorkItemId] = useState<string>()
  const [job, setJob] = useState<LocalDeliveryJob | null>(null)
  const [dismissedJobId, setDismissedJobId] = useState<string>()
  const previousJob = useRef<{ id: string; status: LocalDeliveryJobStatus } | null>(null)

  useEffect(() => {
    if (!canControlLocalAgent) {
      setJob(null)
      return
    }
    let cancelled = false
    const refresh = async () => {
      try {
        const current = await fetchLocalDeliveryJob()
        if (!cancelled) setJob(current)
      } catch {
        if (!cancelled) {
          setJob((current) => (current?.status === 'running' ? current : null))
        }
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [canControlLocalAgent])

  useEffect(() => {
    const current = job ? { id: job.id, status: job.status } : null
    const previous = previousJob.current
    if (
      !dialogOpen &&
      previous &&
      current &&
      previous.id === current.id &&
      previous.status === 'running' &&
      current.status !== 'running'
    ) {
      if (current.status === 'succeeded') {
        notify('本机交付已完成', `${job?.workItemId ?? ''} · 可点击右下角查看结果`, 'success')
      } else {
        notify('本机交付已结束', job?.error || `${job?.workItemId ?? ''} 执行失败`, 'warning')
      }
    }
    previousJob.current = current
  }, [dialogOpen, job, notify])

  const openDeliveryDialog = useCallback(
    (workItemId?: string) => {
      setInitialWorkItemId(job?.status === 'running' ? job.workItemId : workItemId)
      setDialogOpen(true)
    },
    [job?.status, job?.workItemId],
  )

  const closeDeliveryDialog = useCallback(() => setDialogOpen(false), [])
  const visibleJob =
    !dialogOpen &&
    canControlLocalAgent &&
    job &&
    recentlyFinished(job) &&
    dismissedJobId !== job.id
      ? job
      : null
  const status = visibleJob ? dockStatus(visibleJob) : null

  return (
    <DeliveryUiContext.Provider value={{ openDeliveryDialog }}>
      {children}
      <DeliveryDialog
        open={dialogOpen}
        onClose={closeDeliveryDialog}
        initialWorkItemId={initialWorkItemId}
        onStarted={(run) => {
          closeDeliveryDialog()
          onStarted(run)
        }}
      />
      {visibleJob && status && (
        <div className={`delivery-run-dock ${visibleJob.status}`}>
          <button
            type="button"
            className="delivery-run-dock-main"
            onClick={() => openDeliveryDialog(visibleJob.workItemId)}
          >
            <span className="delivery-run-dock-icon">
              {visibleJob.status === 'running' ? <Terminal size={16} /> : status.icon}
            </span>
            <span className="delivery-run-dock-copy">
              <strong>{status.title}</strong>
              <small>{status.detail}</small>
            </span>
            {visibleJob.status === 'running' && status.icon}
          </button>
          {visibleJob.status !== 'running' && (
            <button
              type="button"
              className="delivery-run-dock-dismiss"
              title="关闭结果入口"
              aria-label="关闭结果入口"
              onClick={() => setDismissedJobId(visibleJob.id)}
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}
    </DeliveryUiContext.Provider>
  )
}
