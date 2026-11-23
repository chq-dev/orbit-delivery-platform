import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import parseAPNG from 'apng-js'
import { decompressFrames, parseGIF, type ParsedFrame } from 'gifuct-js'
import UPNG from 'upng-js'
import { decodeAnimation } from 'wasm-webp/dist/esm/index.js'

const MAX_ANIMATED_FRAMES = 6
const MAX_DECODED_FRAMES = 300
const MAX_ANIMATION_PIXELS = 24_000_000
const MAX_TILE_WIDTH = 640
const MAX_TILE_HEIGHT = 420
const SHEET_GAP = 8
const MAX_ADAPTED_IMAGE_BYTES = 15 * 1024 * 1024

type ImageFormat = 'gif' | 'apng' | 'png' | 'webp' | 'jpeg' | 'unknown'
type ImageKind = 'static' | 'animated'

interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

interface DecodedAnimationFrame {
  image: RgbaImage
  delayMs: number
}

interface DecodedAnimation {
  frames: DecodedAnimationFrame[]
  width: number
  height: number
  format: ImageFormat
}

export interface SampledAnimationFrame {
  index: number
  delayMs: number
  atMs: number
}

export interface AdaptedCodexImage {
  sourcePath: string
  paths: string[]
  format: ImageFormat
  kind: ImageKind
  frameCount: number
  sampledFrames: SampledAnimationFrame[]
  warnings: string[]
}

export interface AdaptCodexImagesResult {
  imagePaths: string[]
  adaptations: AdaptedCodexImage[]
  warnings: string[]
}

export interface AdaptCodexImagesOptions {
  prefix?: string
  failOnError?: boolean
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer
}

function hasAscii(buffer: Buffer, value: string): boolean {
  return buffer.indexOf(Buffer.from(value, 'ascii')) >= 0
}

export function detectImageFormat(buffer: Buffer, path: string): ImageFormat {
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString('ascii')
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'gif'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp'
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return hasAscii(buffer, 'acTL') ? 'apng' : 'png'
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg'
  const extension = extname(path).toLowerCase()
  if (extension === '.gif') return 'gif'
  if (extension === '.png') return 'png'
  if (extension === '.webp') return 'webp'
  if (extension === '.jpg' || extension === '.jpeg') return 'jpeg'
  return 'unknown'
}

function assertAnimationLimits(width: number, height: number, frameCount: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_ANIMATION_PIXELS
  ) {
    throw new Error(`动图尺寸过大：${width}x${height}`)
  }
  if (frameCount > MAX_DECODED_FRAMES) {
    throw new Error(`动图帧数过多：${frameCount} 帧（最多 ${MAX_DECODED_FRAMES} 帧）`)
  }
}

function clearRect(
  image: RgbaImage,
  rect: { left: number; top: number; width: number; height: number },
): void {
  const left = Math.max(0, rect.left)
  const top = Math.max(0, rect.top)
  const right = Math.min(image.width, rect.left + rect.width)
  const bottom = Math.min(image.height, rect.top + rect.height)
  for (let y = top; y < bottom; y += 1) {
    const offset = (y * image.width + left) * 4
    image.data.fill(0, offset, (y * image.width + right) * 4)
  }
}

function drawRgbaPatch(
  target: RgbaImage,
  patch: RgbaImage,
  left: number,
  top: number,
  blendMode: 'over' | 'source',
): void {
  const startX = Math.max(0, left)
  const startY = Math.max(0, top)
  const endX = Math.min(target.width, left + patch.width)
  const endY = Math.min(target.height, top + patch.height)
  for (let y = startY; y < endY; y += 1) {
    const sourceY = y - top
    for (let x = startX; x < endX; x += 1) {
      const sourceX = x - left
      const sourceIndex = (sourceY * patch.width + sourceX) * 4
      const targetIndex = (y * target.width + x) * 4
      const sourceAlpha = patch.data[sourceIndex + 3] ?? 0
      if (blendMode === 'source') {
        target.data[targetIndex] = patch.data[sourceIndex]
        target.data[targetIndex + 1] = patch.data[sourceIndex + 1]
        target.data[targetIndex + 2] = patch.data[sourceIndex + 2]
        target.data[targetIndex + 3] = sourceAlpha
        continue
      }
      if (sourceAlpha === 0) continue
      if (sourceAlpha === 255) {
        target.data[targetIndex] = patch.data[sourceIndex]
        target.data[targetIndex + 1] = patch.data[sourceIndex + 1]
        target.data[targetIndex + 2] = patch.data[sourceIndex + 2]
        target.data[targetIndex + 3] = 255
        continue
      }
      const inverse = 255 - sourceAlpha
      const targetAlpha = target.data[targetIndex + 3] ?? 0
      const alpha = sourceAlpha + Math.round((targetAlpha * inverse) / 255)
      target.data[targetIndex] = Math.round(
        (patch.data[sourceIndex] * sourceAlpha +
          target.data[targetIndex] * targetAlpha * inverse / 255) /
          Math.max(1, alpha),
      )
      target.data[targetIndex + 1] = Math.round(
        (patch.data[sourceIndex + 1] * sourceAlpha +
          target.data[targetIndex + 1] * targetAlpha * inverse / 255) /
          Math.max(1, alpha),
      )
      target.data[targetIndex + 2] = Math.round(
        (patch.data[sourceIndex + 2] * sourceAlpha +
          target.data[targetIndex + 2] * targetAlpha * inverse / 255) /
          Math.max(1, alpha),
      )
      target.data[targetIndex + 3] = alpha
    }
  }
}

