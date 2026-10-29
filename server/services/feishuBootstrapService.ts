import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../db/database.js'
import { config } from '../config.js'
import { AppError } from '../domain/errors.js'
import type { CredentialVault } from '../security/vault.js'
import { createAccount, listAccounts } from './accountService.js'
import {
  connectFeishu,
  getFeishuStatus,
  syncFeishu,
  type FeishuSyncResult,
} from './feishuIntegrationService.js'
import { createRepository, listRepositories } from './repositoryService.js'

export interface FeishuBootstrapResult {
  connected: boolean
  configuredFromEnvironment: boolean
  sync?: FeishuSyncResult
}

export async function bootstrapFeishuIntegration(
  db: AppDatabase,
  vault: CredentialVault,
): Promise<FeishuBootstrapResult> {
  if (!config.feishuAutoSync) {
    return { connected: getFeishuStatus(db).connected, configuredFromEnvironment: false }
  }

  const status = getFeishuStatus(db)
  if (!hasEnvironmentCredentials()) {
    if (!status.connected) {
      return { connected: false, configuredFromEnvironment: false }
    }
    return {
      connected: true,
      configuredFromEnvironment: false,
      sync: await syncFeishu(db, vault, 'schedule'),
    }
  }

  const defaultRepoId =
    config.feishuDefaultRepoId || status.defaultRepoId || ensureDefaultRepository(db, vault)
  await connectFeishu(db, vault, {
    accessToken: config.feishuAccessToken || undefined,
    pluginId: config.feishuPluginId || undefined,
    pluginSecret: config.feishuPluginSecret || undefined,
    userKey: config.feishuUserKey || undefined,
    projectKey: config.feishuProjectKey,
    defaultRepoId,
    requirementTypeKey: config.feishuRequirementTypeKey,
    defectTypeKey: config.feishuDefectTypeKey,
    defaultOwner: config.feishuDefaultOwner,
    closeTransitionId: config.feishuCloseTransitionId || status.closeTransitionId || undefined,
  })
  return {
    connected: true,
    configuredFromEnvironment: true,
    sync: await syncFeishu(db, vault, 'schedule'),
  }
}

function hasEnvironmentCredentials(): boolean {
  return Boolean(
    config.feishuAccessToken ||
      (config.feishuPluginId && config.feishuPluginSecret && config.feishuUserKey),
  )
}

function ensureDefaultRepository(db: AppDatabase, vault: CredentialVault): string {
  if (config.feishuDefaultRepoId) {
    const configured = db
      .prepare('SELECT id FROM repositories WHERE id = ?')
      .get(config.feishuDefaultRepoId) as { id: string } | undefined
    if (!configured) {
      throw new AppError(
        422,
        'FEISHU_REPO_NOT_FOUND',
        `FEISHU_DEFAULT_REPO_ID 指向的仓库 ${config.feishuDefaultRepoId} 不存在`,
      )
    }
    return configured.id
  }

  const existing = listRepositories(db)
  if (existing[0]) return existing[0].id

  let account = listAccounts(db).find((entry) => entry.platform === 'git')
  if (!account) {
    account = createAccount(db, vault, {
      platform: 'git',
      username: 'feishu-import',
      password: randomUUID(),
      label: '飞书同步默认账号（请替换为实际 Git 凭据）',
    })
  }

  const repository = createRepository(db, {
    name: 'sme-main',
    url: config.feishuDefaultRepoUrl,
    branch: config.feishuDefaultRepoBranch,
    localPath: config.feishuDefaultRepoLocalPath,
    language: 'Vue 3 + Lua',
    accountId: account.id,
  })
  return repository.id
}
