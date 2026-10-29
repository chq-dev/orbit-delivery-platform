import { Router, type Request } from 'express'
import { config } from './config.js'
import type { AppDatabase } from './db/database.js'
import { AppError } from './domain/errors.js'
import type { CredentialVault } from './security/vault.js'
import { assertFeishuIngestAuthorized } from './security/ingestAuth.js'
import { createAccount, importAccounts, listAccounts } from './services/accountService.js'
import {
  connectFeishu,
  disconnectFeishu,
  getFeishuStatus,
  handleFeishuEvent,
  syncFeishu,
  testFeishuConnection,
} from './services/feishuIntegrationService.js'
import { listFeishuInbox } from './services/inboxService.js'
import { ingestFeishuWorkItems } from './services/feishuIngestService.js'
import {
  advancePipeline,
  cancelPipeline,
  getPipeline,
  listPipelines,
  startPipeline,
} from './services/pipelineService.js'
import { getTestReport, listTestReports, reportAsMarkdown } from './services/reportService.js'
import {
  createRepository,
  listRepositories,
  updateRepositorySettings,
} from './services/repositoryService.js'
import {
  createWorkItem,
  importWorkItems,
  listWorkItems,
} from './services/workItemService.js'

export function createApiRouter(db: AppDatabase, vault: CredentialVault): Router {
  const router = Router()

  router.get('/health', (_request, response) => {
    db.prepare('SELECT 1').get()
    const feishu = getFeishuStatus(db)
    const workItems = db.prepare('SELECT COUNT(*) AS count FROM work_items').get() as {
      count: number
    }
    response.json({
      status: 'ok',
      database: 'connected',
      timestamp: new Date().toISOString(),
      feishu: {
        mode: feishu.authMode,
        autoSyncEnabled: config.feishuAutoSync,
        credentialsConfigured: Boolean(
          config.feishuAccessToken ||
            (config.feishuPluginId && config.feishuPluginSecret && config.feishuUserKey),
        ),
        ingestTokenConfigured: Boolean(config.feishuIngestToken),
        connected: feishu.connected,
        lastSyncAt: feishu.lastSyncAt,
        lastSyncStatus: feishu.lastSyncStatus,
        workItemCount: workItems.count,
      },
    })
  })

  router.get('/bootstrap', (_request, response) => {
    response.json({
      repositories: listRepositories(db),
      accounts: listAccounts(db),
      workItems: listWorkItems(db),
      pipelines: listPipelines(db),
      reports: listTestReports(db),
      feishuInbox: listFeishuInbox(db),
      feishuIntegration: getFeishuStatus(db),
    })
  })

  router.get('/repositories', (_request, response) => {
    response.json(listRepositories(db))
  })

  router.post('/repositories', (request, response) => {
    response.status(201).json(createRepository(db, request.body))
  })

  router.patch('/repositories/:id', (request, response) => {
    response.json(
      updateRepositorySettings(db, request.params.id, request.body ?? {}),
    )
  })

  router.get('/accounts', (_request, response) => {
    response.json(listAccounts(db))
  })

  router.post('/accounts', (request, response) => {
    response.status(201).json(createAccount(db, vault, request.body))
  })

  router.post('/accounts/import', (request, response) => {
    const result = importAccounts(db, vault, request.body?.accounts)
    response.status(201).json({
      items: result.accounts,
      count: result.accounts.length,
      skipped: result.skipped,
    })
  })

  router.get('/feishu/inbox', (_request, response) => {
    response.json(listFeishuInbox(db))
  })

  router.get('/integrations/feishu/status', (_request, response) => {
    response.json(getFeishuStatus(db))
  })

  router.post('/integrations/feishu/connect', async (request, response) => {
    response.status(201).json(await connectFeishu(db, vault, request.body))
  })

  router.post('/integrations/feishu/test', async (_request, response) => {
    response.json(await testFeishuConnection(db, vault))
  })

  router.post('/integrations/feishu/sync', async (_request, response) => {
    response.json(await syncFeishu(db, vault, 'manual'))
  })

  router.post('/integrations/feishu/ingest', (request, response) => {
    assertFeishuIngestAuthorized(
      { headers: request.headers, ip: request.ip },
      config.feishuIngestToken,
    )
    response.status(201).json(ingestFeishuWorkItems(db, request.body))
  })

  router.post('/integrations/feishu/disconnect', (_request, response) => {
    response.json(disconnectFeishu(db))
  })

  router.post('/integrations/feishu/events', (request, response) => {
    const rawBody = (request as Request & { rawBody?: Buffer }).rawBody
    response.json(handleFeishuEvent(db, vault, request.body, rawBody, request.headers))
  })

  router.get('/work-items', (_request, response) => {
    response.json(listWorkItems(db))
  })

  router.post('/work-items', (request, response) => {
    response.status(201).json(createWorkItem(db, request.body))
  })

  router.post('/work-items/import', (request, response) => {
    const result = importWorkItems(db, request.body?.items)
    response.status(201).json({
      items: result.items,
      count: result.items.length,
      skipped: result.skipped,
    })
  })

  router.get('/pipelines', (_request, response) => {
    response.json(listPipelines(db))
  })

  router.get('/pipelines/:id', (request, response) => {
    response.json(getPipeline(db, request.params.id))
  })

  router.post('/pipelines', (request, response) => {
    response.status(201).json(startPipeline(db, request.body))
  })

  router.post('/pipelines/:id/advance', (request, response) => {
    response.json(advancePipeline(db, request.params.id))
  })

  router.post('/pipelines/:id/cancel', (request, response) => {
    response.json(cancelPipeline(db, request.params.id))
  })

  router.get('/reports', (_request, response) => {
    response.json(listTestReports(db))
  })

  router.get('/reports/:id', (request, response) => {
    response.json(getTestReport(db, request.params.id))
  })

  router.get('/reports/:id/markdown', (request, response) => {
    const report = getTestReport(db, request.params.id)
    response.type('text/markdown').send(reportAsMarkdown(report))
  })

  router.use((_request, _response, next) => {
    next(new AppError(404, 'ROUTE_NOT_FOUND', 'API 路由不存在'))
  })

  return router
}
