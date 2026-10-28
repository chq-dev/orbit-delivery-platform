import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createApp } from './app.js'
import { config } from './config.js'
import { createDatabase } from './db/database.js'
import { advanceRunningPipelines } from './services/pipelineService.js'
import { CredentialVault } from './security/vault.js'

const db = createDatabase({
  filename: config.dbPath,
})
const vault = new CredentialVault(config.vaultKey)
const app = createApp(db, vault)

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
}, config.pipelineStepMs)

function shutdown() {
  clearInterval(pipelineTimer)
  server.close(() => {
    db.close()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
