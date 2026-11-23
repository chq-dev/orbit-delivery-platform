import { execFile } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_VIDEO_FRAMES = 6
const COMMAND_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 15 * 1024 * 1024

const SWIFT_EXTRACTOR = String.raw`
import AVFoundation
import AppKit
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

guard CommandLine.arguments.count >= 3 else {
  fail("usage: extract-video.swift <input> <output> [maxFrames]")
}
let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
let maxFrames = max(1, min(Int(CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "6") ?? 6, 12))
let asset = AVURLAsset(url: inputURL)
let durationSeconds = CMTimeGetSeconds(asset.duration)
guard durationSeconds.isFinite && durationSeconds > 0 else { fail("无法读取视频时长") }
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.maximumSize = CGSize(width: 1280, height: 720)
generator.requestedTimeToleranceBefore = CMTime(seconds: 0.15, preferredTimescale: 600)
generator.requestedTimeToleranceAfter = CMTime(seconds: 0.15, preferredTimescale: 600)

let desiredFrames = max(1, min(maxFrames, Int(ceil(durationSeconds * 2))))
var images: [CGImage] = []
var timestamps: [Double] = []
for index in 0..<desiredFrames {
  let ratio = desiredFrames <= 1 ? 0.0 : Double(index) / Double(desiredFrames - 1)
  let seconds = min(max(0.0, durationSeconds * ratio), max(0.0, durationSeconds - 0.05))
  do {
    let image = try generator.copyCGImage(at: CMTime(seconds: seconds, preferredTimescale: 600), actualTime: nil)
    images.append(image)
    timestamps.append(seconds * 1000)
  } catch {
    FileHandle.standardError.write("frame \(index) failed: \(error)\n".data(using: .utf8)!)
  }
}
guard !images.isEmpty else { fail("视频未提取到任何帧") }
let sourceWidth = images[0].width
let sourceHeight = images[0].height
let scale = min(1.0, 640.0 / Double(sourceWidth), 420.0 / Double(sourceHeight))
let tileWidth = max(1, Int((Double(sourceWidth) * scale).rounded()))
let tileHeight = max(1, Int((Double(sourceHeight) * scale).rounded()))
let columns = images.count <= 1 ? 1 : (images.count <= 4 ? 2 : 3)
let rows = Int(ceil(Double(images.count) / Double(columns)))
let gap = 8
let sheetWidth = columns * tileWidth + (columns + 1) * gap
let sheetHeight = rows * tileHeight + (rows + 1) * gap
let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let context = CGContext(
  data: nil,
  width: sheetWidth,
  height: sheetHeight,
  bitsPerComponent: 8,
  bytesPerRow: 0,
  space: colorSpace,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fail("无法创建帧图画布") }
context.setFillColor(NSColor.white.cgColor)
context.fill(CGRect(x: 0, y: 0, width: sheetWidth, height: sheetHeight))
context.interpolationQuality = .high
for (index, image) in images.enumerated() {
  let column = index % columns
  let row = index / columns
  let left = gap + column * (tileWidth + gap)
  let top = gap + row * (tileHeight + gap)
  let rect = CGRect(x: left, y: sheetHeight - top - tileHeight, width: tileWidth, height: tileHeight)
  context.draw(image, in: rect)
}
guard let sheet = context.makeImage() else { fail("无法生成帧图") }
let representation = NSBitmapImageRep(cgImage: sheet)
guard let data = representation.representation(using: .jpeg, properties: [.compressionFactor: 0.88]) else {
  fail("无法编码帧图")
}
try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
try data.write(to: outputURL)
let payload: [String: Any] = [
  "durationMs": Int((durationSeconds * 1000).rounded()),
  "frameCount": images.count,
  "timestampsMs": timestamps.map { Int($0.rounded()) },
  "width": sheetWidth,
  "height": sheetHeight,
  "output": outputURL.path,
]
let json = try JSONSerialization.data(withJSONObject: payload)
print(String(data: json, encoding: .utf8)!)
`

