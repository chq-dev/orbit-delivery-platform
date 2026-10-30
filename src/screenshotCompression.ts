import {
  DELIVERY_SCREENSHOT_MIME_TYPES,
  MAX_DELIVERY_SCREENSHOT_BYTES,
  type DeliveryScreenshotMimeType,
  type DeliveryScreenshotUpload,
} from './deliveryContext'

const MAX_EDGE = 1_600

function detectMimeType(file: File): DeliveryScreenshotMimeType {
  if (DELIVERY_SCREENSHOT_MIME_TYPES.includes(file.type as DeliveryScreenshotMimeType)) {
    return file.type as DeliveryScreenshotMimeType
  }
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  throw new Error('截图仅支持 PNG、JPEG 或 WebP 图片')
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('读取截图失败'))
    reader.onerror = () => reject(new Error('读取截图失败'))
    reader.readAsDataURL(blob)
  })
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法解析截图图片'))
    }
    image.src = url
  })
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('压缩截图失败'))),
      'image/jpeg',
      quality,
    )
  })
}

function compressedName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'design-screenshot'
  return `${base}.jpg`
}

export async function prepareScreenshot(file: File): Promise<DeliveryScreenshotUpload> {
  const mimeType = detectMimeType(file)
  const image = await loadImage(file)
  const maxEdge = Math.max(image.naturalWidth, image.naturalHeight)

  if (file.size <= MAX_DELIVERY_SCREENSHOT_BYTES && maxEdge <= MAX_EDGE) {
    return {
      name: file.name || 'design-screenshot',
      mimeType,
      sizeBytes: file.size,
      dataUrl: await readDataUrl(file.type ? file : new Blob([file], { type: mimeType })),
    }
  }

  let edge = MAX_EDGE
  let quality = 0.86
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const ratio = Math.min(1, edge / maxEdge)
    const width = Math.max(1, Math.round(image.naturalWidth * ratio))
    const height = Math.max(1, Math.round(image.naturalHeight * ratio))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法压缩截图')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(image, 0, 0, width, height)
    const blob = await canvasBlob(canvas, quality)
    if (blob.size <= MAX_DELIVERY_SCREENSHOT_BYTES) {
      return {
        name: compressedName(file.name),
        mimeType: 'image/jpeg',
        sizeBytes: blob.size,
        dataUrl: await readDataUrl(blob),
      }
    }
    if (quality > 0.58) quality -= 0.08
    else edge = Math.max(480, Math.round(edge * 0.82))
  }

  throw new Error('截图压缩后仍超过 500KB，请裁剪后再上传')
}
