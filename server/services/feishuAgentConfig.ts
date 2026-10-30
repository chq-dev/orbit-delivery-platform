import { isAbsolute } from 'node:path'

export interface FeishuAgentStoredConfig {
  platformBaseUrl: string
  syncToken: string
  projectKey: string
  repoId?: string
  repoPaths: Record<string, string>
}

export interface FeishuAgentPublicConfig {
  configured: boolean
  platformBaseUrl?: string
  projectKey: string
  repoId?: string
  repoPaths: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function repoId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
}

export function parseFeishuAgentRepoPaths(
  value: unknown,
  strict = false,
): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    if (strict) throw new Error('客户端仓库路径映射必须是 JSON 对象')
    return {}
  }
  const paths: Record<string, string> = {}
  for (const [key, rawPath] of Object.entries(value)) {
    const repositoryId = key.trim()
    const localPath = text(rawPath)
    if (!repoId(repositoryId) || !localPath || !isAbsolute(localPath)) {
      if (strict) {
        throw new Error(`仓库 ${repositoryId || '(空)'} 的客户端路径必须是绝对路径`)
      }
      continue
    }
    paths[repositoryId] = localPath
  }
  return paths
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
    repoPaths: parseFeishuAgentRepoPaths(value.repoPaths),
  }
}

export function publicFeishuAgentConfig(
  config: FeishuAgentStoredConfig | null,
): FeishuAgentPublicConfig {
  if (!config) return { configured: false, projectKey: 'rjcloud', repoPaths: {} }
  return {
    configured: true,
    platformBaseUrl: config.platformBaseUrl,
    projectKey: config.projectKey,
    repoId: config.repoId,
    repoPaths: { ...config.repoPaths },
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
  return {
    platformBaseUrl,
    syncToken,
    projectKey,
    repoId: repoId || undefined,
    repoPaths: parseFeishuAgentRepoPaths(input.repoPaths, true),
  }
}
