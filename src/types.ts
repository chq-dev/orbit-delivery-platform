export type PageKey =
  | 'dashboard'
  | 'repositories'
  | 'accounts'
  | 'work-items'
  | 'pipelines'
  | 'reports'

export type PlatformKey = 'git' | 'feishu' | 'build' | 'device'

export interface Repository {
  id: string
  name: string
  url: string
  branch: string
  language: string
  accountId: string
  lastSync: string
  status: 'healthy' | 'warning'
  latestVersion: string
}

export interface Account {
  id: string
  platform: PlatformKey
  username: string
  label: string
  secretHint: string
  status: 'active' | 'expiring'
  createdAt: string
}

export type WorkItemType = 'requirement' | 'defect'
export type WorkItemStatus = '待处理' | '进行中' | '已交付' | '已关闭'
export type Priority = '紧急' | '高' | '中' | '低'

export interface WorkItem {
  id: string
  type: WorkItemType
  title: string
  description: string
  priority: Priority
  status: WorkItemStatus
  repoId: string
  branch: string
  owner: string
  updatedAt: string
  createdAt: string
  source?: 'local' | 'feishu'
  externalId?: string
}

export type StageStatus = 'pending' | 'running' | 'success' | 'failed'
export type PipelineStatus = 'queued' | 'running' | 'success' | 'failed'

export interface PipelineStage {
  key: string
  name: string
  description: string
  status: StageStatus
  duration?: string
  log?: string
}

export interface PipelineReportSection {
  title: string
  content: string
}

export interface PipelineReport {
  id: string
  title: string
  summary: string
  createdAt: string
  sections: PipelineReportSection[]
}

export interface PipelineRun {
  id: string
  workItemId: string
  title: string
  itemType: WorkItemType
  repoId: string
  repoName: string
  branch: string
  commit: string
  version: string
  status: PipelineStatus
  progress: number
  currentStage: number
  stages: PipelineStage[]
  designReport?: PipelineReport
  integrationReport?: PipelineReport
  createdAt: string
  triggeredBy: string
  autoCommit: boolean
  autoClose: boolean
  simulation: boolean
}

export interface TestSuite {
  name: string
  total: number
  passed: number
  failed: number
  duration: string
}

export interface FailedCase {
  name: string
  suite: string
  reason: string
}

export interface TestReport {
  id: string
  pipelineId: string
  project: string
  version: string
  createdAt: string
  status: 'passed' | 'warning' | 'failed'
  total: number
  passed: number
  failed: number
  skipped: number
  duration: string
  suites: TestSuite[]
  failedCases: FailedCase[]
}

export interface FeishuInboxItem {
  externalId: string
  type: WorkItemType
  title: string
  description: string
  priority: Priority
  repoId: string
  owner: string
  updatedAt: string
}

export interface ToastMessage {
  id: number
  title: string
  message: string
  tone: 'success' | 'info' | 'warning'
}

export interface PlatformMeta {
  key: PlatformKey
  name: string
  description: string
  color: string
  softColor: string
  shortName: string
}
