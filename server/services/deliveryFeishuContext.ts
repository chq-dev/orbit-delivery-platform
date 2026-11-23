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
const MAX_FEISHU_VIDEOS = 5
const MAX_FEISHU_VIDEO_BYTES = 200 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 45_000
const VIDEO_COMMAND_TIMEOUT_MS = 180_000

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
  videoPaths: string[]
  contextPath?: string
  warnings: string[]
}

interface FeishuTarget {
  projectKey: string
  typeKey: string
  workItemId: string
}

export type FeishuMediaKind = 'image' | 'video'

export interface FeishuMediaReference {
  url: string
  kind: FeishuMediaKind
}

interface DownloadedAttachment {
  path: string
  name?: string
  mimeType?: string
  kind: FeishuMediaKind
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

function normalizeFeishuMediaUrl(value: string | undefined): string | undefined {
  let url = (value ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/\\\//g, '/')
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/[),.;]+$/g, '')
  if (url.startsWith('//')) url = `https:${url}`
  return /^https?:\/\//i.test(url) ? url : undefined
}

function videoKindFromUrl(url: string): FeishuMediaKind | undefined {
  return /\.(?:mp4|mov|m4v|webm|avi|mkv)(?:$|[?#])/i.test(url) ? 'video' : undefined
}

export function extractFeishuMediaReferences(
  value: string | undefined,
): FeishuMediaReference[] {
  const content = (value ?? '').replace(/\\\//g, '/')
  const references = new Map<string, { kind: FeishuMediaKind; index: number }>()
  const add = (
    candidate: string | undefined,
    hint?: FeishuMediaKind,
    index = Number.MAX_SAFE_INTEGER,
  ): void => {
    const url = normalizeFeishuMediaUrl(candidate)
    if (!url || references.has(url)) return
    references.set(url, { kind: hint ?? videoKindFromUrl(url) ?? 'image', index })
  }
  const attributes = (tag: string): Map<string, string> => {
    const values = new Map<string, string>()
    for (const match of tag.matchAll(
      /\b(?:src|data-src|data-original|href|poster)\s*=\s*["']([^"']+)["']/gi,
    )) {
      values.set(match[0].split('=')[0].trim().toLowerCase(), match[1])
    }
    for (const match of tag.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
      values.set('srcset', match[1])
    }
    return values
  }

  for (const match of content.matchAll(
    /!\[[^\]]*\]\(\s*(?:<([^>]+)>|((?:https?:)?\/\/[^)\s]+))/gi,
  )) {
    add(match[1] ?? match[2], 'image', match.index)
  }
  for (const match of content.matchAll(
    /\[([^\]]*)\]\(\s*(?:<([^>]+)>|((?:https?:)?\/\/[^)\s]+))/gi,
  )) {
    if ((match.index ?? 0) > 0 && content[(match.index ?? 0) - 1] === '!') continue
    const url = match[2] ?? match[3]
    const label = match[1] ?? ''
    if (videoKindFromUrl(url ?? '') || /视频|录像|录屏|video|mp4/i.test(label)) {
      add(url, 'video', match.index)
    }
  }
  for (const block of content.matchAll(/<video\b[^>]*>[\s\S]*?<\/video>/gi)) {
    for (const attribute of block[0].matchAll(
      /\b(?:src|data-src)\s*=\s*["']([^"']+)["']/gi,
    )) {
      add(attribute[1], 'video', block.index)
    }
    for (const poster of block[0].matchAll(/\bposter\s*=\s*["']([^"']+)["']/gi)) {
      add(poster[1], 'image', block.index)
    }
  }
  for (const tagMatch of content.matchAll(/<(video|img|image|source|a)\b[^>]*>/gi)) {
    const tagName = (tagMatch[1] ?? '').toLowerCase()
    const values = attributes(tagMatch[0])
    if (tagName === 'video') {
      add(values.get('src') ?? values.get('data-src'), 'video', tagMatch.index)
      add(values.get('poster'), 'image', tagMatch.index)
    } else if (tagName === 'img' || tagName === 'image') {
      add(values.get('src') ?? values.get('data-src') ?? values.get('data-original'), 'image', tagMatch.index)
      for (const candidate of (values.get('srcset') ?? '').split(',')) {
        add(candidate.trim().split(/\s+/)[0], 'image', tagMatch.index)
      }
    } else if (tagName === 'source') {
      const source = values.get('src')
      add(source, videoKindFromUrl(source ?? ''), tagMatch.index)
      for (const candidate of (values.get('srcset') ?? '').split(',')) {
        const url = candidate.trim().split(/\s+/)[0]
        add(url, videoKindFromUrl(url ?? '') ?? 'image', tagMatch.index)
      }
    } else if (tagName === 'a') {
      const href = values.get('href')
      if (videoKindFromUrl(href ?? '')) add(href, 'video', tagMatch.index)
    }
  }
  for (const match of content.matchAll(
    /(?:https?:)?\/\/[^\s"'<>)]+\.(?:mp4|mov|m4v|webm)(?:[?#][^\s"'<>)]*)?/gi,
  )) {
    add(match[0], 'video', match.index)
  }
  return [...references]
    .sort((left, right) => left[1].index - right[1].index)
    .map(([url, value]) => ({ url, kind: value.kind }))
}

export function extractFeishuImageUrls(value: string | undefined): string[] {
  return extractFeishuMediaReferences(value)
    .filter((reference) => reference.kind === 'image')
    .map((reference) => reference.url)
}

function workItemDescription(payload: unknown): string {
  if (!isRecord(payload)) return ''
  const fields = payload.work_item_fields
  if (Array.isArray(fields)) {
    for (const field of fields) {
      if (!isRecord(field)) continue
      if (text(field.key) === 'description') {
        const value = field.value
        const nested = richText(value, 0)
        if (nested) return nested
      }
    }
  }
  return text(payload.description)
}

function richText(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (depth > 8 || value === null || value === undefined) return ''
  if (Array.isArray(value)) {
    return value
      .map((entry) => richText(entry, depth + 1))
      .filter(Boolean)
      .join('\n')
  }
  if (!isRecord(value)) return ''
  for (const key of ['text', 'content', 'markdown', 'body', 'comment', 'value']) {
    const nested = richText(value[key], depth + 1)
    if (nested) return nested
  }
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function commentText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!isRecord(value)) return ''
  const direct = richText(value.content ?? value.text ?? value.body ?? value.comment, 0)
  if (direct) return direct
  return richText(value, 0)
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

function attachmentExtension(
  mimeType: string,
  url: string,
  existingPath: string,
  kind: FeishuMediaKind,
): string {
  const mimeExtensions: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
  }
  const byMime = mimeExtensions[mimeType.toLowerCase()]
  if (byMime) return byMime
  const allowed = kind === 'video'
    ? ['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']
    : ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']
  try {
    const existing = extname(new URL(url).pathname).toLowerCase()
    if (allowed.includes(existing)) return existing
  } catch {
    // Fall through to the temporary file extension.
  }
  const temporary = extname(existingPath).toLowerCase()
  return allowed.includes(temporary) ? temporary : kind === 'video' ? '.mp4' : '.img'
}

async function downloadFeishuAttachment(
  url: string,
  index: number,
  kind: FeishuMediaKind,
  target: FeishuTarget,
  artifactDir: string,
): Promise<DownloadedAttachment> {
  const assetDir = join(artifactDir, 'requirement-assets')
  mkdirSync(assetDir, { recursive: true })
  const temporaryPath = join(assetDir, `.feishu-${kind}-${index + 1}.download`)
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
      timeout: kind === 'video' ? VIDEO_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    },
  )
  const payload = parseJsonOutput(String(result.stdout ?? ''))
  const record = isRecord(payload) ? payload : {}
  const mimeType = text(record.mime_type)
  const detectedKind = mimeType.startsWith('video/') ? 'video' : kind
  const finalPath = join(
    assetDir,
    `feishu-${detectedKind}-${index + 1}${attachmentExtension(mimeType, url, temporaryPath, detectedKind)}`,
  )
  if (!existsSync(temporaryPath)) throw new Error(`Meegle 未生成${kind === 'video' ? '视频' : '图片'}文件`)
  const size = statSync(temporaryPath).size
  const maxBytes = detectedKind === 'video' ? MAX_FEISHU_VIDEO_BYTES : MAX_FEISHU_IMAGE_BYTES
  if (size <= 0 || size > maxBytes) {
    unlinkSync(temporaryPath)
    throw new Error(`${kind === 'video' ? '视频' : '图片'}大小超出限制：${size} 字节`)
  }
  renameSync(temporaryPath, finalPath)
  return {
    path: finalPath,
    name: text(record.name) || undefined,
    mimeType: mimeType || undefined,
    kind: detectedKind,
  }
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
  const references = extractFeishuMediaReferences(
    `${comments}\n${description}\n${input.description ?? ''}`,
  )
  const imageUrls = references
    .filter((reference) => reference.kind === 'image')
    .slice(0, MAX_FEISHU_IMAGES)
    .map((reference) => reference.url)
  const videoUrls = references
    .filter((reference) => reference.kind === 'video')
    .slice(0, MAX_FEISHU_VIDEOS)
    .map((reference) => reference.url)
  const imagePaths: string[] = []
  const videoPaths: string[] = []
  if (target) {
    for (let index = 0; index < imageUrls.length; index += 1) {
      try {
        const attachment = await downloadFeishuAttachment(
          imageUrls[index],
          index,
          'image',
          target,
          input.artifactDir,
        )
        if (attachment.kind === 'video') videoPaths.push(attachment.path)
        else imagePaths.push(attachment.path)
      } catch (error) {
        warnings.push(
          `下载飞书缺陷图片 ${index + 1} 失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    for (let index = 0; index < videoUrls.length; index += 1) {
      try {
        const attachment = await downloadFeishuAttachment(
          videoUrls[index],
          index,
          'video',
          target,
          input.artifactDir,
        )
        if (attachment.kind === 'video') videoPaths.push(attachment.path)
        else imagePaths.push(attachment.path)
      } catch (error) {
        warnings.push(
          `下载飞书缺陷视频 ${index + 1} 失败：${error instanceof Error ? error.message : String(error)}`,
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
    `- 图片下载：${imagePaths.length}/${imageUrls.length}`,
    `- 视频下载：${videoPaths.length}/${videoUrls.length}`,
    '',
    '## 描述',
    description || '（未取得描述）',
    '',
    ...(comments ? ['## 评论', comments, ''] : []),
    ...(imageUrls.length > 0 ? ['## 图片链接', ...imageUrls.map((url) => `- ${url}`), ''] : []),
    ...(imagePaths.length > 0
      ? ['## 本地图片文件', ...imagePaths.map((path) => `- ${path}`), '']
      : []),
    ...(videoUrls.length > 0 ? ['## 视频链接', ...videoUrls.map((url) => `- ${url}`), ''] : []),
    ...(videoPaths.length > 0
      ? ['## 本地视频文件', ...videoPaths.map((path) => `- ${path}`), '']
      : []),
    ...(warnings.length > 0 ? ['## 读取警告', ...warnings.map((item) => `- ${item}`), ''] : []),
  ].join('\n')
  mkdirSync(input.artifactDir, { recursive: true })
  writeFileSync(contextPath, `${content}\n`, 'utf8')

  return {
    description: description || undefined,
    commentsMarkdown: comments || undefined,
    imagePaths,
    videoPaths,
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
