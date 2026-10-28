import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  api,
  type AccountInput,
  type BootstrapData,
  type PipelineInput,
  type RepositoryInput,
  type WorkItemInput,
} from './api'
import {
  type Account,
  type FeishuInboxItem,
  type PipelineRun,
  type Repository,
  type TestReport,
  type ToastMessage,
  type WorkItem,
} from './types'

interface DataContextValue {
  repositories: Repository[]
  accounts: Account[]
  workItems: WorkItem[]
  pipelines: PipelineRun[]
  reports: TestReport[]
  feishuInbox: FeishuInboxItem[]
  loading: boolean
  toasts: ToastMessage[]
  addRepository: (input: RepositoryInput) => Promise<Repository>
  addAccount: (input: AccountInput) => Promise<Account>
  importAccounts: (inputs: AccountInput[]) => Promise<number>
  addWorkItem: (input: WorkItemInput) => Promise<WorkItem>
  importWorkItems: (inputs: WorkItemInput[]) => Promise<number>
  startPipeline: (input: PipelineInput) => Promise<PipelineRun>
  reload: (silent?: boolean) => Promise<void>
  dismissToast: (id: number) => void
  notify: (title: string, message: string, tone?: ToastMessage['tone']) => void
}

const DataContext = createContext<DataContextValue | null>(null)

