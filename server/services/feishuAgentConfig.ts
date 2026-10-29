export interface FeishuAgentStoredConfig {
  platformBaseUrl: string
  syncToken: string
  projectKey: string
  repoId?: string
}

export interface FeishuAgentPublicConfig {
  configured: boolean
  platformBaseUrl?: string
  projectKey: string
  repoId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function parseFeishuAgentConfig(value: unknown): FeishuAgentStoredConfig | null {
  if (!isRecord(value)) return null
  const platformBaseUrl = text(value.platformBaseUrl).replace(/\/$/, '')
  const syncToken = text(value.syncToken)
  if (!platformBaseUrl || !syncToken) return null
  return {
    platformBaseUrl,
    syncToken,
    projectKey: text(value.projectKey) || 'rjcloud',
    repoId: text(value.repoId) || undefined,
  }
}

export function publicFeishuAgentConfig(
  config: FeishuAgentStoredConfig | null,
): FeishuAgentPublicConfig {
  if (!config) return { configured: false, projectKey: 'rjcloud' }
  return {
    configured: true,
    platformBaseUrl: config.platformBaseUrl,
    projectKey: config.projectKey,
    repoId: config.repoId,
  }
}

export function validateFeishuAgentConfig(input: unknown): FeishuAgentStoredConfig {
  if (!isRecord(input)) throw new Error('请求体必须是 JSON 对象')
  const platformBaseUrl = text(input.platformBaseUrl).replace(/\/$/, '')
  const syncToken = text(input.syncToken)
  const projectKey = text(input.projectKey) || 'rjcloud'
  const repoId = text(input.repoId)
  let url: URL
  try {
    url = new URL(platformBaseUrl)
  } catch {
    throw new Error('平台地址不是合法 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('平台地址必须使用 http 或 https')
  }
  if (syncToken.length < 16) throw new Error('平台同步密钥长度不足')
  if (!/^[A-Za-z0-9_]+$/.test(projectKey)) throw new Error('项目标识格式不正确')
  return { platformBaseUrl, syncToken, projectKey, repoId: repoId || undefined }
}
