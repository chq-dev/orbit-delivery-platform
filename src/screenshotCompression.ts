import {
  DELIVERY_SCREENSHOT_MIME_TYPES,
  MAX_DELIVERY_SCREENSHOT_BYTES,
  type DeliveryScreenshotMimeType,
  type DeliveryScreenshotUpload,
} from './deliveryContext'

const MAX_EDGE = 1_600
const MAX_VIDEO_INPUT_BYTES = 100 * 1024 * 1024
const MAX_VIDEO_FRAMES = 6

type DeliveryInputMimeType = DeliveryScreenshotMimeType | 'video/mp4'

function detectMimeType(file: File): DeliveryInputMimeType {
  if (DELIVERY_SCREENSHOT_MIME_TYPES.includes(file.type as DeliveryScreenshotMimeType)) {
    return file.type as DeliveryScreenshotMimeType
  }
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'gif') return 'image/gif'
  if (file.type === 'video/mp4' || extension === 'mp4' || extension === 'm4v') return 'video/mp4'
  throw new Error('仅支持 PNG、JPEG、WebP、GIF、APNG、动态 WebP 或 MP4 视频')
}

function containsAscii(bytes: ArrayBuffer, text: string): boolean {
  const source = new Uint8Array(bytes)
  const target = new TextEncoder().encode(text)
  outer: for (let index = 0; index <= source.length - target.length; index += 1) {
    for (let offset = 0; offset < target.length; offset += 1) {
      if (source[index + offset] !== target[offset]) continue outer
    }
    return true
  }
  return false
}

async function isAnimatedImage(
  file: File,
  mimeType: DeliveryScreenshotMimeType,
): Promise<boolean> {
  if (mimeType === 'image/gif') return true
  if (mimeType === 'image/webp') return containsAscii(await file.arrayBuffer(), 'ANMF')
  if (mimeType === 'image/png') return containsAscii(await file.arrayBuffer(), 'acTL')
  return false
}

function loadVideo(file: File): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    const timer = window.setTimeout(() => {
      URL.revokeObjectURL(url)
      reject(new Error('读取 MP4 视频超时，请检查视频是否损坏'))
    }, 20_000)
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true
    video.onloadeddata = () => {
      window.clearTimeout(timer)
      resolve(video)
    }
    video.onerror = () => {
      window.clearTimeout(timer)
      URL.revokeObjectURL(url)
      reject(new Error('无法解析 MP4 视频，请确认编码可被浏览器播放'))
    }
    video.src = url
  })
}

function seekVideo(video: HTMLVideoElement, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = Math.max(0, Math.min(seconds, Math.max(0, video.duration - 0.05)))
    if (Math.abs(video.currentTime - target) < 0.01 && video.readyState >= 2) {
      resolve()
      return
    }
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('MP4 视频跳帧超时'))
    }, 10_000)
    const onSeeked = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      reject(new Error('MP4 视频跳帧失败'))
    }
    const cleanup = (): void => {
      window.clearTimeout(timer)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
    }
    video.addEventListener('seeked', onSeeked, { once: true })
    video.addEventListener('error', onError, { once: true })
    video.currentTime = target
  })
}

function scaledCanvas(source: HTMLCanvasElement, ratio: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(source.width * ratio))
  canvas.height = Math.max(1, Math.round(source.height * ratio))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法压缩视频帧图')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

async function canvasJpegWithinLimit(
  source: HTMLCanvasElement,
  maxBytes: number,
): Promise<Blob> {
  let canvas = source
  let quality = 0.86
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const blob = await canvasBlob(canvas, quality)
    if (blob.size <= maxBytes) return blob
    if (quality > 0.58) quality -= 0.08
    else {
      canvas = scaledCanvas(canvas, 0.82)
      quality = 0.78
    }
  }
  throw new Error('视频帧图压缩后仍超过 500KB，请裁剪视频后重试')
}

async function prepareVideoScreenshot(file: File): Promise<DeliveryScreenshotUpload> {
  if (file.size > MAX_VIDEO_INPUT_BYTES) {
    throw new Error('MP4 视频不能超过 100MB')
  }
  const video = await loadVideo(file)
  const objectUrl = video.src
  try {
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    if (video.videoWidth <= 0 || video.videoHeight <= 0) {
      throw new Error('MP4 视频没有可读取的画面')
    }
    const frameCount = duration < 0.3 ? 1 : duration < 1 ? 3 : MAX_VIDEO_FRAMES
    const timestamps = Array.from({ length: frameCount }, (_, index) =>
      frameCount <= 1 ? 0 : (duration * index) / (frameCount - 1),
    )
    const scale = Math.min(
      1,
      640 / video.videoWidth,
      420 / video.videoHeight,
    )
    const tileWidth = Math.max(1, Math.round(video.videoWidth * scale))
    const tileHeight = Math.max(1, Math.round(video.videoHeight * scale))
    const columns = frameCount <= 1 ? 1 : frameCount <= 4 ? 2 : 3
    const rows = Math.ceil(frameCount / columns)
    const gap = 8
    const sheet = document.createElement('canvas')
    sheet.width = columns * tileWidth + (columns + 1) * gap
    sheet.height = rows * tileHeight + (rows + 1) * gap
    const context = sheet.getContext('2d')
    if (!context) throw new Error('浏览器无法创建视频帧图画布')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, sheet.width, sheet.height)

    for (let index = 0; index < timestamps.length; index += 1) {
      await seekVideo(video, timestamps[index] ?? 0)
      const column = index % columns
      const row = Math.floor(index / columns)
      const left = gap + column * (tileWidth + gap)
      const top = gap + row * (tileHeight + gap)
      context.drawImage(video, left, top, tileWidth, tileHeight)
      context.fillStyle = 'rgba(0, 0, 0, 0.65)'
      context.fillRect(left, top, 58, 20)
      context.fillStyle = '#ffffff'
      context.font = '12px sans-serif'
      context.fillText(`${(timestamps[index] ?? 0).toFixed(1)}s`, left + 6, top + 14)
    }

    const blob = await canvasJpegWithinLimit(sheet, MAX_DELIVERY_SCREENSHOT_BYTES)
    const base = file.name.replace(/\.[^.]+$/, '') || 'defect-video'
    return {
      name: `${base}-frames.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: blob.size,
      dataUrl: await readDataUrl(blob),
    }
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(objectUrl)
  }
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
  if (mimeType === 'video/mp4') return prepareVideoScreenshot(file)
  const animated = await isAnimatedImage(file, mimeType)
  const image = await loadImage(file)
  const maxEdge = Math.max(image.naturalWidth, image.naturalHeight)

  if (animated && file.size > MAX_DELIVERY_SCREENSHOT_BYTES) {
    throw new Error('GIF/APNG/动态 WebP 超过 500KB，请压缩动图或截取关键帧后再上传')
  }

  if (
    file.size <= MAX_DELIVERY_SCREENSHOT_BYTES &&
    (maxEdge <= MAX_EDGE || animated || mimeType === 'image/webp')
  ) {
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
