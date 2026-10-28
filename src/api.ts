import type {
  Account,
  FeishuInboxItem,
  PipelineRun,
  PlatformKey,
  Priority,
  Repository,
  TestReport,
  WorkItem,
  WorkItemType,
} from './types'

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

export interface BootstrapData {
  repositories: Repository[]
  accounts: Account[]
  workItems: WorkItem[]
  pipelines: PipelineRun[]
  reports: TestReport[]
  feishuInbox: FeishuInboxItem[]
}

export interface RepositoryInput {
  name: string
  url: string
  branch: string
  language: string
  accountId: string
}

export interface AccountInput {
  platform: PlatformKey
  username: string
  password: string
  label: string
}

export interface WorkItemInput {
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

export interface PipelineInput {
  workItemId: string
  repoId?: string
  autoCommit: boolean
  autoClose: boolean
  triggeredBy?: string
}

export interface ImportResult<T> {
  items: T[]
  count: number
  skipped: number
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null
    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'REQUEST_FAILED',
      payload?.error?.message ?? `请求失败（HTTP ${response.status}）`,
    )
  }

  return (await response.json()) as T
}

export const api = {
  bootstrap: () => request<BootstrapData>('/bootstrap'),
  createRepository: (input: RepositoryInput) =>
    request<Repository>('/repositories', { method: 'POST', body: JSON.stringify(input) }),
  createAccount: (input: AccountInput) =>
    request<Account>('/accounts', { method: 'POST', body: JSON.stringify(input) }),
  importAccounts: (accounts: AccountInput[]) =>
    request<ImportResult<Account>>('/accounts/import', {
      method: 'POST',
      body: JSON.stringify({ accounts }),
    }),
  createWorkItem: (input: WorkItemInput) =>
    request<WorkItem>('/work-items', { method: 'POST', body: JSON.stringify(input) }),
  importWorkItems: (items: WorkItemInput[]) =>
    request<ImportResult<WorkItem>>('/work-items/import', {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),
  startPipeline: (input: PipelineInput) =>
    request<PipelineRun>('/pipelines', { method: 'POST', body: JSON.stringify(input) }),
}
