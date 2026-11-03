import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildFailedDeliveryPipelinePayload,
  buildCodexExecArgs,
  buildLocalDeliveryCommand,
  classifyLocalDeliveryFailure,
  createLocalDeliveryAgentSteps,
  describeFetchError,
  failedDeliveryStageIndex,
  fetchJsonWithRetry,
  parseLocalDeliveryAgentRequest,
  resolveLocalDeliveryBranch,
  resolveLocalDeliveryFailureStep,
  resolveLocalDeliveryTarget,
  supportsLocalDeliveryContract,
  updateLocalDeliveryAgentStep,
} from '../services/localDeliveryAgentService.js'

const request = {
  workItemId: 'REQ-1082',
  repoId: 'repo-1',
  autoCommit: true,
  pushAfterAcceptance: true,
  autoClose: true,
}

test('一键交付请求只接受受控参数，不允许浏览器下发本地路径', () => {
  assert.deepEqual(parseLocalDeliveryAgentRequest(request), request)
  assert.throws(
    () =>
      parseLocalDeliveryAgentRequest({
        ...request,
        localPath: '/Users/example/sme-main',
      }),
    /不支持交付参数：localPath/,
  )
  assert.throws(
    () => parseLocalDeliveryAgentRequest({ ...request, workItemId: '../shell' }),
    /工作项格式不正确/,
  )
  assert.throws(
    () => parseLocalDeliveryAgentRequest({ ...request, autoCommit: false }),
    /未启用自动提交时不能推送/,
  )
})

test('一键交付路径和分支只从平台仓库配置解析', () => {
  const target = resolveLocalDeliveryTarget(
    {
      repositories: [
        {
          id: 'repo-1',
          name: 'sme-main',
          localPath: '/Users/chenhuaqu/sme/sme-main',
          branch: 'dev-harvey',
        },
      ],
      workItems: [
        {
          id: 'REQ-1082',
          title: '测试需求',
          repoId: 'repo-1',
          branch: 'work-item-branch',
        },
      ],
    },
    request,
  )
  assert.equal(target.localPath, '/Users/chenhuaqu/sme/sme-main')
  assert.equal(target.branch, 'dev-harvey')
  assert.throws(
    () =>
      resolveLocalDeliveryTarget(
        {
          repositories: [{ id: 'repo-1', branch: 'dev-harvey' }],
          workItems: [{ id: 'REQ-1082' }],
        },
        request,
      ),
    /尚未配置当前客户端的代码路径/,
  )
})

test('本机代理的仓库路径映射优先于平台共享路径', () => {
  const target = resolveLocalDeliveryTarget(
    {
      repositories: [
        {
          id: 'repo-1',
          name: 'sme-main',
          localPath: '/Users/shinya/Documents/workspace/SME/basic-component-cloud',
          branch: 'dev-harvey',
        },
      ],
      workItems: [{ id: 'REQ-1082', repoId: 'repo-1' }],
    },
    request,
    { 'repo-1': '/Users/chenhuaqu/sme/sme-main' },
  )
  assert.equal(target.localPath, '/Users/chenhuaqu/sme/sme-main')
  assert.equal(target.branch, 'dev-harvey')
})

test('本机实际分支优先于平台默认分支，并标记已适配', () => {
  assert.deepEqual(resolveLocalDeliveryBranch('dev-harvey', 'main-harvey'), {
    branch: 'dev-harvey',
    configuredBranch: 'main-harvey',
    adapted: true,
  })
  assert.deepEqual(resolveLocalDeliveryBranch('main-harvey', 'main-harvey'), {
    branch: 'main-harvey',
    configuredBranch: 'main-harvey',
    adapted: false,
  })
  assert.deepEqual(resolveLocalDeliveryBranch('feature/local', ''), {
    branch: 'feature/local',
    configuredBranch: undefined,
    adapted: false,
  })
  assert.throws(() => resolveLocalDeliveryBranch('', 'main-harvey'), /无法读取本地仓库当前分支/)
})

