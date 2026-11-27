import { Router, type Request, type Response } from 'express'
import { config } from './config.js'
import { claimUnownedDataForUser } from './db/ownership.js'
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
import {
  createAccount,
  deleteAccount,
  getAccount,
  importAccounts,
  listAccounts,
  updateAccount,
} from './services/accountService.js'
import { getBuildJobWithFallback, triggerBuildWithFallback } from './services/buildAgentService.js'
import { triggerDeliveryBuild } from './services/deliveryBuildService.js'
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
  approveFeishuAgentPairing,
  completeFeishuAgentPairing,
  listFeishuAgentPairings,
  requestFeishuAgentPairing,
} from './services/feishuAgentPairingService.js'
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
  getCloudDeliveryJob,
  getCloudDeliveryReadiness,
  startCloudDelivery,
} from './services/cloudDeliveryService.js'
import {
  LOCAL_DELIVERY_CONTRACT_VERSION,
  parseLocalDeliveryAgentRequest,
} from './services/localDeliveryAgentService.js'
import { getTestReport, listTestReports, reportAsMarkdown } from './services/reportService.js'
import {
  syncRuijieBugs,
  testRuijieBugConnection,
} from './services/ruijieBugService.js'
import {
  createRepository,
  getRepository,
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

  const currentUser = (request: Request): AuthUser => {
    const user = sessionUser(request)
    if (!user) throw new AppError(401, 'AUTH_REQUIRED', '请先登录后再访问平台')
    return user
  }

  const scopedOwnerId = (request: Request): string | undefined =>
    sessionUser(request)?.id

  const assertSessionOwnsWorkItem = (request: Request, workItemId: unknown): void => {
    const user = sessionUser(request)
    if (!user || typeof workItemId !== 'string' || !workItemId) return
    getWorkItem(db, workItemId, user.id)
  }

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
    assertFeishuIngestAuthorized(
      { headers: request.headers, ip: request.ip },
      config.feishuIngestToken,
      (token) => verifyFeishuSyncToken(db, token),
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
    claimUnownedDataForUser(db, user.id)
    sendSession(request, response, user)
  })

  router.post('/auth/login', async (request, response) => {
    const user = await authenticateUser(db, request.body ?? {})
    claimUnownedDataForUser(db, user.id)
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
    if (
      request.method === 'POST' &&
      path === '/integrations/feishu/agent/pairing/poll'
    ) {
      next()
      return
    }
    const serviceRoute =
      (request.method === 'GET' &&
        (path === '/bootstrap' ||
          path === '/repositories' ||
          /^\/work-items\/[^/]+\/delivery-context$/.test(path))) ||
      (request.method === 'POST' &&
        (path === '/pipelines/local' ||
          path === '/pipelines/local/build' ||
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
    const ownerUserId = scopedOwnerId(request)
    response.json({
      repositories: listRepositories(db, ownerUserId),
      accounts: listAccounts(db, ownerUserId),
      workItems: includeWorkItems ? listWorkItemSummaries(db, ownerUserId) : [],
      pipelines: listPipelines(db, ownerUserId),
      reports: listTestReports(db, ownerUserId),
      feishuInbox: includeFeishuInbox ? listFeishuInbox(db, ownerUserId) : [],
      feishuIntegration: getFeishuStatus(db, ownerUserId),
    })
  })

  router.get('/repositories', (request, response) => {
    response.json(listRepositories(db, scopedOwnerId(request)))
  })

  router.post('/repositories', (request, response) => {
    response.status(201).json(createRepository(db, request.body, currentUser(request).id))
  })

  router.patch('/repositories/:id', (request, response) => {
    response.json(
      updateRepositorySettings(
        db,
        request.params.id,
        request.body ?? {},
        currentUser(request).id,
      ),
    )
  })

  router.get('/accounts', (request, response) => {
    response.json(listAccounts(db, currentUser(request).id))
  })

  router.post('/accounts', (request, response) => {
    response.status(201).json(createAccount(db, vault, request.body, currentUser(request).id))
  })

  router.post('/accounts/import', (request, response) => {
    const result = importAccounts(db, vault, request.body?.accounts, currentUser(request).id)
    response.status(201).json({
      items: result.accounts,
      count: result.accounts.length,
      skipped: result.skipped,
    })
  })

  router.patch('/accounts/:id', (request, response) => {
    response.json(
      updateAccount(db, vault, request.params.id, request.body ?? {}, currentUser(request).id),
    )
  })

  router.delete('/accounts/:id', (request, response) => {
    deleteAccount(db, request.params.id, currentUser(request).id)
    response.json({ ok: true })
  })

  router.get('/accounts/:id/build-job', async (request, response) => {
    const user = currentUser(request)
    getAccount(db, request.params.id, user.id)
    response.json(
      await getBuildJobWithFallback(
        db,
        vault,
        request.params.id,
        request.query.clientId,
        user.id,
      ),
    )
  })

  router.post('/accounts/:id/build', async (request, response) => {
    const user = currentUser(request)
    getAccount(db, request.params.id, user.id)
    response.status(202).json(
      await triggerBuildWithFallback(
        db,
        vault,
        request.params.id,
        request.body?.parameters,
        request.body?.clientId,
        user.id,
      ),
    )
  })

  router.get('/feishu/inbox', (request, response) => {
    response.json(listFeishuInbox(db, currentUser(request).id))
  })

  router.post('/integrations/ruijie/test', async (request, response) => {
    response.json(
      await testRuijieBugConnection(
        db,
        vault,
        request.body?.accountId,
        currentUser(request).id,
      ),
    )
  })

  router.post('/integrations/ruijie/sync', async (request, response) => {
    response.json(
      await syncRuijieBugs(db, vault, request.body ?? {}, currentUser(request).id),
    )
  })

  router.get('/feishu/snapshot', (request, response) => {
    const snapshot = readFeishuSnapshotFromDatabase(
      db,
      config.feishuProjectKey,
      currentUser(request).id,
    )
    if (!snapshot) {
      response.status(404).json({
        error: { code: 'FEISHU_SNAPSHOT_NOT_FOUND', message: '飞书快照尚未生成' },
      })
      return
    }
    response.json(snapshot)
  })

  router.get('/integrations/feishu/status', (request, response) => {
    response.json(getFeishuStatus(db, currentUser(request).id))
  })

  router.post('/integrations/feishu/connect', async (request, response) => {
    const user = currentUser(request)
    if (typeof request.body?.defaultRepoId === 'string' && request.body.defaultRepoId) {
      getRepository(db, request.body.defaultRepoId, user.id)
    }
    response.status(201).json(await connectFeishu(db, vault, request.body, user.id))
  })

  router.post('/integrations/feishu/test', async (request, response) => {
    response.json(await testFeishuConnection(db, vault, currentUser(request).id))
  })

  router.post('/integrations/feishu/sync', async (request, response) => {
    response.json(await syncFeishu(db, vault, 'manual', currentUser(request).id))
  })

  router.post('/integrations/feishu/ingest', (request, response) => {
    assertSyncTokenAuthorized(request)
    response.status(201).json(ingestFeishuWorkItems(db, request.body))
  })

  router.get('/integrations/feishu/agent/status', (request, response) => {
    response.json(
      getFeishuAgentBridgeStatus(db, request.query.clientId, currentUser(request).id),
    )
  })

  router.get('/deliveries/cloud/readiness', (_request, response) => {
    response.json(getCloudDeliveryReadiness())
  })

  router.post('/deliveries/cloud', (request, response) => {
    const payload = parseLocalDeliveryAgentRequest({
      ...(request.body ?? {}),
      temporaryCheckout: true,
    })
    assertRequirementDeliveryContextReady(db, payload.workItemId)
    response.status(202).json(startCloudDelivery(db, vault, payload))
  })

  router.get('/deliveries/cloud/:jobId', (request, response) => {
    const job = getCloudDeliveryJob(request.params.jobId)
    if (!job) throw new AppError(404, 'CLOUD_DELIVERY_NOT_FOUND', '服务器临时交付任务不存在')
    response.json(job)
  })

  router.post('/integrations/feishu/agent/pairing/poll', (request, response) => {
    response.json(requestFeishuAgentPairing(db, request.body, request.ip ?? ''))
  })

  router.get('/integrations/feishu/agent/pairings', (request, response) => {
    response.json(listFeishuAgentPairings(db, currentUser(request).id))
  })

  router.post('/integrations/feishu/agent/pairings/:clientId/approve', (request, response) => {
    response.json(
      approveFeishuAgentPairing(
        db,
        request.params.clientId,
        request.body?.repoPaths,
        currentUser(request).id,
      ),
    )
  })

  router.post('/integrations/feishu/agent/heartbeat', (request, response) => {
    assertSyncTokenAuthorized(request)
    const heartbeat = recordFeishuAgentHeartbeat(db, request.body, vault)
    completeFeishuAgentPairing(db, request.body?.clientId)
    response.json({
      ok: true,
      ...heartbeat,
    })
  })

  router.post('/integrations/feishu/agent/commands', (request, response) => {
    const user = currentUser(request)
    if (request.body?.type === 'delivery_start') {
      const payload = parseLocalDeliveryAgentRequest(request.body?.payload)
      assertRequirementDeliveryContextReady(db, payload.workItemId, user.id)
    }
    response
      .status(202)
      .json(
        enqueueFeishuAgentCommand(
          db,
          request.body?.type,
          request.body?.payload,
          request.body?.clientId,
          user.id,
        ),
      )
  })

  router.post('/integrations/feishu/agent/commands/:id/progress', (request, response) => {
    assertSyncTokenAuthorized(request)
    response.json(
      updateFeishuAgentCommandProgress(
        db,
        request.params.id,
        request.body,
        request.body?.clientId,
      ),
    )
  })

  router.post('/integrations/feishu/agent/commands/:id/result', (request, response) => {
    assertSyncTokenAuthorized(request)
    response.json(
      completeFeishuAgentCommand(db, request.params.id, request.body, request.body?.clientId),
    )
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

  router.post('/integrations/feishu/disconnect', (request, response) => {
    response.json(disconnectFeishu(db, currentUser(request).id))
  })

  router.post('/integrations/feishu/events', (request, response) => {
    const rawBody = (request as Request & { rawBody?: Buffer }).rawBody
    const integrationId =
      typeof request.query.integration === 'string' ? request.query.integration.trim() : undefined
    response.json(
      handleFeishuEvent(
        db,
        vault,
        request.body,
        rawBody,
        request.headers,
        integrationId || undefined,
      ),
    )
  })

  router.get('/work-items', (request, response) => {
    response.json(listWorkItemSummaries(db, currentUser(request).id))
  })

  router.post('/work-items', (request, response) => {
    response.status(201).json(createWorkItem(db, request.body, currentUser(request).id))
  })

  router.post('/work-items/import', (request, response) => {
    const result = importWorkItems(db, request.body?.items, currentUser(request).id)
    response.status(201).json({
      items: result.items,
      count: result.items.length,
      skipped: result.skipped,
    })
  })

  router.get('/work-items/:id/delivery-context', (request, response) => {
    response.json(
      getWorkItemDeliveryContext(db, request.params.id, scopedOwnerId(request)),
    )
  })

  router.put('/work-items/:id/delivery-context', (request, response) => {
    response.json(
      saveWorkItemDeliveryContext(
        db,
        request.params.id,
        request.body ?? {},
        currentUser(request).id,
      ),
    )
  })

  router.get('/work-items/:id', (request, response) => {
    response.json(getWorkItem(db, request.params.id, currentUser(request).id))
  })

  router.get('/pipelines', (request, response) => {
    response.json(listPipelines(db, currentUser(request).id))
  })

  router.get('/pipelines/:id', (request, response) => {
    response.json(getPipeline(db, request.params.id, currentUser(request).id))
  })

  router.post('/pipelines', (_request, _response) => {
    throw new AppError(
      409,
      'SERVER_PIPELINE_DISABLED',
      '服务端模拟流水线已停用，请由本机代理执行并将真实结果回写到 /api/pipelines/local',
    )
  })

  router.post('/pipelines/local', (request, response) => {
    assertSessionOwnsWorkItem(request, request.body?.workItemId)
    response.status(201).json(recordLocalDelivery(db, request.body ?? {}))
  })

  router.post('/pipelines/local/build', async (request, response) => {
    assertSessionOwnsWorkItem(request, request.body?.workItemId)
    const result = await triggerDeliveryBuild(
      db,
      vault,
      request.body ?? {},
      scopedOwnerId(request),
    )
    response.status(result.triggered ? 202 : 200).json(result)
  })

  router.post('/pipelines/:id/advance', (_request, _response) => {
    throw new AppError(
      409,
      'SERVER_PIPELINE_DISABLED',
      '服务端不能推进交付阶段；阶段结果必须来自本机真实执行证据',
    )
  })

  router.post('/pipelines/:id/cancel', (request, response) => {
    response.json(cancelPipeline(db, request.params.id, currentUser(request).id))
  })

  router.get('/reports', (request, response) => {
    response.json(listTestReports(db, currentUser(request).id))
  })

  router.get('/reports/:id', (request, response) => {
    response.json(getTestReport(db, request.params.id, currentUser(request).id))
  })

  router.get('/reports/:id/markdown', (request, response) => {
    const report = getTestReport(db, request.params.id, currentUser(request).id)
    response.type('text/markdown').send(reportAsMarkdown(report))
  })

  router.use((_request, _response, next) => {
    next(new AppError(404, 'ROUTE_NOT_FOUND', 'API 路由不存在'))
  })

  return router
}