function drawGifPatch(target: RgbaImage, frame: ParsedFrame): void {
  drawRgbaPatch(
    target,
    {
      width: frame.dims.width,
      height: frame.dims.height,
      data: frame.patch,
    },
    frame.dims.left,
    frame.dims.top,
    'over',
  )
}

function decodeGif(buffer: Buffer): DecodedAnimation {
  const parsed = parseGIF(toArrayBuffer(buffer))
  assertAnimationLimits(parsed.lsd.width, parsed.lsd.height, parsed.frames.length)
  const sourceFrames = decompressFrames(parsed, true)
  assertAnimationLimits(parsed.lsd.width, parsed.lsd.height, sourceFrames.length)
  const canvas: RgbaImage = {
    width: parsed.lsd.width,
    height: parsed.lsd.height,
    data: new Uint8ClampedArray(parsed.lsd.width * parsed.lsd.height * 4),
  }
  const frames: DecodedAnimationFrame[] = []
  let previousDisposal = 0
  let previousFrame: ParsedFrame | undefined
  let restoreCanvas: Uint8ClampedArray | undefined

  for (const frame of sourceFrames) {
    if (previousDisposal === 2 && previousFrame) clearRect(canvas, previousFrame.dims)
    if (previousDisposal === 3 && restoreCanvas) canvas.data.set(restoreCanvas)
    restoreCanvas = frame.disposalType === 3 ? canvas.data.slice() : undefined
    drawGifPatch(canvas, frame)
    frames.push({
      image: { width: canvas.width, height: canvas.height, data: canvas.data.slice() },
      delayMs: frame.delay > 0 ? frame.delay : 100,
    })
    previousDisposal = frame.disposalType
    previousFrame = frame
  }

  return {
    frames,
    width: parsed.lsd.width,
    height: parsed.lsd.height,
    format: 'gif',
  }
}

async function decodeApng(buffer: Buffer): Promise<DecodedAnimation> {
  const parser =
    typeof parseAPNG === 'function'
      ? parseAPNG
      : (parseAPNG as unknown as { default: typeof parseAPNG }).default
  const parsed = parser(toArrayBuffer(buffer))
  if (parsed instanceof Error) throw parsed
  assertAnimationLimits(parsed.width, parsed.height, parsed.frames.length)
  const canvas: RgbaImage = {
    width: parsed.width,
    height: parsed.height,
    data: new Uint8ClampedArray(parsed.width * parsed.height * 4),
  }
  const frames: DecodedAnimationFrame[] = []
  let previousDispose = 0
  let previousFrame: { left: number; top: number; width: number; height: number } | undefined
  let restoreCanvas: Uint8ClampedArray | undefined

  for (const frame of parsed.frames) {
    if (previousDispose === 1 && previousFrame) {
      clearRect(canvas, previousFrame)
    }
    if (previousDispose === 2 && restoreCanvas) canvas.data.set(restoreCanvas)
    restoreCanvas = frame.disposeOp === 2 ? canvas.data.slice() : undefined
    if (!frame.imageData) throw new Error('APNG 帧数据缺失')
    const frameBytes = Buffer.from(await frame.imageData.arrayBuffer())
    const iend = Buffer.from('0000000049454e44ae426082', 'hex')
    const completeFramePng = frameBytes.subarray(-iend.length).equals(iend)
      ? frameBytes
      : Buffer.concat([frameBytes, iend])
    const framePng = UPNG.decode(toArrayBuffer(completeFramePng))
    const frameBuffer = UPNG.toRGBA8(framePng)[0]
    if (!frameBuffer) throw new Error('APNG 帧解码失败')
    drawRgbaPatch(
      canvas,
      {
        width: frame.width,
        height: frame.height,
        data: new Uint8ClampedArray(frameBuffer),
      },
      frame.left,
      frame.top,
      frame.blendOp === 0 ? 'source' : 'over',
    )
    frames.push({
      image: { width: canvas.width, height: canvas.height, data: canvas.data.slice() },
      delayMs: Math.max(1, frame.delay || 100),
    })
    previousDispose = frame.disposeOp
    previousFrame = {
      left: frame.left,
      top: frame.top,
      width: frame.width,
      height: frame.height,
    }
  }

  return {
    width: parsed.width,
    height: parsed.height,
    format: 'apng',
    frames,
  }
}

