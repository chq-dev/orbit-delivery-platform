export type PageKey =
  | 'dashboard'
  | 'repositories'
  | 'accounts'
  | 'work-items'
  | 'pipelines'
  | 'reports'

export interface AuthUser {
  id: string
  username: string
  createdAt: string
}

export type PlatformKey = 'git' | 'feishu' | 'build' | 'device'

export interface Repository {
  id: string
  name: string
  url: string
  branch: string
  localPath: string
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

export interface WorkItemScreenshot {
  name: string
  mimeType: string
  sizeBytes: number
  dataUrl: string
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
  frontendOnly?: boolean
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

export interface FeishuIntegrationStatus {
  connected: boolean
  status?: 'active' | 'error'
  authMode?: 'token' | 'plugin' | 'cli'
  projectKey?: string
  pluginId?: string
  pluginSecretHint?: string
  accessTokenHint?: string
  userKey?: string
  defaultRepoId?: string
  requirementTypeKey?: string
  defectTypeKey?: string
  defaultOwner?: string
  closeTransitionId?: string
  webhookConfigured: boolean
  webhookSecretHint?: string
  lastSyncAt?: string
  lastSyncStatus?: 'success' | 'failed'
  lastSyncMessage?: string
  eventPath: string
}

export interface FeishuSyncResult {
  fetched: number
  upserted: number
  archived?: number
  skipped: number
  message: string
  syncedAt: string
}

export interface FeishuSyncTokenStatus {
  configured: boolean
  source: 'env' | 'database' | 'none'
  hint?: string
  updatedAt?: string
}

export interface FeishuSyncTokenBootstrapResult {
  token: string
  status: FeishuSyncTokenStatus
}

export interface FeishuClientAgentConfigStatus {
  configured: boolean
  platformBaseUrl?: string
  projectKey: string
  repoId?: string
}

export interface FeishuClientAgentHealth {
  ok: true
  version: number
  config: FeishuClientAgentConfigStatus
  meegle: {
    available: boolean
    authenticated: boolean
    reason?: string
    host?: string
  }
  running: boolean
  lastRun: {
    at: string
    status: 'success' | 'failed'
    summary?: unknown
    error?: string
  } | null
  pendingLogin: {
    userCode: string
    verificationUriComplete: string
    expiresAt: number
  } | null
  feishuMcp?: {
    enabled: boolean
    configured: boolean
    available: boolean
    authenticated: boolean
    command?: string
    reason?: string
  }
  meegleMcp?: {
    enabled: boolean
    configured: boolean
    available: boolean
    command?: string
    reason?: string
  }
  delivery?: LocalDeliveryJob | null
  codex?: {
    available: boolean
    path?: string
  }
}

export type LocalDeliveryJobStatus = 'running' | 'succeeded' | 'failed'

export type LocalDeliveryStepStatus = 'pending' | 'running' | 'success' | 'failed'

export interface LocalDeliveryStep {
  key: string
  name: string
  description: string
  status: LocalDeliveryStepStatus
  log?: string
  startedAt?: string
  finishedAt?: string
}

export interface LocalDeliveryResult {
  status?: string
  commit?: string
  changedFiles?: string[]
  evidence?: Record<string, boolean>
  promptFile?: string
  lastMessageFile?: string
  platformPipeline?: PipelineRun
}

export interface LocalDeliveryJob {
  id: string
  commandId?: string
  status: LocalDeliveryJobStatus
  stage: string
  workItemId: string
  repoId: string
  localPath?: string
  branch?: string
  steps?: LocalDeliveryStep[]
  startedAt: string
  finishedAt?: string
  result?: LocalDeliveryResult
  error?: string
}

export interface FeishuClientAgentState {
  checking: boolean
  online: boolean
  lastSeenAt?: string
  health?: FeishuClientAgentHealth
  error?: string
}

export type FeishuAgentCommandType =
  | 'login_start'
  | 'sync'
  | 'rotate_token'
  | 'delivery_start'
export type FeishuAgentCommandStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export interface FeishuAgentCommand {
  id: string
  type: FeishuAgentCommandType
  status: FeishuAgentCommandStatus
  payload?: unknown
  createdAt: string
  updatedAt: string
  result?: unknown
  error?: string
}

export interface FeishuAgentBridgeStatus {
  online: boolean
  lastSeenAt?: string
  staleAfterSeconds: number
  health?: FeishuClientAgentHealth
  activeCommand: FeishuAgentCommand | null
  lastCommand: FeishuAgentCommand | null
  commands: FeishuAgentCommand[]
}

export interface FeishuLoginChallenge {
  verificationUri: string
  verificationUriComplete: string
  userCode: string
  expiresAt: number
}

export interface FeishuAgentLoginState {
  challenge?: FeishuLoginChallenge
  polling: boolean
  error?: string
}

export interface FeishuSnapshotStatus {
  configured: boolean
  url: string
  loading: boolean
  itemCount: number
  lastUpdatedAt?: string
  error?: string
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
