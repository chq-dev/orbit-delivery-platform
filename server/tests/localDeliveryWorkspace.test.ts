import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  cleanupGeneratedDeliveryFiles,
  isolatePreexistingDeliveryChanges,
  restorePreexistingDeliveryChanges,
} from '../services/localDeliveryWorkspace.js'

function git(checkout: string, args: string[]): void {
  const result = spawnSync('git', ['-C', checkout, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

function createCheckout(): string {
  const checkout = mkdtempSync(join(tmpdir(), 'orbit-workspace-'))
  git(checkout, ['init', '-b', 'main'])
  git(checkout, ['config', 'user.name', 'Orbit Test'])
  git(checkout, ['config', 'user.email', 'orbit@example.test'])
  mkdirSync(join(checkout, 'web'), { recursive: true })
  writeFileSync(join(checkout, 'web', 'tracked.ts'), 'export const value = "base"\n')
  writeFileSync(join(checkout, 'web', 'legacy-tracked.ts'), 'export const legacy = "base"\n')
  git(checkout, ['add', '.'])
  git(checkout, ['commit', '-m', 'base'])
  return checkout
}

test('交付前隔离用户原有改动，结束后恢复且保留交付产物', () => {
  const checkout = createCheckout()
  try {
    mkdirSync(join(checkout, 'delivery-artifacts', 'BUG-1'), { recursive: true })
    writeFileSync(
      join(checkout, 'delivery-artifacts', 'BUG-1', 'feishu-context.md'),
      '# context\n',
    )
    writeFileSync(
      join(checkout, 'web', 'legacy-tracked.ts'),
      'export const legacy = "user legacy"\n',
    )
    writeFileSync(join(checkout, 'web', 'legacy.ts'), 'export const legacy = true\n')

    const isolation = isolatePreexistingDeliveryChanges(checkout, 'BUG-1')
    assert.equal(isolation.active, true)
    assert.deepEqual(isolation.preexistingFiles.sort(), [
      'web/legacy-tracked.ts',
      'web/legacy.ts',
    ])
    assert.equal(
      readFileSync(join(checkout, 'web', 'legacy-tracked.ts'), 'utf8').includes('base'),
      true,
    )
    assert.equal(existsSync(join(checkout, 'web', 'legacy.ts')), false)
    assert.equal(
      existsSync(join(checkout, 'delivery-artifacts', 'BUG-1', 'feishu-context.md')),
      true,
    )

    writeFileSync(join(checkout, 'web', 'tracked.ts'), 'export const value = "delivery"\n')
    writeFileSync(join(checkout, 'web', 'generated.test.ts'), 'test("generated", () => {})\n')
    mkdirSync(join(checkout, 'web', 'docs', 'ldd'), { recursive: true })
    writeFileSync(join(checkout, 'web', 'docs', 'ldd', 'BUG-1-LDD.md'), '# LDD\n')
    const cleaned = cleanupGeneratedDeliveryFiles(checkout, [
      { path: 'web/generated.test.ts', reason: '测试文件仅作验证，不参与交付提交' },
      { path: 'web/docs/ldd/BUG-1-LDD.md', reason: 'LDD/设计文档仅作交付证据，不提交' },
      { path: 'delivery-artifacts/BUG-1/feishu-context.md', reason: '交付产物目录' },
    ])
    assert.deepEqual(cleaned, ['web/generated.test.ts'])
    assert.equal(existsSync(join(checkout, 'web', 'generated.test.ts')), false)
    assert.equal(existsSync(join(checkout, 'web', 'docs', 'ldd', 'BUG-1-LDD.md')), true)
    assert.equal(
      existsSync(join(checkout, 'delivery-artifacts', 'BUG-1', 'feishu-context.md')),
      true,
    )

    assert.deepEqual(restorePreexistingDeliveryChanges(isolation), { restored: true })
    assert.equal(
      readFileSync(join(checkout, 'web', 'legacy-tracked.ts'), 'utf8').includes('user legacy'),
      true,
    )
    assert.equal(readFileSync(join(checkout, 'web', 'tracked.ts'), 'utf8').includes('delivery'), true)
    assert.equal(existsSync(join(checkout, 'web', 'legacy.ts')), true)
    assert.equal(gitStashCount(checkout), 0)
  } finally {
    rmSync(checkout, { recursive: true, force: true })
  }
})

test('原有改动与本次交付文件重叠时保留 stash，不覆盖已交付代码', () => {
  const checkout = createCheckout()
  try {
    writeFileSync(join(checkout, 'web', 'tracked.ts'), 'export const value = "user legacy"\n')
    const isolation = isolatePreexistingDeliveryChanges(checkout, 'BUG-OVERLAP')
    writeFileSync(join(checkout, 'web', 'tracked.ts'), 'export const value = "delivery"\n')

    const restored = restorePreexistingDeliveryChanges(isolation)
    assert.equal(restored.restored, false)
    assert.match(restored.warning ?? '', /恢复交付前未提交代码时发生冲突/)
    assert.equal(readFileSync(join(checkout, 'web', 'tracked.ts'), 'utf8').includes('delivery'), true)
    assert.equal(gitStashCount(checkout), 1)
  } finally {
    rmSync(checkout, { recursive: true, force: true })
  }
})

test('清理本次生成的测试文件时只恢复文件到 HEAD，不删除仓库原有文件', () => {
  const checkout = createCheckout()
  try {
    mkdirSync(join(checkout, 'web', '__tests__'), { recursive: true })
    writeFileSync(join(checkout, 'web', '__tests__', 'tracked.test.ts'), 'test("base", () => {})\n')
    git(checkout, ['add', '.'])
    git(checkout, ['commit', '-m', 'tracked test'])
    writeFileSync(
      join(checkout, 'web', '__tests__', 'tracked.test.ts'),
      'test("generated delivery change", () => {})\n',
    )

    assert.deepEqual(
      cleanupGeneratedDeliveryFiles(checkout, [
        {
          path: 'web/__tests__/tracked.test.ts',
          reason: '测试文件仅作验证，不参与交付提交',
        },
      ]),
      ['web/__tests__/tracked.test.ts'],
    )
    assert.equal(
      readFileSync(join(checkout, 'web', '__tests__', 'tracked.test.ts'), 'utf8').includes('base'),
      true,
    )
  } finally {
    rmSync(checkout, { recursive: true, force: true })
  }
})

function gitStashCount(checkout: string): number {
  const result = spawnSync('git', ['-C', checkout, 'stash', 'list'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim() ? result.stdout.trim().split(/\r?\n/).length : 0
}
