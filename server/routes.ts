import { Router } from 'express'
import type { AppDatabase } from './db/database.js'
import { AppError } from './domain/errors.js'
import type { CredentialVault } from './security/vault.js'
import { createAccount, importAccounts, listAccounts } from './services/accountService.js'
import { listFeishuInbox } from './services/inboxService.js'
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
    response.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() })
  })

  router.get('/bootstrap', (_request, response) => {
    response.json({
      repositories: listRepositories(db),
      accounts: listAccounts(db),
      workItems: listWorkItems(db),
      pipelines: listPipelines(db),
      reports: listTestReports(db),
      feishuInbox: listFeishuInbox(db),
    })
  })

  router.get('/repositories', (_request, response) => {
    response.json(listRepositories(db))
  })

  router.post('/repositories', (request, response) => {
    response.status(201).json(createRepository(db, request.body))
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
