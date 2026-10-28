import express, { type ErrorRequestHandler } from 'express'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AppDatabase } from './db/database.js'
import { AppError } from './domain/errors.js'
import { createApiRouter } from './routes.js'
import type { CredentialVault } from './security/vault.js'

export function createApp(db: AppDatabase, vault: CredentialVault) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))
  app.use('/api', createApiRouter(db, vault))

  const webRoot = resolve(process.cwd(), 'dist')
  if (existsSync(resolve(webRoot, 'index.html'))) {
    app.use(express.static(webRoot, { index: false, maxAge: '1h' }))
    app.use((request, response, next) => {
      if (request.method !== 'GET') return next()
      response.sendFile(resolve(webRoot, 'index.html'))
    })
  }

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({
        error: { code: error.code, message: error.message, details: error.details },
      })
      return
    }
    if (error instanceof SyntaxError && 'body' in error) {
      response.status(400).json({
        error: { code: 'INVALID_JSON', message: '请求体不是合法的 JSON' },
      })
      return
    }
    const sqliteCode = (error as { code?: string }).code
    if (sqliteCode?.startsWith('SQLITE_CONSTRAINT')) {
      response.status(409).json({
        error: { code: 'CONSTRAINT_VIOLATION', message: '数据约束冲突，请检查唯一字段或关联关系' },
      })
      return
    }
    console.error(error)
    response.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: '服务内部错误' },
    })
  }
  app.use(errorHandler)

  return app
}
