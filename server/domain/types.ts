export type PlatformKey = 'git' | 'feishu' | 'build' | 'device'
export type AccountStatus = 'active' | 'expiring'
export type RepositoryStatus = 'healthy' | 'warning'
export type WorkItemType = 'requirement' | 'defect'
export type WorkItemStatus = '待处理' | '进行中' | '已交付' | '已关闭'
export type Priority = '紧急' | '高' | '中' | '低'
export type StageStatus = 'pending' | 'running' | 'success' | 'failed'
export type PipelineStatus = 'queued' | 'running' | 'success' | 'failed'
export type ReportStatus = 'passed' | 'warning' | 'failed'

export interface Account {
  id: string
  platform: PlatformKey
  username: string
  label: string
  secretHint: string
  status: AccountStatus
  createdAt: string
}

export interface Repository {
  id: string
  name: string
  url: string
  branch: string
  localPath: string
  language: string
  accountId: string
  lastSync: string
  status: RepositoryStatus
  latestVersion: string
}

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
  feishuStatus?: string
  projectLine?: string
  designReference?: string
  requirementBreakdown?: string
  requirementScreenshotCount?: number
}

export interface WorkItemScreenshot {
  name: string
  mimeType: string
  sizeBytes: number
  dataUrl: string
}

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
  localPath?: string
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
  clientExecuted: boolean
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
  status: ReportStatus
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

export interface BootstrapData {
  repositories: Repository[]
  accounts: Account[]
  workItems: WorkItem[]
  pipelines: PipelineRun[]
  reports: TestReport[]
  feishuInbox: FeishuInboxItem[]
}

export interface StageDefinition {
  key: string
  name: string
  description: string
}
