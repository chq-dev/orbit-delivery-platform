import { Router, type Request, type Response } from 'express'
import { config } from './config.js'
import type { AppDatabase } from './db/database.js'
import { AppError } from './domain/errors.js'
import type { CredentialVault } from './security/vault.js'
import {
  assertFeishuIngestAuthorized,
  feishuIngestBearerToken,
} from './security/ingestAuth.js'
import {
  clearSessionCookie,
  parseSessionCookie,
  sessionCookie,
} from './security/sessionCookie.js'
import {
  authenticateUser,
  createUserSession,
  registerUser,
  revokeSession,
  userForSessionToken,
  type AuthUser,
} from './services/authService.js'
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
import { readFeishuSnapshotFromDatabase } from './services/feishuSnapshotService.js'
import {
  cancelPipeline,
  getPipeline,
  listPipelines,
} from './services/pipelineService.js'
import { recordLocalDelivery } from './services/localDeliveryService.js'
import {
  LOCAL_DELIVERY_CONTRACT_VERSION,
  parseLocalDeliveryAgentRequest,
} from './services/localDeliveryAgentService.js'
import { getTestReport, listTestReports, reportAsMarkdown } from './services/reportService.js'
import {
  createRepository,
  listRepositories,
  updateRepositorySettings,
} from './services/repositoryService.js'
import {
  createWorkItem,
  assertRequirementDeliveryContextReady,
  getWorkItemDeliveryContext,
  getWorkItem,
  importWorkItems,
  listWorkItemSummaries,
  saveWorkItemDeliveryContext,
} from './services/workItemService.js'

export function createApiRouter(db: AppDatabase, vault: CredentialVault): Router {
  const router = Router()
  const sessionMaxAgeSeconds = config.authSessionDays * 24 * 60 * 60

  const sessionToken = (request: Request): string =>
    parseSessionCookie(request.headers.cookie)

  const sessionUser = (request: Request): AuthUser | undefined =>
    userForSessionToken(db, sessionToken(request))

  const cookieSecure = (request: Request): boolean =>
    request.secure || config.authCookieSecure

  const authPayload = (user: AuthUser) => ({ authenticated: true, user })

  const sendSession = (
    request: Request,
    response: Response,
    user: AuthUser,
  ): void => {
    const session = createUserSession(db, user, sessionMaxAgeSeconds)
    response.append(
      'set-cookie',
      sessionCookie(session.token, sessionMaxAgeSeconds, cookieSecure(request)),
    )
    response.json({ ...authPayload(user), expiresAt: session.expiresAt })
  }

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

  const hasValidServiceToken = (request: Request): boolean => {
    const token = feishuIngestBearerToken(request.headers)
    return Boolean(token) && verifyFeishuSyncToken(db, token)
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

  router.get('/auth/session', (request, response) => {
    const user = sessionUser(request)
    response.json(user ? authPayload(user) : { authenticated: false })
  })

  router.post('/auth/register', async (request, response) => {
    if (!config.authRegistrationEnabled) {
      throw new AppError(403, 'REGISTRATION_DISABLED', '当前部署已关闭用户注册')
    }
    const user = await registerUser(db, request.body ?? {})
    sendSession(request, response, user)
  })

  router.post('/auth/login', async (request, response) => {
    const user = await authenticateUser(db, request.body ?? {})
    sendSession(request, response, user)
  })

  router.post('/auth/logout', (request, response) => {
    revokeSession(db, sessionToken(request))
    response.append('set-cookie', clearSessionCookie(cookieSecure(request)))
    response.json({ ok: true })
  })

  router.use((request, _response, next) => {
    if (sessionUser(request)) {
      next()
      return
    }
    const path = request.path
    const serviceRoute =
      (request.method === 'GET' &&
        (path === '/bootstrap' ||
          path === '/repositories' ||
          /^\/work-items\/[^/]+\/delivery-context$/.test(path))) ||
      (request.method === 'POST' &&
        (path === '/pipelines/local' ||
          path === '/integrations/feishu/ingest' ||
          path === '/integrations/feishu/agent/heartbeat' ||
          /^\/integrations\/feishu\/agent\/commands\/[^/]+\/(?:progress|result)$/.test(path) ||
          path === '/integrations/feishu/sync-token/rotate'))
    if (serviceRoute && hasValidServiceToken(request)) {
      next()
      return
    }
    if (request.method === 'POST' && path === '/integrations/feishu/events') {
      next()
      return
    }
    throw new AppError(401, 'AUTH_REQUIRED', '请先登录后再访问平台')
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

  router.get('/feishu/snapshot', (_request, response) => {
    const snapshot = readFeishuSnapshotFromDatabase(db, config.feishuProjectKey)
    if (!snapshot) {
      response.status(404).json({
        error: { code: 'FEISHU_SNAPSHOT_NOT_FOUND', message: '飞书快照尚未生成' },
      })
      return
    }
    response.json(snapshot)
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
    if (request.body?.type === 'delivery_start') {
      const payload = parseLocalDeliveryAgentRequest(request.body?.payload)
      assertRequirementDeliveryContextReady(db, payload.workItemId)
    }
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

  router.get('/work-items/:id/delivery-context', (request, response) => {
    response.json(getWorkItemDeliveryContext(db, request.params.id))
  })

  router.put('/work-items/:id/delivery-context', (request, response) => {
    response.json(
      saveWorkItemDeliveryContext(db, request.params.id, request.body ?? {}),
    )
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