async function decodeWebp(buffer: Buffer): Promise<DecodedAnimation> {
  const decoded = await decodeAnimation(new Uint8Array(buffer), true)
  if (!decoded || decoded.length === 0) throw new Error('WebP 动图解码失败')
  const width = decoded[0]?.width ?? 0
  const height = decoded[0]?.height ?? 0
  assertAnimationLimits(width, height, decoded.length)
  return {
    width,
    height,
    format: 'webp',
    frames: decoded.map((frame) => {
      if (frame.width !== width || frame.height !== height) {
        throw new Error('WebP 动图帧尺寸不一致，暂不支持适配')
      }
      return {
        image: {
          width: frame.width,
          height: frame.height,
          data: new Uint8ClampedArray(frame.data),
        },
        delayMs: Math.max(1, frame.duration || 100),
      }
    }),
  }
}

function mixChannel(left: number, right: number, ratio: number): number {
  return Math.round(left + (right - left) * ratio)
}

function resizeAndFlatten(source: RgbaImage, width: number, height: number): RgbaImage {
  const resized: RgbaImage = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  }
  for (let y = 0; y < height; y += 1) {
    const sourceY = height <= 1 ? 0 : (y * (source.height - 1)) / (height - 1)
    const top = Math.floor(sourceY)
    const bottom = Math.min(source.height - 1, top + 1)
    const yRatio = sourceY - top
    for (let x = 0; x < width; x += 1) {
      const sourceX = width <= 1 ? 0 : (x * (source.width - 1)) / (width - 1)
      const left = Math.floor(sourceX)
      const right = Math.min(source.width - 1, left + 1)
      const xRatio = sourceX - left
      const topLeft = (top * source.width + left) * 4
      const topRight = (top * source.width + right) * 4
      const bottomLeft = (bottom * source.width + left) * 4
      const bottomRight = (bottom * source.width + right) * 4
      const alpha =
        mixChannel(
          mixChannel(source.data[topLeft + 3] ?? 0, source.data[topRight + 3] ?? 0, xRatio),
          mixChannel(
            source.data[bottomLeft + 3] ?? 0,
            source.data[bottomRight + 3] ?? 0,
            xRatio,
          ),
          yRatio,
        ) / 255
      const targetIndex = (y * width + x) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        const value = mixChannel(
          mixChannel(
            source.data[topLeft + channel] ?? 0,
            source.data[topRight + channel] ?? 0,
            xRatio,
          ),
          mixChannel(
            source.data[bottomLeft + channel] ?? 0,
            source.data[bottomRight + channel] ?? 0,
            xRatio,
          ),
          yRatio,
        )
        resized.data[targetIndex + channel] = Math.round(value * alpha + 255 * (1 - alpha))
      }
      resized.data[targetIndex + 3] = 255
    }
  }
  return resized
}

function sampleFrameIndexes(frameCount: number): number[] {
  if (frameCount <= MAX_ANIMATED_FRAMES) {
    return Array.from({ length: frameCount }, (_, index) => index)
  }
  const indexes = new Set<number>()
  for (let index = 0; index < MAX_ANIMATED_FRAMES; index += 1) {
    indexes.add(Math.round((index * (frameCount - 1)) / (MAX_ANIMATED_FRAMES - 1)))
  }
  return [...indexes]
}

function contactSheetColumns(frameCount: number): number {
  if (frameCount <= 1) return 1
  if (frameCount <= 4) return 2
  return 3
}