export function DataProvider({ children }: { children: ReactNode }) {
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [workItems, setWorkItems] = useState<WorkItem[]>([])
  const [pipelines, setPipelines] = useState<PipelineRun[]>([])
  const [reports, setReports] = useState<TestReport[]>([])
  const [feishuInbox, setFeishuInbox] = useState<FeishuInboxItem[]>([])
  const [loading, setLoading] = useState(true)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const toastSequence = useRef(0)
  const initialLoadStarted = useRef(false)
  const hasLoaded = useRef(false)
  const pipelineStatuses = useRef<Map<string, PipelineRun['status']>>(new Map())

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const notify = useCallback(
    (title: string, message: string, tone: ToastMessage['tone'] = 'success') => {
      const id = ++toastSequence.current
      setToasts((current) => [...current, { id, title, message, tone }])
      window.setTimeout(() => dismissToast(id), 4200)
    },
    [dismissToast],
  )

  const applyBootstrap = useCallback(
    (data: BootstrapData) => {
      const previousStatuses = pipelineStatuses.current
      const completed = hasLoaded.current
        ? data.pipelines.filter((run) => {
            const previous = previousStatuses.get(run.id)
            return previous === 'running' && run.status === 'success'
          })
        : []

      setRepositories(data.repositories)
      setAccounts(data.accounts)
      setWorkItems(data.workItems)
      setPipelines(data.pipelines)
      setReports(data.reports)
      setFeishuInbox(data.feishuInbox)
      pipelineStatuses.current = new Map(data.pipelines.map((run) => [run.id, run.status]))

      if (completed.length > 0) {
        const latest = completed[0]
        notify(
          '交付流水线已完成',
          `${latest.title} · ${latest.version} 已完成测试并归档报告`,
          'success',
        )
      }
      hasLoaded.current = true
    },
    [notify],
  )

  const reload = useCallback(
    async (silent = true) => {
      try {
        const data = await api.bootstrap()
        applyBootstrap(data)
      } catch (error) {
        if (!silent) {
          notify(
            '后端服务暂不可用',
            error instanceof Error ? error.message : '无法加载业务数据，请确认后端服务已启动',
            'warning',
          )
        }
      } finally {
        setLoading(false)
      }
    },
    [applyBootstrap, notify],
  )

  useEffect(() => {
    if (initialLoadStarted.current) return
    initialLoadStarted.current = true
    void reload(false)
  }, [reload])

  const hasRunningPipeline = pipelines.some((run) => run.status === 'running')
  useEffect(() => {
    if (loading || !hasRunningPipeline) return
    const timer = window.setInterval(() => void reload(true), 2_000)
    return () => window.clearInterval(timer)
  }, [hasRunningPipeline, loading, reload])

  const reportApiError = useCallback(
    (title: string, error: unknown) => {
      notify(title, error instanceof Error ? error.message : '请求失败，请稍后重试', 'warning')
    },
    [notify],
  )

  const addRepository = useCallback(
    async (input: RepositoryInput) => {
      try {
        const repository = await api.createRepository(input)
        setRepositories((current) => [repository, ...current])
        notify('仓库已接入', `${repository.name} · ${repository.branch} 已完成仓库校验`)
        return repository
      } catch (error) {
        reportApiError('仓库接入失败', error)
        throw error
      }
    },
    [notify, reportApiError],
  )

  const addAccount = useCallback(
    async (input: AccountInput) => {
      try {
        const account = await api.createAccount(input)
        setAccounts((current) => [account, ...current])
        notify('账号绑定成功', `${account.username} 已加密保存至凭据保险箱`)
        return account
      } catch (error) {
        reportApiError('账号绑定失败', error)
        throw error
      }
    },
    [notify, reportApiError],
  )

  const importAccounts = useCallback(
    async (inputs: AccountInput[]) => {
      try {
        const result = await api.importAccounts(inputs)
        setAccounts((current) => [...result.items, ...current])
        notify(
          '账号批量导入完成',
          result.skipped > 0
            ? `已绑定 ${result.count} 个账号，跳过 ${result.skipped} 个重复账号`
            : `已成功绑定 ${result.count} 个平台账号`,
        )
        return result.count
      } catch (error) {
        reportApiError('账号批量导入失败', error)
        throw error
      }
    },
    [notify, reportApiError],
  )

  const addWorkItem = useCallback(
    async (input: WorkItemInput) => {
      try {
        const item = await api.createWorkItem(input)
        setWorkItems((current) => [item, ...current])
        notify(
          input.type === 'requirement' ? '需求已创建' : '缺陷已登记',
          `${item.id} · ${item.title}`,
          'info',
        )
        return item
      } catch (error) {
        reportApiError(input.type === 'requirement' ? '需求创建失败' : '缺陷登记失败', error)
        throw error
      }
    },
    [notify, reportApiError],
  )

  const importWorkItems = useCallback(
    async (inputs: WorkItemInput[]) => {
      try {
        const result = await api.importWorkItems(inputs)
        setWorkItems((current) => [...result.items, ...current])
        const requirementCount = result.items.filter((item) => item.type === 'requirement').length
        const defectCount = result.items.length - requirementCount
        const summary = [
          requirementCount ? `${requirementCount} 条需求` : '',
          defectCount ? `${defectCount} 条缺陷` : '',
        ]
          .filter(Boolean)
          .join('、')
        notify(
          '飞书工作项已同步',
          result.skipped > 0
            ? `已导入 ${summary}，跳过 ${result.skipped} 条重复项`
            : `已导入 ${summary}`,
        )
        return result.count
      } catch (error) {
        reportApiError('飞书工作项导入失败', error)
        throw error
      }
    },
    [notify, reportApiError],
  )

  const startPipeline = useCallback(
    async (input: PipelineInput) => {
      try {
        const run = await api.startPipeline(input)
        setPipelines((current) => [run, ...current])
        setWorkItems((current) =>
          current.map((item) =>
            item.id === run.workItemId ? { ...item, status: '进行中', updatedAt: '刚刚' } : item,
          ),
        )
        pipelineStatuses.current.set(run.id, run.status)
        notify('交付流水线已启动', `${run.id} · ${run.repoName} · ${run.branch}`, 'info')
        return run
      } catch (error) {
        reportApiError('交付流水线启动失败', error)
        throw error
      }
    },
    [notify, reportApiError],
  )

  const value = useMemo<DataContextValue>(
    () => ({
      repositories,
      accounts,
      workItems,
      pipelines,
      reports,
      feishuInbox,
      loading,
      toasts,
      addRepository,
      addAccount,
      importAccounts,
      addWorkItem,
      importWorkItems,
      startPipeline,
      reload,
      dismissToast,
      notify,
    }),
    [
      accounts,
      addAccount,
      addRepository,
      addWorkItem,
      dismissToast,
      feishuInbox,
      importAccounts,
      importWorkItems,
      loading,
      notify,
      pipelines,
      reload,
      reports,
      repositories,
      startPipeline,
      toasts,
      workItems,
    ],
  )

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData() {
  const context = useContext(DataContext)
  if (!context) throw new Error('useData must be used inside DataProvider')
  return context
}
