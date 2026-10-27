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
  createDesignReport,
  createIntegrationReport,
  createStages,
  initialAccounts,
  initialPipelines,
  initialReports,
  initialRepositories,
  initialWorkItems,
} from './mockData'
import type {
  Account,
  PipelineRun,
  PlatformKey,
  Priority,
  Repository,
  TestReport,
  ToastMessage,
  WorkItem,
  WorkItemType,
} from './types'

interface RepositoryInput {
  name: string
  url: string
  branch: string
  language: string
  accountId: string
}

interface AccountInput {
  platform: PlatformKey
  username: string
  password: string
  label: string
}

interface WorkItemInput {
  type: WorkItemType
  title: string
  description: string
  priority: Priority
  repoId: string
  branch: string
  owner: string
  source?: 'local' | 'feishu'
  externalId?: string
}

interface PipelineInput {
  workItemId: string
  repoId?: string
  autoCommit: boolean
  autoClose: boolean
}

interface DataContextValue {
  repositories: Repository[]
  accounts: Account[]
  workItems: WorkItem[]
  pipelines: PipelineRun[]
  reports: TestReport[]
  toasts: ToastMessage[]
  addRepository: (input: RepositoryInput) => Repository
  addAccount: (input: AccountInput) => Account
  importAccounts: (inputs: AccountInput[]) => number
  addWorkItem: (input: WorkItemInput) => WorkItem
  importWorkItems: (inputs: WorkItemInput[]) => number
  startPipeline: (input: PipelineInput) => PipelineRun | null
  dismissToast: (id: number) => void
  notify: (title: string, message: string, tone?: ToastMessage['tone']) => void
}

const DataContext = createContext<DataContextValue | null>(null)

function usePersistedState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key)
      return stored ? (JSON.parse(stored) as T) : initialValue
    } catch {
      return initialValue
    }
  })

  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(value))
  }, [key, value])

  return [value, setValue] as const
}

function elapsedStageDuration(index: number) {
  const durations = [
    '00m 48s',
    '01m 06s',
    '03m 12s',
    '01m 18s',
    '00m 42s',
    '08m 36s',
    '02m 14s',
    '18m 52s',
    '00m 22s',
  ]
  return durations[index] ?? '00m 18s'
}

function stageSuccessLog(index: number, run: PipelineRun) {
  const logs = [
    '需求已解析，验收条件、影响模块与测试范围已确认',
    `开发设计报告已生成：${run.title} 的技术方案与测试策略已就绪`,
    '自动需求编码完成，代码变更与单元测试已生成',
    '集成验证完成，接口兼容性、冲突扫描与静态检查通过',
    `变更已提交至 ${run.branch}，提交 ${run.commit}`,
    `编译成功，已产出 ${run.version} 固件包`,
    'AC/AP 与交换机测试设备升级完成，固件版本校验通过',
    '无线、交换与升级回归测试执行完成，测试结果已回传',
    run.itemType === 'defect'
      ? `报告已归档，缺陷 ${run.workItemId} 已自动关闭`
      : `报告已归档，需求 ${run.workItemId} 已标记交付`,
  ]
  return logs[index] ?? '阶段执行完成'
}