test('平台未配置默认分支时仍可使用本机实际分支', () => {
  const target = resolveLocalDeliveryTarget(
    {
      repositories: [{ id: 'repo-1', localPath: '/Users/example/sme-main' }],
      workItems: [{ id: 'REQ-1082', repoId: 'repo-1' }],
    },
    request,
  )
  assert.equal(target.branch, undefined)
  assert.equal(resolveLocalDeliveryBranch('main-harvey', target.branch).branch, 'main-harvey')
})

test('一键交付命令通过 argv 传递并自动授权推送确认', () => {
  assert.deepEqual(
    buildLocalDeliveryCommand({
      platformBaseUrl: 'http://8.145.45.84:8787',
      ...request,
      localPath: '/Users/chenhuaqu/sme/sme-main',
      branch: 'dev-harvey',
    }),
    [
      'run',
      'deliver:local',
      '--',
      '--api',
      'http://8.145.45.84:8787',
      '--work-item',
      'REQ-1082',
      '--repo',
      'repo-1',
      '--path',
      '/Users/chenhuaqu/sme/sme-main',
      '--branch',
      'dev-harvey',
      '--run',
      '--push',
      '--yes',
      '--close',
    ],
  )

  const localOnly = buildLocalDeliveryCommand({
    platformBaseUrl: 'http://8.145.45.84:8787',
    ...request,
    autoCommit: false,
    pushAfterAcceptance: false,
    autoClose: false,
    localPath: '/Users/chenhuaqu/sme/sme-main',
    branch: 'dev-harvey',
  })
  assert.equal(localOnly.includes('--no-commit'), true)
  assert.equal(localOnly.includes('--push'), false)
  assert.equal(localOnly.includes('--yes'), false)
  assert.equal(localOnly.includes('--close'), false)
})

test('Codex 参数用 -- 隔离图片参数与提示词，避免提示词被当作图片吞掉', () => {
  const args = buildCodexExecArgs({
    checkout: '/Users/example/sme-main',
    prompt: '实现需求并生成报告',
    lastMessagePath: '/tmp/codex-last-message.md',
    imagePaths: ['/tmp/design shot.jpg'],
    mcpArgs: ['-c', 'mcp_servers.feishu.command=lark-mcp'],
  })
  const separator = args.indexOf('--')
  assert.ok(separator > args.indexOf('--image'))
  assert.equal(args[separator + 1], '实现需求并生成报告')
  assert.equal(args.at(-1), '实现需求并生成报告')
  assert.equal(args.includes('/tmp/design shot.jpg'), true)
})

test('Codex 失败不会因输出中的 autoCommit 被误归到提交步骤', () => {
  assert.equal(
    classifyLocalDeliveryFailure(
      'Codex 执行失败，退出码 1\n{"autoCommit": true, "promptFile": "/tmp/prompt.md"}',
    ),
    'codex',
  )
  assert.equal(
    classifyLocalDeliveryFailure('Codex 已结束，但没有检测到非 Markdown 代码文件变更'),
    'evidence',
  )
  assert.equal(classifyLocalDeliveryFailure('推送失败：remote rejected'), 'commit')
  assert.equal(classifyLocalDeliveryFailure('未启用自动提交代码；代码保留在工作区'), 'commit')
  assert.equal(
    classifyLocalDeliveryFailure('平台已记录失败流水线 RUN-2411，但本次交付失败'),
    'writeback',
  )
})