export interface AdaptedVideoFrame {
  index: number
  atMs: number
}

export interface AdaptedCodexVideo {
  sourcePath: string
  paths: string[]
  kind: 'video'
  frameCount: number
  durationMs?: number
  sampledFrames: AdaptedVideoFrame[]
  extractor: 'swift' | 'ffmpeg' | 'quicklook'
  warnings: string[]
}

export interface AdaptCodexVideosResult {
  imagePaths: string[]
  adaptations: AdaptedCodexVideo[]
  warnings: string[]
}

export interface AdaptCodexVideosOptions {
  prefix?: string
  failOnError?: boolean
}

interface VideoExtraction {
  path: string
  frameCount: number
  durationMs?: number
  sampledFrames: AdaptedVideoFrame[]
  extractor: AdaptedCodexVideo['extractor']
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonOutput(output: string): unknown {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      return JSON.parse(line)
    } catch {
      // Swift may print compiler warnings before the final JSON line.
    }
  }
  return undefined
}

function safePrefix(prefix: string): string {
  return (prefix || 'video').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'video'
}

function outputPath(artifactDir: string, prefix: string, index: number): string {
  const directory = join(artifactDir, 'codex-videos')
  mkdirSync(directory, { recursive: true })
  return join(directory, `${safePrefix(prefix)}-${String(index + 1).padStart(2, '0')}.jpg`)
}

async function runCommand(
  command: string,
  args: string[],
  timeout = COMMAND_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    env: process.env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
}

async function extractWithSwift(
  sourcePath: string,
  destination: string,
  artifactDir: string,
): Promise<VideoExtraction> {
  const scriptDir = join(artifactDir, 'codex-videos')
  mkdirSync(scriptDir, { recursive: true })
  const scriptPath = join(scriptDir, 'extract-video-frames.swift')
  writeFileSync(scriptPath, `${SWIFT_EXTRACTOR}\n`, 'utf8')
  const command = process.env.SWIFT_BIN?.trim() || 'swift'
  const result = await runCommand(command, [scriptPath, sourcePath, destination, String(MAX_VIDEO_FRAMES)])
  const payload = parseJsonOutput(result.stdout)
  const record = isRecord(payload) ? payload : {}
  const timestamps = Array.isArray(record.timestampsMs)
    ? record.timestampsMs.filter((value): value is number => typeof value === 'number')
    : []
  if (!existsSync(destination)) throw new Error('Swift 未生成视频帧图')
  return {
    path: destination,
    frameCount: timestamps.length,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : undefined,
    sampledFrames: timestamps.map((atMs, index) => ({ index, atMs })),
    extractor: 'swift',
    warnings: [],
  }
}

async function videoDurationMs(sourcePath: string): Promise<number | undefined> {
  const probe = process.env.FFPROBE_BIN?.trim() || 'ffprobe'
  try {
    const result = await runCommand(probe, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      sourcePath,
    ], 30_000)
    const seconds = Number(result.stdout.trim())
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
  } catch {
    return undefined
  }
}

async function extractWithFfmpeg(
  sourcePath: string,
  destination: string,
): Promise<VideoExtraction> {
  const durationMs = await videoDurationMs(sourcePath)
  if (!durationMs) throw new Error('ffprobe 无法读取视频时长')
  const durationSeconds = durationMs / 1000
  const fps = Math.min(30, Math.max(0.1, MAX_VIDEO_FRAMES / durationSeconds))
  const filter = [
    `fps=${fps.toFixed(4)}`,
    'scale=640:420:force_original_aspect_ratio=decrease',
    'pad=640:420:(ow-iw)/2:(oh-ih)/2:color=white',
    `tile=3x2:nb_frames=${MAX_VIDEO_FRAMES}`,
  ].join(',')
  const command = process.env.FFMPEG_BIN?.trim() || 'ffmpeg'
  await runCommand(command, [
    '-y',
    '-i',
    sourcePath,
    '-vf',
    filter,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    destination,
  ])
  if (!existsSync(destination)) throw new Error('ffmpeg 未生成视频帧图')
  const step = durationMs / MAX_VIDEO_FRAMES
  return {
    path: destination,
    frameCount: MAX_VIDEO_FRAMES,
    durationMs,
    sampledFrames: Array.from({ length: MAX_VIDEO_FRAMES }, (_, index) => ({
      index,
      atMs: Math.round(index * step),
    })),
    extractor: 'ffmpeg',
    warnings: [],
  }
}

