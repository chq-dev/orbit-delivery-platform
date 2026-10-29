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
  type FeishuConnectInput,
  type PipelineInput,
  type RepositoryInput,
  type RepositorySettingsInput,
  type WorkItemInput,
} from './api'
import {
  clearCachedFeishuSnapshot,
  fetchFeishuSnapshot,
  getFeishuSnapshotConfig,
  mapFeishuSnapshotItems,
  mergeFeishuSnapshot,
  readCachedFeishuSnapshot,
  writeCachedFeishuSnapshot,
  type FeishuSnapshot,
} from './feishuSnapshot'
import {
  configureFeishuAgent,
  fetchFeishuAgentHealth,
  pollFeishuAgentLogin,
  rotateFeishuAgentToken,
  runFeishuAgentSync as runFeishuAgentSyncRequest,
  startFeishuAgentLogin,
} from './feishuAgent'
import {
  type Account,
  type FeishuAgentLoginState,
  type FeishuClientAgentHealth,
  type FeishuClientAgentState,
  type FeishuInboxItem,
  type FeishuIntegrationStatus,
  type FeishuLoginChallenge,
  type FeishuSnapshotStatus,
  type FeishuSyncResult,
  type FeishuSyncTokenBootstrapResult,
  type FeishuSyncTokenStatus,
  type PipelineRun,
  type Repository,
  type TestReport,
  type ToastMessage,
  type WorkItem,
} from './types'

interface FeishuAgentBindResult {
  status: FeishuSyncTokenStatus
  agentConfigured: boolean
  token?: string
  error?: unknown
}

interface DataContextValue {
  repositories: Repository[]
  accounts: Account[]
  workItems: WorkItem[]
  pipelines: PipelineRun[]
  reports: TestReport[]
  feishuInbox: FeishuInboxItem[]
  feishuIntegration: FeishuIntegrationStatus
  feishuSnapshot: FeishuSnapshotStatus
  feishuAgent: FeishuClientAgentState
  feishuSyncToken: FeishuSyncTokenStatus
  feishuAgentLogin: FeishuAgentLoginState
  loading: boolean
  toasts: ToastMessage[]
  addRepository: (input: RepositoryInput) => Promise<Repository>
  updateRepositorySettings: (
    id: string,
    input: RepositorySettingsInput,
  ) => Promise<Repository>
  addAccount: (input: AccountInput) => Promise<Account>
  importAccounts: (inputs: AccountInput[]) => Promise<number>
  addWorkItem: (input: WorkItemInput) => Promise<WorkItem>
  importWorkItems: (inputs: WorkItemInput[]) => Promise<number>
  connectFeishu: (input: FeishuConnectInput) => Promise<FeishuIntegrationStatus>
  testFeishu: () => Promise<{ ok: true; projectName?: string }>
  syncFeishu: () => Promise<FeishuSyncResult>
  syncFeishuAgent: (announce?: boolean) => Promise<FeishuSyncResult>
  refreshFeishuAgent: (quiet?: boolean) => Promise<FeishuClientAgentHealth | null>
  refreshFeishuSyncToken: () => Promise<FeishuSyncTokenStatus | null>
  bindFeishuAgent: () => Promise<FeishuAgentBindResult>
  beginFeishuAgentLogin: () => Promise<FeishuLoginChallenge>
  rotateFeishuSyncToken: () => Promise<FeishuSyncTokenStatus>
  refreshFeishuSnapshot: (announce?: boolean) => Promise<number>
  disconnectFeishu: () => Promise<FeishuIntegrationStatus>
  startPipeline: (input: PipelineInput) => Promise<PipelineRun>
  reload: (silent?: boolean) => Promise<void>
  dismissToast: (id: number) => void
  notify: (title: string, message: string, tone?: ToastMessage['tone']) => void
}

const DataContext = createContext<DataContextValue | null>(null)

