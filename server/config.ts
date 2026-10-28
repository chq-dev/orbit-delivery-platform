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
}
