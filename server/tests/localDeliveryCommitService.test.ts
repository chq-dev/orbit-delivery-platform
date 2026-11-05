import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildDeliveryCommitPrompt,
  clearStaleGitIndexLock,
  deliveryCommitMessageFor,
  forbiddenDeliveryCommitFiles,
  isForbiddenDeliveryCommitFile,
  planDeliveryCommitFiles,
  validateDeliveryCommit,
} from '../services/localDeliveryCommitService.js'

const item = {
  id: 'REQ-1137',
  title: '模式切换菜单适配',
  type: 'requirement' as const,
}

test('提交提示词要求第二次 Codex 执行 /aicr-commit 且只本地提交', () => {
  const message = deliveryCommitMessageFor(item)
  const prompt = buildDeliveryCommitPrompt({
    checkout: '/Users/chenhuaqu/sme/sme-main',
    branch: 'main-harvey',
    item,
    commitMessage: message,
  })

  assert.match(prompt, /\/aicr-commit/)
  assert.match(prompt, /\.claude\/skills-overlay\/aicr-commit\/SKILL\.md/)
  assert.match(prompt, /\.claude\/skills-overlay\/aicr-workflow\/SKILL\.md/)
  assert.match(prompt, /\.claude\/skills-overlay\/aicr-pr\/references\/title-rules\.md/)
  assert.match(prompt, /\.git\/aicr-ai-review-latest\.json/)
  assert.match(prompt, /scope.*staged/)
  assert.match(prompt, /approved/)
  assert.match(prompt, /不要 push/)
  assert.match(prompt, /禁止再执行 `git add`/)
  assert.ok(prompt.includes(message))
})

test('敏感文件判定覆盖 .env、密钥与证书', () => {
  assert.equal(isForbiddenDeliveryCommitFile('web/.env.development'), true)
  assert.equal(isForbiddenDeliveryCommitFile('.env'), true)
  assert.equal(isForbiddenDeliveryCommitFile('config/prod.env.local'), false)
  assert.equal(isForbiddenDeliveryCommitFile('certs/server.pem'), true)
  assert.equal(isForbiddenDeliveryCommitFile('ssh/id_rsa'), true)
  assert.equal(isForbiddenDeliveryCommitFile('web/components/views/modeSwitch/index.vue'), false)
  assert.deepEqual(
    forbiddenDeliveryCommitFiles([
      'web/.env.development',
      'web/components/a.vue',
      './certs/server.key',
    ]),
    ['web/.env.development', 'certs/server.key'],
  )
})

test('提交校验接受带 AICR 规范标题的真实源码提交', () => {
  const message = deliveryCommitMessageFor(item)
  assert.doesNotThrow(() =>
    validateDeliveryCommit({
      previousHead: 'aaa',
      head: 'bbb',
      message: `${message}\n`,
      files: ['web/components/views/modeSwitch/index.vue'],
      expectedMessage: message,
    }),
  )
})

test('提交校验拒绝未创建提交（AICR 未通过或未执行 /aicr-commit）', () => {
  assert.throws(
    () =>
      validateDeliveryCommit({
        previousHead: 'aaa',
        head: 'aaa',
        message: deliveryCommitMessageFor(item),
        files: ['web/a.ts'],
        expectedMessage: deliveryCommitMessageFor(item),
      }),
    /未创建新的提交/,
  )
})

test('提交校验拒绝 .env 与不符合规范的标题', () => {
  const message = deliveryCommitMessageFor(item)
  assert.throws(
    () =>
      validateDeliveryCommit({
        previousHead: 'aaa',
        head: 'bbb',
        message,
        files: ['web/.env.development', 'web/a.ts'],
        expectedMessage: message,
      }),
    /禁止提交的敏感文件：web\/\.env\.development/,
  )
  assert.throws(
    () =>
      validateDeliveryCommit({
        previousHead: 'aaa',
        head: 'bbb',
        message: 'feat: 随意提交',
        files: ['web/a.ts'],
        expectedMessage: message,
      }),
    /提交标题不符合 AICR 规范/,
  )
})

test('提交校验拒绝只有报告没有源码的提交', () => {
  const message = deliveryCommitMessageFor(item)
  assert.throws(
    () =>
      validateDeliveryCommit({
        previousHead: 'aaa',
        head: 'bbb',
        message,
        files: ['delivery-artifacts/REQ-1137/design-report.md'],
        expectedMessage: message,
      }),
    /没有包含任何非 Markdown 代码文件/,
  )
})

test('暂存计划只允许项目规则内的源码、LDD、测试和 zh 词条', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'orbit-commit-plan-'))
  try {
    const ruleDir = join(checkout, 'web', 'scripts', 'git', 'husky')
    mkdirSync(ruleDir, { recursive: true })
    writeFileSync(
      join(ruleDir, 'restricted-files.json'),
      JSON.stringify({
        restrictedFiles: [
          { pattern: '^web/vite\\.config\\.js$', description: 'Vite 配置', enabled: true },
        ],
        restrictedPatterns: [
          { pattern: '\\.env.*', description: '环境变量文件', enabled: true },
        ],
      }),
    )
    const plan = planDeliveryCommitFiles(checkout, [
      'web/src/api/privateMetrics.ts',
      'web/components/views/Dashboard.vue',
      'web/components/views/__tests__/privateMetrics.test.ts',
      'web/docs/ldd/SME-私有指标-LDD.md',
      'web/components/i18n/lang/zh.json',
      'web/components/i18n/lang/en.json',
      'delivery-artifacts/REQ-1082/design-report.md',
      'web/.env.development',
      'web/certs/server.pem',
      'web/build.log',
      'web/dist/app.js',
      'web/vite.config.js',
    ])

    assert.deepEqual(plan.allowedFiles, [
      'web/components/i18n/lang/zh.json',
      'web/components/views/Dashboard.vue',
      'web/components/views/__tests__/privateMetrics.test.ts',
      'web/docs/ldd/SME-私有指标-LDD.md',
      'web/src/api/privateMetrics.ts',
    ])
    assert.deepEqual(
      plan.excludedFiles.map((file) => file.path),
      [
        'delivery-artifacts/REQ-1082/design-report.md',
        'web/.env.development',
        'web/build.log',
        'web/certs/server.pem',
        'web/components/i18n/lang/en.json',
        'web/dist/app.js',
        'web/vite.config.js',
      ],
    )
  } finally {
    rmSync(checkout, { recursive: true, force: true })
  }
})

test('提交校验拒绝提交文件超出项目允许清单', () => {
  const message = deliveryCommitMessageFor(item)
  assert.throws(
    () =>
      validateDeliveryCommit({
        previousHead: 'aaa',
        head: 'bbb',
        message,
        files: ['web/src/a.ts', 'web/src/unrelated.ts'],
        expectedMessage: message,
        allowedFiles: ['web/src/a.ts'],
      }),
    /未按项目规则暂存的文件：web\/src\/unrelated\.ts/,
  )
})

test('提交前只清理超过两分钟且无人占用的空 Git 索引锁', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-index-lock-'))
  try {
    const init = spawnSync('git', ['init', '--quiet', directory], { encoding: 'utf8' })
    assert.equal(init.status, 0)
    const lockPath = join(directory, '.git', 'index.lock')
    writeFileSync(lockPath, '')
    const stale = new Date(Date.now() - 3 * 60_000)
    utimesSync(lockPath, stale, stale)
    assert.equal(clearStaleGitIndexLock(directory), true)
    assert.equal(clearStaleGitIndexLock(directory), false)

    writeFileSync(lockPath, '')
    assert.equal(clearStaleGitIndexLock(directory), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
