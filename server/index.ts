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

server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000

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

let shuttingDown = false

function shutdown(exitCode = 0): void {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(pipelineTimer)
  clearInterval(feishuSyncTimer)
  redirectServer?.close()
  const finish = () => {
    try {
      db.close()
    } finally {
      process.exit(exitCode)
    }
  }
  const forceTimer = setTimeout(finish, 10_000)
  forceTimer.unref()
  server.close(finish)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGHUP', () => {
  console.info('收到 SIGHUP；生产环境由 systemd/launchd 托管，服务保持运行')
})
process.on('uncaughtException', (error) => {
  console.error('未捕获异常，服务将由进程管理器自动重启', error)
  shutdown(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('未处理的 Promise 拒绝，服务将由进程管理器自动重启', reason)
  shutdown(1)
})
