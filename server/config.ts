import 'dotenv/config'
import { resolve } from 'node:path'

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const nodeEnv = process.env.NODE_ENV ?? 'development'
const vaultKey = process.env.VAULT_KEY ?? 'orbit-local-development-key-change-before-production'
const feishuBaseUrl = process.env.FEISHU_PROJECT_BASE_URL ?? 'https://project.feishu.cn'

if (nodeEnv === 'production' && !process.env.VAULT_KEY) {
  throw new Error('生产环境必须配置 VAULT_KEY，用于加密平台账号凭据')
}

export const config = {
  nodeEnv,
  port: positiveInteger(process.env.PORT, 8787),
  dbPath: process.env.DB_PATH ?? resolve(process.cwd(), 'data', 'orbit.db'),
  vaultKey,
  feishuBaseUrl,
  feishuSyncIntervalMs: positiveInteger(process.env.FEISHU_SYNC_INTERVAL_MS, 300_000),
  pipelineStepMs: positiveInteger(process.env.PIPELINE_STEP_MS, 1_800),
  feishuAutoSync: process.env.FEISHU_AUTO_SYNC !== 'false',
  feishuProjectKey: process.env.FEISHU_PROJECT_KEY ?? 'rjcloud',
  feishuAccessToken: process.env.FEISHU_ACCESS_TOKEN ?? '',
  feishuIngestToken: process.env.FEISHU_INGEST_TOKEN ?? '',
  feishuPluginId: process.env.FEISHU_PLUGIN_ID ?? '',
  feishuPluginSecret: process.env.FEISHU_PLUGIN_SECRET ?? '',
  feishuUserKey: process.env.FEISHU_USER_KEY ?? '',
  feishuRequirementTypeKey: process.env.FEISHU_REQUIREMENT_TYPE_KEY ?? 'story',
  feishuDefectTypeKey: process.env.FEISHU_DEFECT_TYPE_KEY ?? 'issue',
  feishuDefaultOwner: process.env.FEISHU_DEFAULT_OWNER ?? '飞书同步',
  feishuCloseTransitionId: process.env.FEISHU_CLOSE_TRANSITION_ID ?? '',
  feishuDefaultRepoId: process.env.FEISHU_DEFAULT_REPO_ID ?? '',
  feishuDefaultRepoUrl:
    process.env.FEISHU_DEFAULT_REPO_URL ?? 'http://cloudgit.rj.link/sme/sme-main.git',
  feishuDefaultRepoBranch: process.env.FEISHU_DEFAULT_REPO_BRANCH ?? 'dev-harvey',
  feishuDefaultRepoLocalPath: process.env.FEISHU_DEFAULT_REPO_LOCAL_PATH ?? '',
}
