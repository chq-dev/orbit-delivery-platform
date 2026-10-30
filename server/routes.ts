import { Router, type Request } from 'express'
import { config } from './config.js'
import type { AppDatabase } from './db/database.js'
import { AppError } from './domain/errors.js'
import type { CredentialVault } from './security/vault.js'
import {
  assertFeishuIngestAuthorized,
  feishuIngestBearerToken,
} from './security/ingestAuth.js'
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
  completeFeishuAgentCommand,
  enqueueFeishuAgentCommand,
  getFeishuAgentBridgeStatus,
  recordFeishuAgentHeartbeat,
  updateFeishuAgentCommandProgress,
} from './services/feishuAgentBridgeService.js'
import {
  bootstrapFeishuSyncToken,
  getFeishuSyncTokenStatus,
  rotateFeishuSyncToken,
  verifyFeishuSyncToken,
} from './services/feishuSyncTokenService.js'
import {
  cancelPipeline,
  getPipeline,
  listPipelines,
} from './services/pipelineService.js'
import { recordLocalDelivery } from './services/localDeliveryService.js'
import { LOCAL_DELIVERY_CONTRACT_VERSION } from './services/localDeliveryAgentService.js'
import { getTestReport, listTestReports, reportAsMarkdown } from './services/reportService.js'
import {
  createRepository,
  listRepositories,
  updateRepositorySettings,
} from './services/repositoryService.js'
import {
  createWorkItem,
  getWorkItem,
  importWorkItems,
  listWorkItemSummaries,
} from './services/workItemService.js'

export function createApiRouter(db: AppDatabase, vault: CredentialVault): Router {
  const router = Router()

  const assertSyncTokenAuthorized = (request: Request): void => {
    const tokenStatus = getFeishuSyncTokenStatus(db)
    assertFeishuIngestAuthorized(
      { headers: request.headers, ip: request.ip },
      config.feishuIngestToken,
      tokenStatus.source === 'database'
        ? (token) => verifyFeishuSyncToken(db, token)
        : undefined,
    )
  }

  router.get('/health', (_request, response) => {
    db.prepare('SELECT 1').get()
    const feishu = getFeishuStatus(db)
    const agent = getFeishuAgentBridgeStatus(db)
    const workItems = db
      .prepare('SELECT COUNT(*) AS count FROM work_items WHERE archived_at IS NULL')
      .get() as { count: number }
    response.json({
      status: 'ok',
      database: 'connected',
      timestamp: new Date().toISOString(),
      deliveryContractVersion: LOCAL_DELIVERY_CONTRACT_VERSION,
      feishu: {
        mode: feishu.authMode,
        autoSyncEnabled: config.feishuAutoSync,
        credentialsConfigured: Boolean(
          config.feishuAccessToken ||
            (config.feishuPluginId && config.feishuPluginSecret && config.feishuUserKey),
        ),
        ingestTokenConfigured: getFeishuSyncTokenStatus(db).configured,
        connected: feishu.connected,
        lastSyncAt: feishu.lastSyncAt,
        lastSyncStatus: feishu.lastSyncStatus,
        workItemCount: workItems.count,
      },
      agent: {
        online: agent.online,
        lastSeenAt: agent.lastSeenAt,
      },
    })
  })

  router.get('/bootstrap', (request, response) => {
    const includeWorkItems = request.query.includeWorkItems !== '0'
    const includeFeishuInbox = request.query.includeFeishuInbox !== '0'
    response.json({
      repositories: listRepositories(db),
      accounts: listAccounts(db),
      workItems: includeWorkItems ? listWorkItemSummaries(db) : [],
      pipelines: listPipelines(db),
      reports: listTestReports(db),
      feishuInbox: includeFeishuInbox ? listFeishuInbox(db) : [],
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
    assertSyncTokenAuthorized(request)
    response.status(201).json(ingestFeishuWorkItems(db, request.body))
  })

  router.get('/integrations/feishu/agent/status', (_request, response) => {
    response.json(getFeishuAgentBridgeStatus(db))
  })

  router.post('/integrations/feishu/agent/heartbeat', (request, response) => {
    assertSyncTokenAuthorized(request)
    response.json({
      ok: true,
      ...recordFeishuAgentHeartbeat(db, request.body),
    })
  })

  router.post('/integrations/feishu/agent/commands', (request, response) => {
    response
      .status(202)
      .json(enqueueFeishuAgentCommand(db, request.body?.type, request.body?.payload))
  })

  router.post('/integrations/feishu/agent/commands/:id/progress', (request, response) => {
    assertSyncTokenAuthorized(request)
    response.json(updateFeishuAgentCommandProgress(db, request.params.id, request.body))
  })

  router.post('/integrations/feishu/agent/commands/:id/result', (request, response) => {
    assertSyncTokenAuthorized(request)
    response.json(completeFeishuAgentCommand(db, request.params.id, request.body))
  })

  router.get('/integrations/feishu/sync-token', (_request, response) => {
    response.json(getFeishuSyncTokenStatus(db))
  })

  router.post('/integrations/feishu/sync-token/bootstrap', (_request, response) => {
    response.status(201).json(bootstrapFeishuSyncToken(db))
  })

  router.post('/integrations/feishu/sync-token/rotate', (request, response) => {
    response.json(rotateFeishuSyncToken(db, feishuIngestBearerToken(request.headers)))
  })

  router.post('/integrations/feishu/disconnect', (_request, response) => {
    response.json(disconnectFeishu(db))
  })

  router.post('/integrations/feishu/events', (request, response) => {
    const rawBody = (request as Request & { rawBody?: Buffer }).rawBody
    response.json(handleFeishuEvent(db, vault, request.body, rawBody, request.headers))
  })

  router.get('/work-items', (_request, response) => {
    response.json(listWorkItemSummaries(db))
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

  router.get('/work-items/:id', (request, response) => {
    response.json(getWorkItem(db, request.params.id))
  })

  router.get('/pipelines', (_request, response) => {
    response.json(listPipelines(db))
  })

  router.get('/pipelines/:id', (request, response) => {
    response.json(getPipeline(db, request.params.id))
  })

  router.post('/pipelines', (_request, _response) => {
    throw new AppError(
      409,
      'SERVER_PIPELINE_DISABLED',
      '服务端模拟流水线已停用，请由本机代理执行并将真实结果回写到 /api/pipelines/local',
    )
  })

  router.post('/pipelines/local', (request, response) => {
    response.status(201).json(recordLocalDelivery(db, request.body ?? {}))
  })

  router.post('/pipelines/:id/advance', (_request, _response) => {
    throw new AppError(
      409,
      'SERVER_PIPELINE_DISABLED',
      '服务端不能推进交付阶段；阶段结果必须来自本机真实执行证据',
    )
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
