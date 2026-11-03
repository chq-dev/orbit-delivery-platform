import type { AppDatabase } from '../db/database.js'
import { notFound } from '../domain/errors.js'
import { requiredText } from '../domain/validation.js'
import type { CredentialVault } from '../security/vault.js'
import { listAccounts } from './accountService.js'
import { triggerBuild, type BuildTriggerResult } from './buildService.js'

export interface DeliveryBuildInput {
  workItemId?: unknown
  repoId?: unknown
}

export interface DeliveryBuildOutcome {
  configured: boolean
  triggered: boolean
  message: string
  build?: BuildTriggerResult
}

export async function triggerDeliveryBuild(
  db: AppDatabase,
  vault: CredentialVault,
  input: DeliveryBuildInput,
): Promise<DeliveryBuildOutcome> {
  const workItemId = requiredText(input.workItemId, '工作项', { max: 200 })
  const repoId = requiredText(input.repoId, '代码仓库', { max: 200 })

  const workItem = db.prepare('SELECT id FROM work_items WHERE id = ?').get(workItemId)
  if (!workItem) throw notFound('工作项')
  const repository = db.prepare('SELECT id FROM repositories WHERE id = ?').get(repoId)
  if (!repository) throw notFound('代码仓库')

  const account = listAccounts(db).find(
    (item) => item.platform === 'build' && Boolean(item.serviceUrl),
  )
  if (!account) {
    return {
      configured: false,
      triggered: false,
      message: '未配置带 Jenkins 服务地址的编译系统账号，编译阶段保持未执行',
    }
  }

  const build = await triggerBuild(db, vault, account.id, undefined)
  return {
    configured: true,
    triggered: true,
    message: `已触发 Jenkins 内部编译 ${build.jobName}，构建结果以 Jenkins 为准`,
    build,
  }
}
