import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import UPNG from 'upng-js'
import { encodeAnimation } from 'wasm-webp/dist/esm/index.js'
import { adaptCodexImages, adaptImageForCodex } from '../services/imageAdaptation.js'

const TWO_FRAME_GIF = Buffer.from(
  '47494638396101000100800000000000ffffff21ff0b4e45545343415045322e30030100000021f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024401003b',
  'hex',
)


const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  typeBytes.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length)
  return chunk
}

function pngChunkData(png: Buffer, type: string): Buffer {
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const chunkType = png.subarray(offset + 4, offset + 8).toString('ascii')
    if (chunkType === type) return png.subarray(offset + 8, offset + 8 + length)
    offset += length + 12
  }
  throw new Error(`PNG 缺少 ${type} chunk`)
}

function makeTwoFrameApng(width: number, height: number): Buffer {
  const frame = (red: number, green: number, blue: number): ArrayBuffer =>
    Uint8Array.from({ length: width * height * 4 }, (_, index) =>
      index % 4 === 0 ? red : index % 4 === 1 ? green : index % 4 === 2 ? blue : 255,
    ).buffer
  const first = Buffer.from(UPNG.encode([frame(255, 0, 0)], width, height, 0, undefined, true))
  const second = Buffer.from(UPNG.encode([frame(0, 255, 0)], width, height, 0, undefined, true))
  const header = pngChunkData(first, 'IHDR')
  const firstData = pngChunkData(first, 'IDAT')
  const secondData = pngChunkData(second, 'IDAT')
  const frameControl = (sequence: number): Buffer => {
    const data = Buffer.alloc(26)
    data.writeUInt32BE(sequence, 0)
    data.writeUInt32BE(width, 4)
    data.writeUInt32BE(height, 8)
    data.writeUInt32BE(0, 12)
    data.writeUInt32BE(0, 16)
    data.writeUInt16BE(1, 20)
    data.writeUInt16BE(10, 22)
    data[24] = 0
    data[25] = 0
    return data
  }
  const animationControl = Buffer.alloc(8)
  animationControl.writeUInt32BE(2, 0)
  animationControl.writeUInt32BE(0, 4)
  const frameData = Buffer.concat([Buffer.alloc(4), secondData])
  frameData.writeUInt32BE(2, 0)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('acTL', animationControl),
    pngChunk('fcTL', frameControl(0)),
    pngChunk('IDAT', firstData),
    pngChunk('fcTL', frameControl(1)),
    pngChunk('fdAT', frameData),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'orbit-image-adaptation-'))
}

test('GIF 动图会按时间采样并适配成 Codex 可读取的 PNG 帧图', async () => {
  const directory = tempDirectory()
  try {
    const source = join(directory, 'defect.gif')
    writeFileSync(source, TWO_FRAME_GIF)
    const adapted = await adaptImageForCodex(source, directory, 0, 'feishu')
    assert.equal(adapted.kind, 'animated')
    assert.equal(adapted.format, 'gif')
    assert.equal(adapted.frameCount, 2)
    assert.deepEqual(
      adapted.sampledFrames.map((frame) => frame.index),
      [0, 1],
    )
    assert.match(adapted.paths[0] ?? '', /codex-images\/feishu-01\.png$/)
    assert.deepEqual(
      readFileSync(adapted.paths[0] ?? '').subarray(0, 8),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('动态 WebP 会解码全部帧并适配成一张有序帧图', async () => {
  const directory = tempDirectory()
  try {
    const width = 8
    const height = 6
    const frame = (red: number, green: number, blue: number): Uint8Array =>
      Uint8Array.from({ length: width * height * 4 }, (_, index) =>
        index % 4 === 0 ? red : index % 4 === 1 ? green : index % 4 === 2 ? blue : 255,
      )
    const encoded = await encodeAnimation(width, height, true, [
      { data: frame(255, 0, 0), duration: 100 },
      { data: frame(0, 255, 0), duration: 120 },
      { data: frame(0, 0, 255), duration: 140 },
    ])
    assert.ok(encoded)
    const source = join(directory, 'defect.webp')
    writeFileSync(source, encoded)
    const adapted = await adaptImageForCodex(source, directory, 0, 'feishu')
    assert.equal(adapted.kind, 'animated')
    assert.equal(adapted.format, 'webp')
    assert.equal(adapted.frameCount, 3)
    assert.deepEqual(
      adapted.sampledFrames.map((frame) => frame.atMs),
      [0, 100, 220],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('图片适配遇到坏图时按交付来源选择失败或警告', async () => {
  const directory = tempDirectory()
  try {
    const source = join(directory, 'broken.bin')
    writeFileSync(source, Buffer.from('not-an-image'))
    assert.rejects(
      () => adaptCodexImages([source], directory, { failOnError: true }),
      /无法识别图片格式/,
    )
    const result = await adaptCodexImages([source], directory)
    assert.deepEqual(result.imagePaths, [])
    assert.match(result.warnings[0] ?? '', /无法识别图片格式/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('APNG 动图会解析帧控制并适配成 Codex 可读取的 PNG 帧图', async () => {
  const directory = tempDirectory()
  try {
    const source = join(directory, 'defect.png')
    writeFileSync(source, makeTwoFrameApng(5, 4))
    const adapted = await adaptImageForCodex(source, directory, 0, 'feishu')
    assert.equal(adapted.kind, 'animated')
    assert.equal(adapted.format, 'apng')
    assert.equal(adapted.frameCount, 2)
    assert.deepEqual(
      adapted.sampledFrames.map((frame) => frame.index),
      [0, 1],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
