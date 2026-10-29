import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createApp } from './app.js'
import { config } from './config.js'
import { createDatabase } from './db/database.js'
import {
  getFeishuStatus,
  processFeishuOutbox,
  syncFeishu,
} from './services/feishuIntegrationService.js'
import { bootstrapFeishuIntegration } from './services/feishuBootstrapService.js'
import { advanceRunningPipelines } from './services/pipelineService.js'
import { CredentialVault } from './security/vault.js'

const db = createDatabase({
  filename: config.dbPath,
})
const vault = new CredentialVault(config.vaultKey)
const app = createApp(db, vault)

if (config.feishuAutoSync) {
  try {
    const result = await bootstrapFeishuIntegration(db, vault)
    if (result.sync) {
      console.log(`飞书启动同步完成：${result.sync.message}`)
    } else if (!result.connected) {
      console.warn(
        '飞书自动同步未启用：请配置 FEISHU_ACCESS_TOKEN 或 FEISHU_PLUGIN_ID/FEISHU_PLUGIN_SECRET/FEISHU_USER_KEY',
      )
    }
  } catch (error) {
    console.error('飞书启动同步失败', error)
  }
}

const server = app.listen(config.port, () => {
  const webHint = existsSync(resolve(process.cwd(), 'dist', 'index.html'))
    ? '，同时托管 dist 静态页面'
    : ''
  console.log(`Orbit API 已启动：http://localhost:${config.port}${webHint}`)
  console.log(`数据库：${config.dbPath}`)
})

const pipelineTimer = setInterval(() => {
  try {
    advanceRunningPipelines(db)
  } catch (error) {
    console.error('流水线调度失败', error)
  }
  try {
    void processFeishuOutbox(db, vault).catch((error) => {
      console.error('飞书状态回写失败', error)
    })
  } catch (error) {
    console.error('飞书状态回写调度失败', error)
  }
}, config.pipelineStepMs)

const feishuSyncTimer = setInterval(() => {
  if (!getFeishuStatus(db).connected) return
  void syncFeishu(db, vault, 'schedule').catch((error) => {
    console.error('飞书定时同步失败', error)
  })
}, config.feishuSyncIntervalMs)

function shutdown() {
  clearInterval(pipelineTimer)
  clearInterval(feishuSyncTimer)
  server.close(() => {
    db.close()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
