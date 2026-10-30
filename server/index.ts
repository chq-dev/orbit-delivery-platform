import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
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

const server: Server = config.httpsEnabled
  ? createHttpsServer(
      {
        key: readFileSync(config.httpsKeyPath),
        cert: readFileSync(config.httpsCertPath),
        ...(config.httpsCaPath ? { ca: readFileSync(config.httpsCaPath) } : {}),
      },
      app,
    )
  : createHttpServer(app)

let redirectServer: Server | undefined
if (config.httpsEnabled && config.httpRedirectPort > 0) {
  redirectServer = createHttpServer((request, response) => {
    const host = request.headers.host?.replace(/:\d+$/, '') || 'localhost'
    const port = config.port === 443 ? '' : `:${config.port}`
    response.writeHead(308, { location: `https://${host}${port}${request.url ?? '/'}` })
    response.end()
  })
  redirectServer.listen(config.httpRedirectPort, () => {
    console.log(`HTTP 跳转已启动：http://localhost:${config.httpRedirectPort}`)
  })
}

server.listen(config.port, () => {
  const webHint = existsSync(resolve(process.cwd(), 'dist', 'index.html'))
    ? '，同时托管 dist 静态页面'
    : ''
  const protocol = config.httpsEnabled ? 'https' : 'http'
  console.log(`Orbit API 已启动：${protocol}://localhost:${config.port}${webHint}`)
  console.log(`数据库：${config.dbPath}`)
  if (!config.httpsEnabled) {
    console.warn('HTTPS 未启用；生产环境请配置证书或由受信反向代理终止 TLS')
  }
})

const pipelineTimer = setInterval(() => {
  try {
    void processFeishuOutbox(db, vault).catch((error) => {
      console.error('飞书状态回写失败', error)
    })
  } catch (error) {
    console.error('飞书状态回写调度失败', error)
  }
}, config.pipelineStepMs)

const feishuSyncTimer = setInterval(() => {
  const status = getFeishuStatus(db)
  if (status.authMode !== 'token' && status.authMode !== 'plugin') return
  void syncFeishu(db, vault, 'schedule').catch((error) => {
    console.error('飞书定时同步失败', error)
  })
}, config.feishuSyncIntervalMs)

function shutdown() {
  clearInterval(pipelineTimer)
  clearInterval(feishuSyncTimer)
  redirectServer?.close()
  server.close(() => {
    db.close()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
