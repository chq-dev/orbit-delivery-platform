import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DELIVERY_SCREENSHOT_MIME_TYPES,
  MAX_DELIVERY_SCREENSHOTS,
  MAX_DELIVERY_SCREENSHOTS_TOTAL_BYTES,
  MAX_DELIVERY_SCREENSHOT_BYTES,
  isDeliveryScreenshotMimeType,
  type DeliveryScreenshotMimeType,
  type DeliveryScreenshotUpload,
} from '../../src/deliveryContext.js'
import type { WorkItemScreenshot } from '../../src/types.js'

const EXTENSIONS: Record<DeliveryScreenshotMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

function safeFileName(name: string, index: number, mimeType: DeliveryScreenshotMimeType): string {
  const fallback = `design-screenshot-${index + 1}.${EXTENSIONS[mimeType]}`
  return (name.trim() || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[._]+/, '_')
    .slice(0, 120)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

export function parseDeliveryScreenshots(value: unknown): DeliveryScreenshotUpload[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('设计截图必须是数组')
  if (value.length > MAX_DELIVERY_SCREENSHOTS) {
    throw new Error(`设计截图最多上传 ${MAX_DELIVERY_SCREENSHOTS} 张`)
  }

  let totalBytes = 0
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`第 ${index + 1} 张设计截图格式不正确`)
    const mimeType = typeof entry.mimeType === 'string' ? entry.mimeType.trim() : ''
    if (!isDeliveryScreenshotMimeType(mimeType)) {
      throw new Error('设计截图仅支持 PNG、JPEG 或 WebP')
    }
    const dataUrl = typeof entry.dataUrl === 'string' ? entry.dataUrl.trim() : ''
    const prefix = `data:${mimeType};base64,`
    if (!dataUrl.startsWith(prefix)) throw new Error('设计截图内容格式不正确')
    const dataBase64 = dataUrl.slice(prefix.length)
    if (
      !dataBase64 ||
      dataBase64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)
    ) {
      throw new Error('设计截图不是合法的 Base64 图片')
    }
    const sizeBytes = base64ByteLength(dataBase64)
    if (sizeBytes <= 0) throw new Error('设计截图内容为空')
    if (sizeBytes > MAX_DELIVERY_SCREENSHOT_BYTES) {
      throw new Error(
        `第 ${index + 1} 张设计截图超过 ${Math.floor(MAX_DELIVERY_SCREENSHOT_BYTES / 1024)}KB，请压缩后重试`,
      )
    }
    totalBytes += sizeBytes
    if (totalBytes > MAX_DELIVERY_SCREENSHOTS_TOTAL_BYTES) {
      throw new Error(
        `设计截图合计不能超过 ${Math.floor(MAX_DELIVERY_SCREENSHOTS_TOTAL_BYTES / 1024)}KB`,
      )
    }
    return {
      name: typeof entry.name === 'string' ? entry.name : `design-screenshot-${index + 1}`,
      mimeType,
      sizeBytes,
      dataUrl,
    }
  })
}

export function materializeDeliveryScreenshots(
  artifactDir: string,
  screenshots: WorkItemScreenshot[],
): string[] {
  if (screenshots.length === 0) return []
  if (screenshots.length > MAX_DELIVERY_SCREENSHOTS) {
    throw new Error(`设计截图最多上传 ${MAX_DELIVERY_SCREENSHOTS} 张`)
  }
  const screenshotDir = join(artifactDir, 'requirement-assets')
  mkdirSync(screenshotDir, { recursive: true })
  const usedNames = new Set<string>()
  let totalBytes = 0

  return screenshots.map((screenshot, index) => {
    if (!DELIVERY_SCREENSHOT_MIME_TYPES.includes(screenshot.mimeType as DeliveryScreenshotMimeType)) {
      throw new Error(`第 ${index + 1} 张需求截图类型不受支持：${screenshot.mimeType}`)
    }
    const mimeType = screenshot.mimeType as DeliveryScreenshotMimeType
    const prefix = `data:${mimeType};base64,`
    if (!screenshot.dataUrl.startsWith(prefix)) {
      throw new Error(`第 ${index + 1} 张需求截图内容格式不正确`)
    }
    const bytes = Buffer.from(screenshot.dataUrl.slice(prefix.length), 'base64')
    if (bytes.length === 0 || bytes.length > MAX_DELIVERY_SCREENSHOT_BYTES) {
      throw new Error(`第 ${index + 1} 张需求截图大小超出限制`)
    }
    totalBytes += bytes.length
    if (totalBytes > MAX_DELIVERY_SCREENSHOTS_TOTAL_BYTES) {
      throw new Error(
        `设计截图合计不能超过 ${Math.floor(MAX_DELIVERY_SCREENSHOTS_TOTAL_BYTES / 1024)}KB`,
      )
    }

    let name = safeFileName(screenshot.name, index, mimeType)
    if (usedNames.has(name)) name = `${index + 1}-${name}`
    usedNames.add(name)
    const filePath = join(screenshotDir, name)
    writeFileSync(filePath, bytes)
    return filePath
  })
}
