export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details?: unknown

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

export function notFound(resource: string): AppError {
  return new AppError(404, 'NOT_FOUND', `${resource}不存在`)
}

export function conflict(message: string, details?: unknown): AppError {
  return new AppError(409, 'CONFLICT', message, details)
}

export function unprocessable(message: string, details?: unknown): AppError {
  return new AppError(422, 'VALIDATION_ERROR', message, details)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}
