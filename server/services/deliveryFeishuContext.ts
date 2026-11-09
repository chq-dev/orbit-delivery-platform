import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_FEISHU_IMAGES = 10
const MAX_FEISHU_IMAGE_BYTES = 15 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 45_000
const IMAGE_URL_PATTERN = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)|<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi

export interface DeliveryFeishuContextInput {
  artifactDir: string
  externalId?: string
  title: string
  description?: string
}

export interface DeliveryFeishuContext {
  description?: string
  commentsMarkdown?: string
  imagePaths: string[]
  contextPath?: string
  warnings: string[]
}

interface FeishuTarget {
  projectKey: string
  typeKey: string
  workItemId: string
}

interface DownloadedImage {
  path: string
  name?: string
  mimeType?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

export function parseFeishuExternalId(externalId: string | undefined): FeishuTarget | undefined {
  const parts = (externalId ?? '').split(':').filter(Boolean)
  if (parts.length < 3) return undefined
  const [projectKey, typeKey] = parts
  const workItemId = parts.slice(2).join(':')
  if (!projectKey || !typeKey || !/^\d+$/.test(workItemId)) return undefined
  return { projectKey, typeKey, workItemId }
}

export function extractFeishuImageUrls(value: string | undefined): string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  for (const match of (value ?? '').matchAll(IMAGE_URL_PATTERN)) {
    const url = (match[1] ?? match[2] ?? '').trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  return urls
}

function workItemDescription(payload: unknown): string {
  if (!isRecord(payload)) return ''
  const fields = payload.work_item_fields
  if (Array.isArray(fields)) {
    for (const field of fields) {
      if (!isRecord(field)) continue
      if (text(field.key) === 'description') {
        const value = field.value
        if (typeof value === 'string') return value.trim()
        const nested = isRecord(value) ? text(value.text ?? value.value ?? value.content) : ''
        if (nested) return nested
      }
    }
  }
  return text(payload.description)
}

function commentText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!isRecord(value)) return ''
  const direct = text(value.content ?? value.text ?? value.body ?? value.comment)
  if (direct) return direct
  const content = value.content
  if (isRecord(content)) {
    const rich = text(content.text ?? content.content ?? content.markdown)
    if (rich) return rich
  }
  return ''
}

function commentsMarkdown(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.comments)) return ''
  return payload.comments
    .map((comment, index) => {
      const body = commentText(comment)
      if (!body) return ''
      const record = isRecord(comment) ? comment : {}
      const author = text(
        record.author ?? record.creator ?? record.user_name ?? record.created_by_name,
      )
      return `### 评论 ${index + 1}${author ? ` · ${author}` : ''}\n${body}`
    })
    .filter(Boolean)
    .join('\n\n')
}

