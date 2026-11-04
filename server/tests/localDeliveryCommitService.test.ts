import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildDeliveryCommitPrompt,
  deliveryCommitMessageFor,
  forbiddenDeliveryCommitFiles,
  isForbiddenDeliveryCommitFile,
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
  assert.match(prompt, /禁止暂存 `\.env`、`\.env\.\*`/)
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
