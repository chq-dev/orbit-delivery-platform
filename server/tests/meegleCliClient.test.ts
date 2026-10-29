import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertMeegleAuthenticated,
  fetchMeegleWorkItems,
  MeegleCliError,
  type MeegleCommandResult,
  type MeegleCommandRunner,
  type MeegleSyncConfig,
} from '../services/meegleCliClient.js'

const config: MeegleSyncConfig = {
  command: 'meegle',
  host: 'https://project.feishu.cn/',
  projectKey: 'rjcloud',
  requirementTypeKey: 'story',
  defectTypeKey: 'issue',
  defaultOwner: '飞书同步',
  fetchDescriptions: true,
}

function result(payload: unknown, exitCode = 0): MeegleCommandResult {
  return { stdout: JSON.stringify(payload), stderr: '', exitCode }
}

test('Meegle CLI 客户端按 story/issue 拉取工作项并补充描述', async () => {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = []
  const runner: MeegleCommandRunner = async (_command, args, env) => {
    calls.push({ args, env })
    if (args[0] === 'auth') return result({ authenticated: true })
    if (args[0] === 'workitem' && args[1] === 'query') {
      const mql = args[args.indexOf('--mql') + 1]
      if (mql.includes('`story`')) {
        assert.match(mql, /FROM `rjcloud`\.`story`/)
        assert.match(mql, /`archiving_date` IS NULL/)
        return result({
          session_id: 'story-session',
          list: [
            {
              count: 2,
              group_infos: [{ group_id: '1' }],
              data: [
                {
                  work_item_id: '101',
                  name: '需求 A',
                  priority: { label: '高' },
                  current_status_operator: [{ name: 'Alice' }],
                  updated_at: '2026-10-29T01:00:00.000Z',
                },
                {
                  work_item_id: '102',
                  name: '需求 B',
                  priority: '中',
                  current_status_operator: 'Bob',
                  updated_at: 1_793_238_000_000,
                },
              ],
            },
          ],
        })
      }
      assert.match(mql, /FROM `rjcloud`\.`issue`/)
      return result({
        list: [
          {
            count: 1,
            group_infos: [{ group_id: '1' }],
            data: [
              {
                work_item_id: '201',
                name: '缺陷 A',
                priority: 'P0',
                current_status_operator: [{ user_key: 'carol' }],
                updated_at: '2026-10-29T02:00:00.000Z',
              },
            ],
          },
        ],
      })
    }
    if (args[0] === 'workitem' && args[1] === '+batch-get') {
      return result({
        summary: { total: 2, succeeded: 2, failed: 0 },
        results: [
          {
            work_item_id: '101',
            data: {
              name: '需求 A',
              work_item_fields: [
                { field_key: 'description', field_value: '来自飞书的需求描述' },
              ],
            },
          },
          {
            work_item_id: '201',
            data: { description: '来自飞书的缺陷描述' },
          },
        ],
      })
    }
    throw new Error(`unexpected args: ${args.join(' ')}`)
  }

  await assertMeegleAuthenticated(config, runner)
  const output = await fetchMeegleWorkItems(config, runner)

  assert.equal(output.fetched, 3)
  assert.equal(output.skipped, 0)
  assert.deepEqual(
    output.items.map((item) => ({
      externalId: item.externalId,
      type: item.type,
      title: item.title,
      description: item.description,
      priority: item.priority,
      owner: item.owner,
    })),
    [
      {
        externalId: 'rjcloud:story:101',
        type: 'requirement',
        title: '需求 A',
        description: '来自飞书的需求描述',
        priority: '高',
        owner: 'Alice',
      },
      {
        externalId: 'rjcloud:story:102',
        type: 'requirement',
        title: '需求 B',
        description: '需求 B',
        priority: '中',
        owner: 'Bob',
      },
      {
        externalId: 'rjcloud:issue:201',
        type: 'defect',
        title: '缺陷 A',
        description: '来自飞书的缺陷描述',
        priority: '紧急',
        owner: 'carol',
      },
    ],
  )
  assert.equal(
    calls.every(({ env }) => env.MEEGLE_HOST === 'project.feishu.cn'),
    true,
  )
  assert.equal(
    calls.some(({ args }) => args.includes('--group-pagination-list')),
    false,
  )
})

test('Meegle CLI 客户端按 session_id 拉取后续分页', async () => {
  const firstPageRows = Array.from({ length: 50 }, (_, index) => ({
    work_item_id: String(index + 1),
    name: `需求 ${index + 1}`,
    priority: '中',
    updated_at: '2026-10-29T01:00:00.000Z',
  }))
  const calls: string[][] = []
  const runner: MeegleCommandRunner = async (_command, args) => {
    calls.push(args)
    if (args[0] === 'workitem' && args[1] === 'query') {
      if (args.includes('--session-id')) {
        assert.equal(args[args.indexOf('--session-id') + 1], 'session-1')
        assert.deepEqual(JSON.parse(args[args.indexOf('--group-pagination-list') + 1]), [
          { group_id: '1', page_num: 2 },
        ])
        return result({
          list: [{ count: 51, data: [{ work_item_id: '51', name: '需求 51' }] }],
        })
      }
      if (args[args.indexOf('--mql') + 1].includes('`story`')) {
        return result({
          session_id: 'session-1',
          list: [{ count: 51, group_infos: [{ group_id: '1' }], data: firstPageRows }],
        })
      }
      return result({ list: [{ count: 0, data: [] }] })
    }
    throw new Error(`unexpected args: ${args.join(' ')}`)
  }

  const output = await fetchMeegleWorkItems(
    { ...config, fetchDescriptions: false },
    runner,
  )

  assert.equal(output.items.length, 51)
  assert.equal(output.items.at(-1)?.externalId, 'rjcloud:story:51')
  assert.equal(calls.some((args) => args.includes('--session-id')), true)
})

test('未登录时返回明确的认证错误', async () => {
  const runner: MeegleCommandRunner = async () =>
    result({ authenticated: false, reason: 'no local token' }, 1)

  await assert.rejects(
    () => assertMeegleAuthenticated(config, runner),
    (error: unknown) =>
      error instanceof MeegleCliError && error.code === 'MEEGLE_NOT_AUTHENTICATED',
  )
})

test('增量过滤字段不可用时回退全量查询', async () => {
  let storyQueries = 0
  const runner: MeegleCommandRunner = async (_command, args) => {
    if (args[0] === 'auth') return result({ authenticated: true })
    if (args[0] === 'workitem' && args[1] === 'query') {
      if (args.includes('--mql') && args[args.indexOf('--mql') + 1].includes('`story`')) {
        storyQueries += 1
        if (storyQueries === 1) {
          return {
            stdout: '',
            stderr: 'unsupported field type updated_at',
            exitCode: 1,
          }
        }
        return result({ list: [{ count: 1, data: [{ work_item_id: '1', name: '需求 1' }] }] })
      }
      return result({ list: [{ count: 0, data: [] }] })
    }
    throw new Error(`unexpected args: ${args.join(' ')}`)
  }

  const output = await fetchMeegleWorkItems(
    { ...config, since: '2026-10-28', fetchDescriptions: false },
    runner,
  )
  assert.equal(output.items.length, 1)
  assert.match(output.warnings.join('\n'), /回退全量查询/)
})