async function runMeegleJson(args: string[]): Promise<unknown> {
  const command = process.env.MEEGLE_BIN?.trim() || 'meegle'
  const result = await execFileAsync(command, args, {
    env: process.env,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  return parseJsonOutput(String(result.stdout ?? ''))
}

function imageExtension(mimeType: string, existingPath: string): string {
  if (mimeType === 'image/png') return '.png'
  if (mimeType === 'image/jpeg') return '.jpg'
  if (mimeType === 'image/webp') return '.webp'
  if (mimeType === 'image/gif') return '.gif'
  const existing = extname(existingPath).toLowerCase()
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(existing) ? existing : '.img'
}

async function downloadFeishuImage(
  url: string,
  index: number,
  target: FeishuTarget,
  artifactDir: string,
): Promise<DownloadedImage> {
  const assetDir = join(artifactDir, 'requirement-assets')
  mkdirSync(assetDir, { recursive: true })
  const temporaryPath = join(assetDir, `.feishu-image-${index + 1}.download`)
  const command = process.env.MEEGLE_BIN?.trim() || 'meegle'
  const result = await execFileAsync(
    command,
    [
      'attachment',
      '+download',
      url,
      '--project-key',
      target.projectKey,
      '--work-item-id',
      target.workItemId,
      '--output',
      temporaryPath,
      '--overwrite',
    ],
    {
      env: process.env,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    },
  )
  const payload = parseJsonOutput(String(result.stdout ?? ''))
  const record = isRecord(payload) ? payload : {}
  const mimeType = text(record.mime_type)
  const finalPath = join(assetDir, `feishu-image-${index + 1}${imageExtension(mimeType, temporaryPath)}`)
  if (!existsSync(temporaryPath)) throw new Error('Meegle 未生成截图文件')
  const size = statSync(temporaryPath).size
  if (size <= 0 || size > MAX_FEISHU_IMAGE_BYTES) {
    unlinkSync(temporaryPath)
    throw new Error(`截图大小超出限制：${size} 字节`)
  }
  renameSync(temporaryPath, finalPath)
  return { path: finalPath, name: text(record.name) || undefined, mimeType: mimeType || undefined }
}

export async function loadDeliveryFeishuContext(
  input: DeliveryFeishuContextInput,
): Promise<DeliveryFeishuContext> {
  const target = parseFeishuExternalId(input.externalId)
  const warnings: string[] = []
  let liveDescription = ''
  let comments = ''

  if (target) {
    try {
      const payload = await runMeegleJson([
        'workitem',
        'get',
        '--project-key',
        target.projectKey,
        '--work-item-id',
        target.workItemId,
        '--fields',
        JSON.stringify(['description', 'name']),
      ])
      liveDescription = workItemDescription(payload)
    } catch (error) {
      warnings.push(
        `读取飞书缺陷实时描述失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    try {
      const payload = await runMeegleJson([
        'comment',
        'list',
        '--project-key',
        target.projectKey,
        '--work-item-id',
        target.workItemId,
      ])
      comments = commentsMarkdown(payload)
    } catch (error) {
      warnings.push(
        `读取飞书缺陷评论失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  } else if (input.externalId) {
    warnings.push(`无法解析飞书工作项标识：${input.externalId}`)
  }

  const description = liveDescription || input.description?.trim() || ''
  const imageUrls = extractFeishuImageUrls(
    `${comments}\n${description}\n${input.description ?? ''}`,
  ).slice(
    0,
    MAX_FEISHU_IMAGES,
  )
  const imagePaths: string[] = []
  if (target && imageUrls.length > 0) {
    for (let index = 0; index < imageUrls.length; index += 1) {
      try {
        const image = await downloadFeishuImage(
          imageUrls[index],
          index,
          target,
          input.artifactDir,
        )
        imagePaths.push(image.path)
      } catch (error) {
        warnings.push(
          `下载飞书缺陷截图 ${index + 1} 失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  const contextPath = join(input.artifactDir, 'feishu-context.md')
  const content = [
    `# 飞书缺陷上下文 · ${input.title}`,
    '',
    `- 外部标识：${input.externalId ?? '未提供'}`,
    `- 实时描述读取：${liveDescription ? '成功' : '未取得'}`,
    `- 评论读取：${comments ? '成功' : '无评论或未取得'}`,
    `- 截图下载：${imagePaths.length}/${imageUrls.length}`,
    '',
    '## 描述',
    description || '（未取得描述）',
    '',
    ...(comments ? ['## 评论', comments, ''] : []),
    ...(imageUrls.length > 0 ? ['## 截图链接', ...imageUrls.map((url) => `- ${url}`), ''] : []),
    ...(imagePaths.length > 0
      ? ['## 本地截图文件', ...imagePaths.map((path) => `- ${path}`), '']
      : []),
    ...(warnings.length > 0 ? ['## 读取警告', ...warnings.map((item) => `- ${item}`), ''] : []),
  ].join('\n')
  mkdirSync(input.artifactDir, { recursive: true })
  writeFileSync(contextPath, `${content}\n`, 'utf8')

  return {
    description: description || undefined,
    commentsMarkdown: comments || undefined,
    imagePaths,
    contextPath,
    warnings,
  }
}

export function readDeliveryFeishuContext(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}