test('提交失败会定位到提交阶段，并由本机代理生成失败流水线兜底载荷', () => {
  const message =
    '创建本地交付提交失败：提交者姓名检查失败：git user.name 必须为中文真实姓名'
  const failedStepKey = resolveLocalDeliveryFailureStep(message, 'codex')
  assert.equal(failedStepKey, 'commit')
  assert.equal(failedDeliveryStageIndex(message, failedStepKey), 4)

  const steps = createLocalDeliveryAgentSteps()
  updateLocalDeliveryAgentStep(steps, 'platform', 'success', '平台已读取')
  updateLocalDeliveryAgentStep(steps, 'contract', 'success', '契约版本 4')
  updateLocalDeliveryAgentStep(steps, 'checkout', 'success', '工作区正常')
  updateLocalDeliveryAgentStep(steps, 'codex', 'success', 'Codex 已完成')
  const payload = buildFailedDeliveryPipelinePayload({
    workItemId: 'REQ-1082',
    repoId: 'repo-1',
    branch: 'main-harvey',
    localPath: '/Users/chenhuaqu/sme/sme-main',
    error: message,
    failedStepKey,
    autoCommit: true,
    steps,
  })
  assert.equal(payload.outcome, 'failed')
  assert.equal(payload.failedStageIndex, 4)
  const stageResults = payload.stageResults as Array<{ index: number; status: string }>
  assert.equal(stageResults[0].status, 'success')
  assert.equal(stageResults[2].status, 'success')
  assert.equal(stageResults[4].status, 'failed')
  assert.equal(stageResults[5].status, 'pending')
})

test('失败流水线兜底载荷会截断超长错误并标记对应证据阶段', () => {
  const message = `缺少 delivery-artifacts 中的设计报告：${'x'.repeat(5_000)}`
  assert.equal(failedDeliveryStageIndex(message, 'evidence'), 1)
  const payload = buildFailedDeliveryPipelinePayload({
    workItemId: 'REQ-1082',
    repoId: 'repo-1',
    error: message,
    failedStepKey: 'evidence',
    autoCommit: true,
  })
  assert.equal(String(payload.error).length, 4_000)
  assert.equal(payload.failedStageIndex, 1)
})

test('旧服务端缺少交付契约字段时拒绝执行本机交付', () => {
  assert.equal(supportsLocalDeliveryContract({ status: 'ok' }), false)
  assert.equal(supportsLocalDeliveryContract({ deliveryContractVersion: undefined }), false)
  assert.equal(supportsLocalDeliveryContract(null), false)
  assert.equal(supportsLocalDeliveryContract({ deliveryContractVersion: 0 }), false)
  assert.equal(supportsLocalDeliveryContract({ deliveryContractVersion: 1 }), false)
  assert.equal(supportsLocalDeliveryContract({ deliveryContractVersion: '2' }), false)
  assert.equal(supportsLocalDeliveryContract({ deliveryContractVersion: 3 }), false)
  assert.equal(supportsLocalDeliveryContract({ deliveryContractVersion: 4 }), true)
})

test('本机交付步骤会记录运行、成功、失败与日志', () => {
  const steps = createLocalDeliveryAgentSteps()
  assert.equal(steps.length, 7)
  assert.equal(steps.every((step) => step.status === 'pending'), true)
  const running = updateLocalDeliveryAgentStep(steps, 'platform', 'running', '连接平台')
  assert.equal(running?.status, 'running')
  assert.ok(running?.startedAt)
  const failed = updateLocalDeliveryAgentStep(steps, 'platform', 'failed', '连接超时')
  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.log, '连接超时')
  assert.ok(failed?.finishedAt)
})

test('平台请求遇到瞬时连接失败会重试并返回成功结果', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  const retries: string[] = []
  globalThis.fetch = (async () => {
    calls += 1
    if (calls < 3) {
      throw new TypeError('fetch failed', {
        cause: { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error' },
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const result = await fetchJsonWithRetry<{ ok: boolean }>('http://example.test/health', {
      attempts: 3,
      timeoutMs: 1_000,
      onRetry: ({ error }) => retries.push(error),
    })
    assert.deepEqual(result, { ok: true })
    assert.equal(calls, 3)
    assert.equal(retries.length, 2)
    assert.match(retries[0], /UND_ERR_CONNECT_TIMEOUT/)
    assert.match(describeFetchError(new TypeError('fetch failed', {
      cause: { code: 'ECONNRESET' },
    })), /ECONNRESET/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
