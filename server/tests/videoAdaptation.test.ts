import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'
import { adaptVideoForCodex } from '../services/videoAdaptation.js'

function hasSwift(): boolean {
  try {
    execFileSync('swift', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('MP4 视频会按时间抽帧并适配成 Codex 可读取的帧图', {
  skip: process.platform !== 'darwin' || !hasSwift()
    ? '仅在带 Swift/AVFoundation 的 macOS 环境验证真实 MP4 抽帧'
    : false,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-video-adaptation-'))
  try {
    const source = fileURLToPath(new URL('./fixtures/video-sample.mp4', import.meta.url))
    const adapted = await adaptVideoForCodex(source, directory, 0, 'feishu')
    assert.equal(adapted.kind, 'video')
    assert.equal(adapted.extractor, 'swift')
    assert.ok(adapted.frameCount >= 2)
    assert.ok((adapted.durationMs ?? 0) >= 1_000)
    assert.deepEqual(adapted.sampledFrames.map((frame) => frame.index), [0, 1, 2, 3])
    assert.deepEqual(
      readFileSync(adapted.paths[0] ?? '').subarray(0, 2),
      Buffer.from([0xff, 0xd8]),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