export function DataProvider({ children }: { children: ReactNode }) {
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [serverWorkItems, setServerWorkItems] = useState<WorkItem[]>([])
  const [snapshot, setSnapshot] = useState<FeishuSnapshot | null>(() =>
    readCachedFeishuSnapshot(),
  )
  const [pipelines, setPipelines] = useState<PipelineRun[]>([])
  const [reports, setReports] = useState<TestReport[]>([])
  const [feishuInbox, setFeishuInbox] = useState<FeishuInboxItem[]>([])
  const [feishuIntegration, setFeishuIntegration] = useState<FeishuIntegrationStatus>({
    connected: false,
    webhookConfigured: false,
    eventPath: '/api/integrations/feishu/events',
  })
  const snapshotConfig = useMemo(() => getFeishuSnapshotConfig(), [])
  const [feishuSnapshot, setFeishuSnapshot] = useState<FeishuSnapshotStatus>({
    configured: true,
    url: snapshotConfig.url,
    loading: false,
    itemCount: snapshot?.items.length ?? 0,
    lastUpdatedAt: snapshot?.syncedAt || undefined,
  })
  const [feishuAgent, setFeishuAgent] = useState<FeishuClientAgentState>({
    checking: true,
    online: false,
  })
  const [feishuSyncToken, setFeishuSyncToken] = useState<FeishuSyncTokenStatus>({
    configured: false,
    source: 'none',
  })
  const [feishuAgentLogin, setFeishuAgentLogin] = useState<FeishuAgentLoginState>({
    polling: false,
  })
  const [loading, setLoading] = useState(true)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const toastSequence = useRef(0)
  const initialLoadStarted = useRef(false)
  const hasLoaded = useRef(false)
  const pipelineStatuses = useRef<Map<string, PipelineRun['status']>>(new Map())
  const feishuAgentHealth = useRef<FeishuClientAgentHealth | null>(null)
  const feishuAgentSyncInFlight = useRef(false)
  const lastFeishuAgentSyncAt = useRef(0)

  const snapshotWorkItems = useMemo(
    () => (snapshot ? mapFeishuSnapshotItems(snapshot, repositories) : []),
    [repositories, snapshot],
  )
  const workItems = useMemo(
    () => mergeFeishuSnapshot(serverWorkItems, snapshotWorkItems),
    [serverWorkItems, snapshotWorkItems],
  )

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

  const reportApiError = useCallback(
    (title: string, error: unknown) => {
      notify(title, error instanceof Error ? error.message : '请求失败，请稍后重试', 'warning')
    },
    [notify],
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
      setServerWorkItems(data.workItems)
      setPipelines(data.pipelines)
      setReports(data.reports)
      setFeishuInbox(data.feishuInbox)
      setFeishuIntegration(data.feishuIntegration)
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

  const refreshFeishuSnapshot = useCallback(
    async (announce = false) => {
      setFeishuSnapshot((current) => ({ ...current, loading: true, error: undefined }))
      try {
        const result = await fetchFeishuSnapshot(snapshotConfig.url)
        if (result.snapshot.items.length === 0 && !result.snapshot.syncedAt) {
          setSnapshot(null)
          clearCachedFeishuSnapshot()
          setFeishuSnapshot((current) => ({
            ...current,
            loading: false,
            itemCount: 0,
            lastUpdatedAt: undefined,
          }))
          throw new Error('飞书快照尚未生成，请先运行 npm run sync:feishu')
        }
        setSnapshot(result.snapshot)
        writeCachedFeishuSnapshot(result.snapshot)
        setFeishuSnapshot({
          configured: true,
          url: snapshotConfig.url,
          loading: false,
          itemCount: result.snapshot.items.length,
          lastUpdatedAt: result.snapshot.syncedAt || new Date().toISOString(),
        })
        if (announce) {
          notify(
            '飞书工作项已更新',
            `${result.snapshot.items.length} 条数据来自前端快照${result.skipped > 0 ? `，跳过 ${result.skipped} 条无效记录` : ''}`,
          )
        }
        return result.snapshot.items.length
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法读取飞书快照'
        setFeishuSnapshot((current) => ({ ...current, loading: false, error: message }))
        if (announce) notify('飞书前端快照更新失败', message, 'warning')
        throw error
      }
    },
    [notify, snapshotConfig.url],
  )

  const refreshFeishuAgent = useCallback(
    async (quiet = false) => {
      if (!quiet) {
        setFeishuAgent((current) => ({ ...current, checking: true, error: undefined }))
      }
      try {
        const health = await fetchFeishuAgentHealth()
        feishuAgentHealth.current = health
        setFeishuAgent({ checking: false, online: true, health })
        if (health.pendingLogin) {
          setFeishuAgentLogin((current) =>
            current.challenge
              ? current
              : {
                  challenge: {
                    verificationUri: health.pendingLogin?.verificationUriComplete ?? '',
                    verificationUriComplete:
                      health.pendingLogin?.verificationUriComplete ?? '',
                    userCode: health.pendingLogin?.userCode ?? '',
                    expiresAt: health.pendingLogin?.expiresAt ?? 0,
                  },
                  polling: true,
                },
          )
        }
        return health
      } catch (error) {
        feishuAgentHealth.current = null
        setFeishuAgent({
          checking: false,
          online: false,
          error: error instanceof Error ? error.message : '本机同步代理不可用',
        })
        return null
      }
    },
    [],
  )

  const refreshFeishuSyncToken = useCallback(async () => {
    try {
      const status = await api.getFeishuSyncTokenStatus()
      setFeishuSyncToken(status)
      return status
    } catch {
      return null
    }
  }, [])

  const syncFeishuAgent = useCallback(
    async (announce = true) => {
      if (feishuAgentSyncInFlight.current) {
        throw new Error('飞书同步正在执行，请稍后刷新状态')
      }
      let health = feishuAgentHealth.current
      if (!health?.config.configured || !health.meegle.authenticated) {
        health = await refreshFeishuAgent(true)
      }
      if (!health) {
        throw new Error('本机飞书同步代理未启动，请先在客户端运行 npm run feishu:agent')
      }
      if (health.running) throw new Error('本机飞书同步代理正在执行同步，请稍后重试')
      if (!health.config.configured) {
        throw new Error('本机代理尚未绑定平台同步密钥，请先点击“生成密钥并绑定”')
      }
      if (!health.meegle.available) {
        throw new Error('本机未安装 Meegle CLI，请安装 @lark-project/meegle 后重启代理')
      }
      if (!health.meegle.authenticated) {
        throw new Error('Meegle 尚未登录，请先完成飞书设备授权')
      }

      feishuAgentSyncInFlight.current = true
      try {
        const result = await runFeishuAgentSyncRequest()
        lastFeishuAgentSyncAt.current = Date.now()
        await reload(true)
        await refreshFeishuSnapshot().catch(() => undefined)
        await refreshFeishuAgent(true)
        if (announce) {
          notify(
            '飞书实时数据已更新',
            result.archived && result.archived > 0
              ? `${result.message}，归档 ${result.archived} 条飞书已删除项`
              : result.message,
          )
        }
        return result
      } catch (error) {
        await refreshFeishuAgent(true)
        if (announce) reportApiError('飞书实时同步失败', error)
        throw error
      } finally {
        feishuAgentSyncInFlight.current = false
      }
    },
    [notify, refreshFeishuAgent, refreshFeishuSnapshot, reload],
  )

  const bindFeishuAgent = useCallback(async (): Promise<FeishuAgentBindResult> => {
    const health = await refreshFeishuAgent()
    if (!health) {
      throw new Error('本机飞书同步代理未启动，请先在客户端运行 npm run feishu:agent')
    }
    let status = (await refreshFeishuSyncToken()) ?? feishuSyncToken
    if (health.config.configured) {
      if (!status.configured) {
        const boot = await api.bootstrapFeishuSyncToken()
        status = boot.status
        setFeishuSyncToken(status)
        try {
          await configureFeishuAgent({
            platformBaseUrl: window.location.origin,
            syncToken: boot.token,
            projectKey: feishuIntegration.projectKey ?? 'rjcloud',
            repoId: feishuIntegration.defaultRepoId,
          })
        } catch (error) {
          notify(
            '平台密钥已生成，但本机代理绑定失败',
            '请保持代理运行，复制一次性密钥并在本机配置后重试',
            'warning',
          )
          return { status, agentConfigured: false, token: boot.token, error }
        }
        await refreshFeishuAgent(true)
        notify('本机飞书同步已绑定', '平台已生成新的同步密钥，并只保存到本机代理')
        return { status, agentConfigured: true }
      }
      notify('本机飞书同步已绑定', '代理与平台同步密钥均已配置', 'info')
      return { status, agentConfigured: true }
    }

    if (status.configured && status.source === 'env') {
      throw new Error(
        '平台同步密钥由 FEISHU_INGEST_TOKEN 管理，请在本机代理环境设置相同的 PLATFORM_SYNC_TOKEN 后重启代理',
      )
    }
    if (status.configured) {
      throw new Error(
        '平台已生成过同步密钥，但本机代理没有保存。请在本机运行 npm run feishu:agent 后尝试轮换；若两者都不存在，则由服务器管理员重置密钥',
      )
    }

    const boot: FeishuSyncTokenBootstrapResult = await api.bootstrapFeishuSyncToken()
    setFeishuSyncToken(boot.status)
    try {
      await configureFeishuAgent({
        platformBaseUrl: window.location.origin,
        syncToken: boot.token,
        projectKey: feishuIntegration.projectKey ?? 'rjcloud',
        repoId: feishuIntegration.defaultRepoId,
      })
    } catch (error) {
      notify(
        '平台密钥已生成，但本机代理绑定失败',
        '请保持代理运行，复制一次性密钥并在本机配置后重试',
        'warning',
      )
      return { status: boot.status, agentConfigured: false, token: boot.token, error }
    }
    await refreshFeishuAgent(true)
    notify('本机飞书同步已绑定', '平台已生成同步密钥，并只保存到本机代理')
    return { status: boot.status, agentConfigured: true }
  }, [
    feishuIntegration.defaultRepoId,
    feishuIntegration.projectKey,
    feishuSyncToken,
    notify,
    refreshFeishuAgent,
    refreshFeishuSyncToken,
  ])

  const rotateFeishuSyncToken = useCallback(async () => {
    const status = (await refreshFeishuSyncToken()) ?? feishuSyncToken
    if (!status.configured) throw new Error('平台尚未生成飞书同步密钥')
    if (status.source === 'env') {
      throw new Error('同步密钥由 FEISHU_INGEST_TOKEN 管理，不能在页面轮换')
    }
    const health = await refreshFeishuAgent()
    if (!health?.config.configured) {
      throw new Error('本机代理尚未保存当前同步密钥，无法通过代理轮换')
    }
    const rotated = await rotateFeishuAgentToken()
    setFeishuSyncToken(rotated)
    await refreshFeishuAgent(true)
    notify('飞书同步密钥已轮换', '旧密钥已失效，新密钥只保存在本机代理')
    return rotated
  }, [
    feishuSyncToken,
    notify,
    refreshFeishuAgent,
    refreshFeishuSyncToken,
  ])

  const beginFeishuAgentLogin = useCallback(async () => {
    try {
      const challenge = await startFeishuAgentLogin()
      setFeishuAgentLogin({ challenge, polling: true })
      notify(
        '请在飞书完成设备授权',
        `打开授权链接并输入用户码 ${challenge.userCode}`,
        'info',
      )
      return challenge
    } catch (error) {
      reportApiError('无法发起飞书设备授权', error)
      throw error
    }
  }, [notify, reportApiError])

  useEffect(() => {
    const challenge = feishuAgentLogin.challenge
    if (!challenge || !feishuAgentLogin.polling) return
    let cancelled = false
    let timer: number | undefined

    const poll = async () => {
      try {
        const result = await pollFeishuAgentLogin()
        if (cancelled) return
        if (result.authenticated) {
          setFeishuAgentLogin({ polling: false })
          notify('飞书授权完成', '正在拉取最新需求和缺陷', 'success')
          await refreshFeishuAgent(true)
          await syncFeishuAgent(true).catch(() => undefined)
          return
        }
        timer = window.setTimeout(() => void poll(), 3_000)
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : '飞书授权轮询失败'
        setFeishuAgentLogin({ challenge, polling: false, error: message })
        notify('飞书授权未完成', message, 'warning')
      }
    }

    timer = window.setTimeout(() => void poll(), 1_500)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [
    feishuAgentLogin.challenge,
    feishuAgentLogin.polling,
    notify,
    refreshFeishuAgent,
    syncFeishuAgent,
  ])

  const tryFeishuAgentAutoSync = useCallback(async () => {
    if (document.visibilityState !== 'visible' || feishuAgentSyncInFlight.current) return
    let health = feishuAgentHealth.current
    if (!health) health = await refreshFeishuAgent(true)
    if (!health?.config.configured || !health.meegle.authenticated || health.running) return
    const lastRunAt = health.lastRun ? Date.parse(health.lastRun.at) : Number.NaN
    const lastSyncAt = Math.max(
      lastFeishuAgentSyncAt.current,
      Number.isFinite(lastRunAt) ? lastRunAt : 0,
    )
    if (Date.now() - lastSyncAt < 60_000) return
    await syncFeishuAgent(false).catch(() => undefined)
  }, [refreshFeishuAgent, syncFeishuAgent])

  useEffect(() => {
    if (initialLoadStarted.current) return
    initialLoadStarted.current = true
    void reload(false)
    void refreshFeishuSnapshot().catch(() => undefined)
    void refreshFeishuAgent(true)
    void refreshFeishuSyncToken()
  }, [refreshFeishuAgent, refreshFeishuSnapshot, refreshFeishuSyncToken, reload])

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      void refreshFeishuAgent(true).then(() => tryFeishuAgentAutoSync())
    }
    const initialTimer = window.setTimeout(tick, 2_000)
    const interval = window.setInterval(tick, 60_000)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [refreshFeishuAgent, tryFeishuAgentAutoSync])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshFeishuSnapshot().catch(() => undefined)
      }
    }, snapshotConfig.refreshMs)
    return () => window.clearInterval(timer)
  }, [refreshFeishuSnapshot, snapshotConfig.refreshMs])

  const hasRunningPipeline = pipelines.some((run) => run.status === 'running')
  useEffect(() => {
    if (loading || !hasRunningPipeline) return
    const timer = window.setInterval(() => void reload(true), 2_000)
    return () => window.clearInterval(timer)
  }, [hasRunningPipeline, loading, reload])

  const feishuConnected = feishuIntegration.connected
  useEffect(() => {
    if (loading) return
    const timer = window.setInterval(
      () => void reload(true),
      feishuConnected ? 15_000 : 30_000,
    )
    return () => window.clearInterval(timer)
  }, [feishuConnected, loading, reload])

  const addRepository = useCallback(
    async (input: RepositoryInput) => {
      try {
        const repository = await api.createRepository(input)
        setRepositories((current) => [repository, ...current])
        notify(
          '仓库已接入',
          `${repository.name} · ${repository.branch}${repository.localPath ? ' · 客户端路径已记录' : ''}`,
        )
        return repository
      } catch (error) {
        reportApiError('仓库接入失败', error)
        throw error
      }
    },
    [notify, reportApiError],
  )

  const updateRepositorySettings = useCallback(
    async (id: string, input: RepositorySettingsInput) => {
      try {
        const repository = await api.updateRepositorySettings(id, input)
        setRepositories((current) =>
          current.map((item) => (item.id === repository.id ? repository : item)),
        )
        setServerWorkItems((current) =>
          current.map((item) =>
            item.repoId === repository.id ? { ...item, branch: repository.branch } : item,
          ),
        )
        notify(
          '仓库配置已更新',
          `${repository.name} · ${repository.branch}${repository.localPath ? ` · ${repository.localPath}` : ''}`,
        )
        return repository
      } catch (error) {
        reportApiError('仓库配置更新失败', error)
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
        setServerWorkItems((current) => [item, ...current])
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
        setServerWorkItems((current) => [...result.items, ...current])
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

  const connectFeishu = useCallback(
    async (input: FeishuConnectInput) => {
      try {
        const integration = await api.connectFeishu(input)
        setFeishuIntegration(integration)
        notify('飞书项目已绑定', `${integration.projectKey} 已通过连接校验`)
        return integration
      } catch (error) {
        reportApiError('飞书项目绑定失败', error)
        throw error
      }
    },
    [notify, reportApiError],
  )

  const testFeishu = useCallback(async () => {
    try {
      const result = await api.testFeishu()
      notify('飞书连接正常', result.projectName ?? '插件、项目和工作项类型权限校验通过')
      await reload(true)
      return result
    } catch (error) {
      reportApiError('飞书连接测试失败', error)
      throw error
    }
  }, [notify, reload, reportApiError])

  const syncFeishu = useCallback(async () => {
    try {
      const health = await refreshFeishuAgent(true)
      if (health?.config.configured) return await syncFeishuAgent(true)

      if (
        feishuIntegration.connected &&
        (feishuIntegration.authMode === 'token' || feishuIntegration.authMode === 'plugin')
      ) {
        const result = await api.syncFeishu()
        await reload(true)
        await refreshFeishuSnapshot().catch(() => undefined)
        notify(
          '飞书工作项已同步',
          result.skipped > 0 ? `${result.message}，${result.skipped} 条已跳过` : result.message,
        )
        return result
      }

      if (health && !health.config.configured) {
        throw new Error('本机代理尚未绑定平台同步密钥，请先点击“生成密钥并绑定”')
      }
      if (health && health.meegle.available && !health.meegle.authenticated) {
        throw new Error('Meegle 尚未登录，请先完成页面中的飞书设备授权')
      }
      throw new Error(
        '未检测到本机飞书同步代理。请在客户端运行 npm run feishu:agent 并完成一次绑定；旧快照不会再被当作实时同步结果',
      )
    } catch (error) {
      reportApiError('飞书工作项同步失败', error)
      throw error
    }
  }, [
    feishuIntegration.authMode,
    feishuIntegration.connected,
    notify,
    refreshFeishuAgent,
    refreshFeishuSnapshot,
    reload,
    reportApiError,
    syncFeishuAgent,
  ])

  const disconnectFeishu = useCallback(async () => {
    try {
      const integration = await api.disconnectFeishu()
      setFeishuIntegration(integration)
      notify('飞书项目已解除绑定', '本地已同步的工作项会保留', 'info')
      return integration
    } catch (error) {
      reportApiError('解除飞书绑定失败', error)
      throw error
    }
  }, [notify, reportApiError])

  const startPipeline = useCallback(
    async (input: PipelineInput) => {
      try {
        const run = await api.startPipeline(input)
        setPipelines((current) => [run, ...current])
        setServerWorkItems((current) =>
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
      feishuIntegration,
      feishuSnapshot,
      feishuAgent,
      feishuSyncToken,
      feishuAgentLogin,
      loading,
      toasts,
      addRepository,
      updateRepositorySettings,
      addAccount,
      importAccounts,
      addWorkItem,
      importWorkItems,
      connectFeishu,
      testFeishu,
      syncFeishu,
      syncFeishuAgent,
      refreshFeishuAgent,
      refreshFeishuSyncToken,
      bindFeishuAgent,
      beginFeishuAgentLogin,
      rotateFeishuSyncToken,
      refreshFeishuSnapshot,
      disconnectFeishu,
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
      beginFeishuAgentLogin,
      bindFeishuAgent,
      connectFeishu,
      disconnectFeishu,
      dismissToast,
      feishuAgent,
      feishuAgentLogin,
      feishuInbox,
      feishuIntegration,
      feishuSnapshot,
      feishuSyncToken,
      importAccounts,
      importWorkItems,
      loading,
      notify,
      pipelines,
      reload,
      reports,
      refreshFeishuAgent,
      refreshFeishuSnapshot,
      refreshFeishuSyncToken,
      repositories,
      rotateFeishuSyncToken,
      startPipeline,
      syncFeishuAgent,
      updateRepositorySettings,
      syncFeishu,
      testFeishu,
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