function buildSheet(animation: DecodedAnimation): {
  image: RgbaImage
  sampled: SampledAnimationFrame[]
} {
  const indexes = sampleFrameIndexes(animation.frames.length)
  const columns = contactSheetColumns(indexes.length)
  const rows = Math.ceil(indexes.length / columns)
  const scale = Math.min(
    1,
    MAX_TILE_WIDTH / animation.width,
    MAX_TILE_HEIGHT / animation.height,
  )
  const tileWidth = Math.max(1, Math.round(animation.width * scale))
  const tileHeight = Math.max(1, Math.round(animation.height * scale))
  const sheet: RgbaImage = {
    width: columns * tileWidth + (columns + 1) * SHEET_GAP,
    height: rows * tileHeight + (rows + 1) * SHEET_GAP,
    data: new Uint8ClampedArray(
      (columns * tileWidth + (columns + 1) * SHEET_GAP) *
        (rows * tileHeight + (rows + 1) * SHEET_GAP) *
        4,
    ),
  }
  sheet.data.fill(255)

  let atMs = 0
  const sampled: SampledAnimationFrame[] = []
  const selected = new Set(indexes)
  for (let index = 0; index < animation.frames.length; index += 1) {
    const frame = animation.frames[index]
    if (selected.has(index)) {
      const position = sampled.length
      const column = position % columns
      const row = Math.floor(position / columns)
      const tile = resizeAndFlatten(frame.image, tileWidth, tileHeight)
      const left = SHEET_GAP + column * (tileWidth + SHEET_GAP)
      const top = SHEET_GAP + row * (tileHeight + SHEET_GAP)
      for (let y = 0; y < tileHeight; y += 1) {
        const targetOffset = ((top + y) * sheet.width + left) * 4
        sheet.data.set(tile.data.subarray(y * tileWidth * 4, (y + 1) * tileWidth * 4), targetOffset)
      }
      sampled.push({ index, delayMs: frame.delayMs, atMs })
    }
    atMs += frame.delayMs
  }
  return { image: sheet, sampled }
}

function outputPath(artifactDir: string, prefix: string, index: number): string {
  const directory = join(artifactDir, 'codex-images')
  mkdirSync(directory, { recursive: true })
  const safePrefix = (prefix || 'image').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'image'
  return join(directory, `${safePrefix}-${String(index + 1).padStart(2, '0')}.png`)
}

function writePng(image: RgbaImage, path: string): void {
  const encoded = UPNG.encode(
    [image.data.buffer.slice(image.data.byteOffset, image.data.byteOffset + image.data.byteLength)],
    image.width,
    image.height,
    0,
  )
  const bytes = Buffer.from(encoded)
  if (bytes.length > MAX_ADAPTED_IMAGE_BYTES) {
    throw new Error(`适配后的图像超过 ${Math.floor(MAX_ADAPTED_IMAGE_BYTES / 1024 / 1024)}MB`)
  }
  writeFileSync(path, bytes)
}

export async function adaptImageForCodex(
  sourcePath: string,
  artifactDir: string,
  index: number,
  prefix = 'image',
): Promise<AdaptedCodexImage> {
  const buffer = readFileSync(sourcePath)
  const format = detectImageFormat(buffer, sourcePath)
  if (format === 'unknown') {
    throw new Error(`无法识别图片格式：${basename(sourcePath)}`)
  }
  if (format === 'png' || format === 'jpeg') {
    return {
      sourcePath,
      paths: [sourcePath],
      format,
      kind: 'static',
      frameCount: 1,
      sampledFrames: [],
      warnings: [],
    }
  }
  if (format === 'webp' && !hasAscii(buffer, 'ANMF')) {
    return {
      sourcePath,
      paths: [sourcePath],
      format,
      kind: 'static',
      frameCount: 1,
      sampledFrames: [],
      warnings: [],
    }
  }

  let animation: DecodedAnimation
  if (format === 'gif') animation = decodeGif(buffer)
  else if (format === 'apng') animation = await decodeApng(buffer)
  else animation = await decodeWebp(buffer)

  if (animation.frames.length <= 1) {
    const path = outputPath(artifactDir, prefix, index)
    writePng(animation.frames[0]?.image ?? { width: 1, height: 1, data: new Uint8ClampedArray(4) }, path)
    return {
      sourcePath,
      paths: [path],
      format,
      kind: 'static',
      frameCount: Math.max(1, animation.frames.length),
      sampledFrames: [],
      warnings: [],
    }
  }

  const { image, sampled } = buildSheet(animation)
  const path = outputPath(artifactDir, prefix, index)
  writePng(image, path)
  return {
    sourcePath,
    paths: [path],
    format,
    kind: 'animated',
    frameCount: animation.frames.length,
    sampledFrames: sampled,
    warnings: [],
  }
}

export async function adaptCodexImages(
  paths: string[],
  artifactDir: string,
  options: AdaptCodexImagesOptions = {},
): Promise<AdaptCodexImagesResult> {
  const adaptations: AdaptedCodexImage[] = []
  const warnings: string[] = []
  for (let index = 0; index < paths.length; index += 1) {
    try {
      adaptations.push(
        await adaptImageForCodex(paths[index], artifactDir, index, options.prefix),
      )
    } catch (error) {
      const message = `第 ${index + 1} 张图片无法用于 Codex：${
        error instanceof Error ? error.message : String(error)
      }`
      if (options.failOnError) throw new Error(message)
      warnings.push(message)
    }
  }
  return {
    imagePaths: adaptations.flatMap((adaptation) => adaptation.paths),
    adaptations,
    warnings,
  }
}