function makeReport(run: PipelineRun): TestReport {
  const total = 426 + (run.id.length % 9)
  const failed = 3 + (run.id.length % 3)
  const skipped = 2
  return {
    id: `TR-${run.id.replace('RUN-', '')}`,
    pipelineId: run.id,
    project: run.repoName,
    version: run.version,
    createdAt: '刚刚',
    status: 'passed',
    total,
    passed: total - failed - skipped,
    failed,
    skipped,
    duration: '19m 16s',
    suites: [
      { name: '无线配置与接入', total: 96, passed: 95, failed: 1, duration: '3m 42s' },
      { name: 'VLAN 与交换转发', total: 148, passed: 146, failed: 2, duration: '7m 18s' },
      { name: '固件升级与异常恢复', total: 106, passed: 103, failed: 2, duration: '5m 06s' },
      { name: 'AC/AP 兼容性', total: 76, passed: 74, failed: 1, duration: '3m 10s' },
    ],
    failedCases: [
      {
        name: 'VLAN 批量导入冲突校验',
        suite: 'VLAN 与交换转发',
        reason: '地址池重叠场景未返回明确的冲突字段',
      },
      {
        name: 'AP 断线重连后终端地址续租',
        suite: '无线配置与接入',
        reason: 'CAPWAP 隧道重建后 DHCP 续租耗时超过 2s',
      },
    ],
  }
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [repositories, setRepositories] = usePersistedState('orbit.repos.v2', initialRepositories)
  const [accounts, setAccounts] = usePersistedState('orbit.accounts.v2', initialAccounts)
  const [workItems, setWorkItems] = usePersistedState('orbit.workItems.v2', initialWorkItems)
  const [pipelines, setPipelines] = usePersistedState('orbit.pipelines.v3', initialPipelines)
  const [reports, setReports] = usePersistedState('orbit.reports.v2', initialReports)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const toastSequence = useRef(0)
  const processedPipelines = useRef<Set<string>>(new Set())

  useEffect(() => {
    const primaryRepository = initialRepositories[0]
    setRepositories((current) => {
      if (current.some((repo) => repo.url === primaryRepository.url)) return current
      const existingIndex = current.findIndex((repo) => repo.id === primaryRepository.id)
      return existingIndex >= 0
        ? current.map((repo, index) => (index === existingIndex ? primaryRepository : repo))
        : [primaryRepository, ...current]
    })
    setWorkItems((current) =>
      current.map((item) =>
        item.repoId === primaryRepository.id
          ? { ...item, branch: primaryRepository.branch }
          : item,
      ),
    )
    setPipelines((current) =>
      current.map((run) =>
        run.repoId === primaryRepository.id
          ? { ...run, repoName: primaryRepository.name, branch: primaryRepository.branch }
          : run,
      ),
    )
    // Migrate persisted demo data to the configured sme-main repository.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPipelines((current) =>
        current.map((run) => {
          if (run.status !== 'running' || !run.simulation) return run

          const activeIndex = run.currentStage
          const isLastStage = activeIndex >= run.stages.length - 1
          const stages = run.stages.map((stage, index) => {
            if (index === activeIndex) {
              return {
                ...stage,
                status: 'success' as const,
                duration: stage.duration ?? elapsedStageDuration(index),
                log: stage.log ?? stageSuccessLog(index, run),
              }
            }
            if (index === activeIndex + 1) {
              return { ...stage, status: 'running' as const, log: `正在执行：${stage.description}` }
            }
            return stage
          })
          const nextStage = isLastStage ? run.stages.length : activeIndex + 1
          const generatedArtifacts =
            activeIndex === 1 && !run.designReport
              ? { designReport: createDesignReport(run) }
              : activeIndex === 3 && !run.integrationReport
                ? { integrationReport: createIntegrationReport(run) }
                : {}
          return {
            ...run,
            ...generatedArtifacts,
            stages,
            currentStage: nextStage,
            progress: isLastStage ? 100 : Math.round((nextStage / run.stages.length) * 100),
            status: isLastStage ? ('success' as const) : ('running' as const),
          }
        }),
      )
    }, 1900)

    return () => window.clearInterval(timer)
  }, [setPipelines])

  useEffect(() => {
    pipelines
      .filter((run) => run.simulation && run.status !== 'running')
      .forEach((run) => processedPipelines.current.add(run.id))
    // Only hydrate completed runs from persisted storage on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const completed = pipelines.filter(
      (run) =>
        run.simulation && run.status === 'success' && !processedPipelines.current.has(run.id),
    )
    if (completed.length === 0) return

    completed.forEach((run) => processedPipelines.current.add(run.id))
    setReports((current) => {
      const known = new Set(current.map((report) => report.pipelineId))
      const additions = completed.filter((run) => !known.has(run.id)).map(makeReport)
      return additions.length ? [...additions, ...current] : current
    })
    setWorkItems((current) =>
      current.map((item) => {
        const completedRun = completed.find((run) => run.workItemId === item.id)
        if (!completedRun) return item
        if (item.type === 'defect' && completedRun.autoClose) {
          return { ...item, status: '已关闭', updatedAt: '刚刚' }
        }
        return { ...item, status: '已交付', updatedAt: '刚刚' }
      }),
    )
    setRepositories((current) =>
      current.map((repo) => {
        const completedRun = completed.find((run) => run.repoId === repo.id)
        return completedRun
          ? { ...repo, latestVersion: completedRun.version, lastSync: '刚刚' }
          : repo
      }),
    )
    const latest = completed[completed.length - 1]
    notify(
      '交付流水线已完成',
      `${latest.title} · ${latest.version} 已完成测试并归档报告`,
      'success',
    )
  }, [notify, pipelines, setRepositories, setReports, setWorkItems])

  const addRepository = useCallback(
    (input: RepositoryInput) => {
      const repo: Repository = {
        id: `repo-${Date.now()}`,
        name: input.name,
        url: input.url,
        branch: input.branch,
        language: input.language,
        accountId: input.accountId,
        lastSync: '刚刚',
        status: 'healthy',
        latestVersion: '待构建',
      }
      setRepositories((current) => [repo, ...current])
      notify('仓库已接入', `${repo.name} · ${repo.branch} 已完成仓库校验`)
      return repo
    },
    [notify, setRepositories],
  )

  const addAccount = useCallback(
    (input: AccountInput) => {
      const account: Account = {
        id: `acc-${Date.now()}`,
        platform: input.platform,
        username: input.username,
        label: input.label || '平台账号',
        secretHint: `••••••••${input.password.slice(-4) || '****'}`,
        status: 'active',
        createdAt: new Date().toISOString().slice(0, 10),
      }
      setAccounts((current) => [account, ...current])
      notify('账号绑定成功', `${account.username} 已加入账号池`)
      return account
    },
    [notify, setAccounts],
  )

  const importAccounts = useCallback(
    (inputs: AccountInput[]) => {
      const stamp = Date.now()
      const next = inputs.map((input, index) => ({
        id: `acc-${stamp}-${index}`,
        platform: input.platform,
        username: input.username,
        label: input.label || '导入账号',
        secretHint: `••••••••${input.password.slice(-4) || '****'}`,
        status: 'active' as const,
        createdAt: new Date().toISOString().slice(0, 10),
      }))
      setAccounts((current) => [...next, ...current])
      notify('账号批量导入完成', `已成功绑定 ${next.length} 个平台账号`)
      return next.length
    },
    [notify, setAccounts],
  )

  const addWorkItem = useCallback(
    (input: WorkItemInput) => {
      const prefix = input.type === 'requirement' ? 'REQ' : 'BUG'
      const count = workItems.filter((item) => item.type === input.type).length + 1083
      const item: WorkItem = {
        id: `${prefix}-${count}`,
        type: input.type,
        title: input.title,
        description: input.description,
        priority: input.priority,
        status: '待处理',
        repoId: input.repoId,
        branch: input.branch,
        owner: input.owner,
        updatedAt: '刚刚',
        createdAt: new Date().toISOString().slice(0, 10),
        source: input.source ?? 'local',
        externalId: input.externalId,
      }
      setWorkItems((current) => [item, ...current])
      notify(
        input.type === 'requirement' ? '需求已创建' : '缺陷已登记',
        `${item.id} · ${item.title}`,
        'info',
      )
      return item
    },
    [notify, setWorkItems, workItems],
  )

  const importWorkItems = useCallback(
    (inputs: WorkItemInput[]) => {
      if (inputs.length === 0) return 0
      const counters = {
        requirement: workItems.filter((item) => item.type === 'requirement').length + 1083,
        defect: workItems.filter((item) => item.type === 'defect').length + 1083,
      }
      const imported: WorkItem[] = inputs.map((input) => {
        const prefix = input.type === 'requirement' ? 'REQ' : 'BUG'
        const id = `${prefix}-${counters[input.type]++}`
        return {
          id,
          type: input.type,
          title: input.title,
          description: input.description,
          priority: input.priority,
          status: '待处理',
          repoId: input.repoId,
          branch: input.branch,
          owner: input.owner,
          updatedAt: '刚刚',
          createdAt: new Date().toISOString().slice(0, 10),
          source: 'feishu',
          externalId: input.externalId,
        }
      })
      setWorkItems((current) => [...imported, ...current])
      const requirementCount = imported.filter((item) => item.type === 'requirement').length
      const defectCount = imported.length - requirementCount
      const summary = [
        requirementCount ? `${requirementCount} 条需求` : '',
        defectCount ? `${defectCount} 条缺陷` : '',
      ]
        .filter(Boolean)
        .join('、')
      notify('飞书工作项已同步', `本地已导入 ${summary}，无需打开飞书页面`)
      return imported.length
    },
    [notify, setWorkItems, workItems],
  )

  const startPipeline = useCallback(
    (input: PipelineInput) => {
      const item = workItems.find((entry) => entry.id === input.workItemId)
      if (!item) return null
      const repoId = input.repoId ?? item.repoId
      const repo = repositories.find((entry) => entry.id === repoId) ?? repositories[0]
      const runNumber = 2410 + pipelines.filter((run) => run.simulation).length
      const versionSuffix = 19 + pipelines.filter((run) => run.simulation).length
      const versionBase = repo.latestVersion.match(/^v?(\d+\.\d+\.\d+)/)?.[1] ?? '1.0.0'
      const run: PipelineRun = {
        id: `RUN-${runNumber}`,
        workItemId: item.id,
        title: item.title,
        itemType: item.type,
        repoId: repo.id,
        repoName: repo.name,
        branch: repo.branch,
        commit: Math.random().toString(16).slice(2, 9),
        version: `v${versionBase}-rc.${versionSuffix}`,
        status: 'running',
        progress: 8,
        currentStage: 0,
        stages: createStages(0, 0),
        createdAt: '刚刚',
        triggeredBy: '陈华',
        autoCommit: input.autoCommit,
        autoClose: input.autoClose,
        simulation: true,
      }
      run.stages[0].log = '正在解析需求上下文与代码影响范围'
      setPipelines((current) => [run, ...current])
      setWorkItems((current) =>
        current.map((entry) =>
          entry.id === item.id ? { ...entry, status: '进行中', updatedAt: '刚刚' } : entry,
        ),
      )
      notify('交付流水线已启动', `${run.id} · ${repo.name} · ${run.branch}`, 'info')
      return run
    },
    [notify, pipelines, repositories, setPipelines, setWorkItems, workItems],
  )

  const value = useMemo<DataContextValue>(
    () => ({
      repositories,
      accounts,
      workItems,
      pipelines,
      reports,
      toasts,
      addRepository,
      addAccount,
      importAccounts,
      addWorkItem,
      importWorkItems,
      startPipeline,
      dismissToast,
      notify,
    }),
    [
      accounts,
      addAccount,
      addRepository,
      addWorkItem,
      dismissToast,
      importAccounts,
      importWorkItems,
      notify,
      pipelines,
      repositories,
      reports,
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