async function extractWithQuickLook(
  sourcePath: string,
  destination: string,
  artifactDir: string,
): Promise<VideoExtraction> {
  const directory = join(artifactDir, 'codex-videos', `.quicklook-${Date.now()}`)
  mkdirSync(directory, { recursive: true })
  try {
    await runCommand('qlmanage', ['-t', '-s', '1200', '-o', directory, sourcePath], 60_000)
    const thumbnail = readdirSync(directory).find((name) => /\.(png|jpg|jpeg)$/i.test(name))
    if (!thumbnail) throw new Error('Quick Look 未生成视频缩略图')
    copyFileSync(join(directory, thumbnail), destination)
    return {
      path: destination,
      frameCount: 1,
      sampledFrames: [{ index: 0, atMs: 0 }],
      extractor: 'quicklook',
      warnings: ['当前环境无法均匀抽帧，MP4 仅适配了首帧；安装 ffmpeg 或在 macOS 安装 Xcode 命令行工具可读取完整视频时间线'],
    }
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup only.
    }
  }
}

export async function adaptVideoForCodex(
  sourcePath: string,
  artifactDir: string,
  index: number,
  prefix = 'video',
): Promise<AdaptedCodexVideo> {
  const destination = outputPath(artifactDir, prefix, index)
  const warnings: string[] = []
  const attempts: Array<{
    name: string
    run: () => Promise<VideoExtraction>
  }> = []

  if (process.platform === 'darwin') {
    attempts.push({ name: 'Swift/AVFoundation', run: () => extractWithSwift(sourcePath, destination, artifactDir) })
  }
  attempts.push({ name: 'ffmpeg', run: () => extractWithFfmpeg(sourcePath, destination) })
  if (process.platform === 'darwin') {
    attempts.push({
      name: 'Quick Look',
      run: () => extractWithQuickLook(sourcePath, destination, artifactDir),
    })
  }

  for (const attempt of attempts) {
    try {
      const extracted = await attempt.run()
      if (extracted.path !== destination) {
        copyFileSync(extracted.path, destination)
        extracted.path = destination
      }
      const size = statSync(destination).size
      if (size <= 0 || size > MAX_OUTPUT_BYTES) {
        throw new Error(`视频帧图大小超出限制：${size} 字节`)
      }
      return {
        sourcePath,
        paths: [destination],
        kind: 'video',
        frameCount: extracted.frameCount,
        durationMs: extracted.durationMs,
        sampledFrames: extracted.sampledFrames,
        extractor: extracted.extractor,
        warnings: [...warnings, ...extracted.warnings],
      }
    } catch (error) {
      warnings.push(
        `${attempt.name} 抽帧失败：${error instanceof Error ? error.message : String(error)}`,
      )
      try {
        if (existsSync(destination)) rmSync(destination, { force: true })
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
  throw new Error(warnings.join('；') || `无法从视频提取帧：${basename(sourcePath)}`)
}

export async function adaptCodexVideos(
  paths: string[],
  artifactDir: string,
  options: AdaptCodexVideosOptions = {},
): Promise<AdaptCodexVideosResult> {
  const adaptations: AdaptedCodexVideo[] = []
  const warnings: string[] = []
  for (let index = 0; index < paths.length; index += 1) {
    try {
      adaptations.push(
        await adaptVideoForCodex(paths[index], artifactDir, index, options.prefix),
      )
    } catch (error) {
      const message = `第 ${index + 1} 个视频无法用于 Codex：${
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
