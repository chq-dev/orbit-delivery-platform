import type { AppDatabase } from '../db/database.js'
import { notFound, unprocessable } from '../domain/errors.js'
import { describeFetchError } from '../domain/network.js'
import { requiredText } from '../domain/validation.js'
import type { CredentialVault } from '../security/vault.js'
import { listAccounts } from './accountService.js'
import { triggerBuildWithFallback } from './buildAgentService.js'
import type { BuildTriggerResult } from './buildService.js'

export interface DeliveryBuildInput {
  workItemId?: unknown
  repoId?: unknown
  clientId?: unknown
}

export interface DeliveryBuildOutcome {
  configured: boolean
  triggered: boolean
  message: string
  build?: BuildTriggerResult
  error?: string
}

export function deliveryBuildFailureOutcome(
  error: unknown,
  options: { pushed?: boolean } = {},
): DeliveryBuildOutcome {
  const detail = describeFetchError(error)
  return {
    configured: false,
    triggered: false,
    message: `${options.pushed ? '代码已提交并推送成功，但' : ''}触发 Jenkins 内部编译失败：${detail}`,
    error: detail,
  }
}

export async function triggerDeliveryBuild(
  db: AppDatabase,
  vault: CredentialVault,
  input: DeliveryBuildInput,
  ownerUserId?: string,
): Promise<DeliveryBuildOutcome> {
  const workItemId = requiredText(input.workItemId, '工作项', { max: 200 })
  const repoId = requiredText(input.repoId, '代码仓库', { max: 200 })

  const workItem = (ownerUserId === undefined
    ? db.prepare('SELECT id, owner_user_id FROM work_items WHERE id = ?').get(workItemId)
    : db
        .prepare('SELECT id, owner_user_id FROM work_items WHERE id = ? AND owner_user_id = ?')
        .get(workItemId, ownerUserId)) as { id: string; owner_user_id: string } | undefined
  if (!workItem) throw notFound('工作项')
  const repository = (ownerUserId === undefined
    ? db
        .prepare('SELECT id, owner_user_id, build_account_id FROM repositories WHERE id = ?')
        .get(repoId)
    : db
        .prepare(
          'SELECT id, owner_user_id, build_account_id FROM repositories WHERE id = ? AND owner_user_id = ?',
        )
        .get(repoId, ownerUserId)) as
    | { id: string; owner_user_id: string; build_account_id: string }
    | undefined
  if (!repository) throw notFound('代码仓库')
  const accountOwnerId = repository.owner_user_id || workItem.owner_user_id || ownerUserId

  const configuredAccount = repository.build_account_id
    ? listAccounts(db, accountOwnerId).find((item) => item.id === repository.build_account_id)
    : undefined
  if (repository.build_account_id && !configuredAccount) {
    throw unprocessable('项目绑定的编译系统账号不存在，请重新配置代码仓库的编译系统')
  }
  if (configuredAccount && configuredAccount.platform !== 'build') {
    throw unprocessable('项目绑定的账号不是编译系统账号，请重新配置代码仓库的编译系统')
  }
  const account = configuredAccount ??
    listAccounts(db, accountOwnerId).find(
      (item) => item.platform === 'build' && Boolean(item.serviceUrl),
    )
  if (!account) {
    return {
      configured: false,
      triggered: false,
      message: '未配置带 Jenkins 服务地址的编译系统账号，编译阶段保持未执行',
    }
  }
  if (!account.serviceUrl) {
    return {
      configured: false,
      triggered: false,
      message: `编译系统账号 ${account.label} 尚未配置 Jenkins 服务地址，编译阶段保持未执行`,
    }
  }

  const build = await triggerBuildWithFallback(
    db,
    vault,
    account.id,
    undefined,
    input.clientId,
  )
  return {
    configured: true,
    triggered: true,
    message: `已触发 Jenkins 内部编译 ${build.jobName}，构建结果以 Jenkins 为准`,
    build,
  }
}
