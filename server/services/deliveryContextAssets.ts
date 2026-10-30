import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DELIVERY_SCREENSHOT_MIME_TYPES,
  MAX_DELIVERY_SCREENSHOT_BYTES,
  type DeliveryScreenshotMimeType,
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

export function materializeDeliveryScreenshots(
  artifactDir: string,
  screenshots: WorkItemScreenshot[],
): string[] {
  if (screenshots.length === 0) return []
  const screenshotDir = join(artifactDir, 'requirement-assets')
  mkdirSync(screenshotDir, { recursive: true })
  const usedNames = new Set<string>()

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

    let name = safeFileName(screenshot.name, index, mimeType)
    if (usedNames.has(name)) name = `${index + 1}-${name}`
    usedNames.add(name)
    const filePath = join(screenshotDir, name)
    writeFileSync(filePath, bytes)
    return filePath
  })
}
