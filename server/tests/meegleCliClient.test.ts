import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertMeegleAuthenticated,
  buildMeegleWorkItemMql,
  fetchMeegleWorkItems,
  getMeegleAuthStatus,
  getMeegleWorkItem,
  MeegleCliError,
  queryMeegleWorkItems,
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
        assert.match(mql, /`field_c7834f`/)
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
      assert.match(mql, /`field_e1d325`/)
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
  assert.equal(output.complete, true)
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
  assert.equal(output.complete, true)
  assert.equal(calls.some((args) => args.includes('--session-id')), true)
})

test('Meegle CLI 解析 moql_field_list 真实响应并映射负责人与优先级', async () => {
  const runner: MeegleCommandRunner = async (_command, args) => {
    if (args[0] === 'workitem' && args[1] === 'query') {
      if (args[args.indexOf('--mql') + 1].includes('`story`')) {
        return result({
          session_id: 'story-session',
          list: [{ count: 1, group_infos: [{ group_id: '1' }] }],
          data: {
            '1': [
              {
                moql_field_list: [
                  { key: 'name', value: { string_value: '真实需求' }, value_type: 'string_value' },
                  {
                    key: 'work_item_status',
                    value: { key_label_value_list: [{ key: 'doing', label: '开发中' }] },
                    value_type: 'key_label_value_list',
                  },
                  {
                    key: 'priority',
                    value: { key_label_value_list: [{ key: 'P1', label: '高' }] },
                    value_type: 'key_label_value_list',
                  },
                  {
                    key: 'current_status_operator',
                    value: {
                      user_value_list: [
                        {
                          email: 'alice@example.com',
                          name_cn: 'Alice',
                          user_key: 'user-1',
                        },
                      ],
                    },
                    value_type: 'user_value_list',
                  },
                  {
                    key: 'field_c7834f',
                    value: {
                      key_label_value_list: [
                        { key: 'macc', label: 'MACC' },
                        { key: 'eweb', label: 'EWEB' },
                      ],
                    },
                    value_type: 'key_label_value_list',
                  },
                  { key: 'updated_at', value: { string_value: '2026-10-29' }, value_type: 'string_value' },
                  { key: 'description', value: { string_value: '来自查询的真实描述' }, value_type: 'string_value' },
                  { key: 'work_item_id', value: { long_value: 7141584505 }, value_type: 'long_value' },
                ],
              },
            ],
          },
        })
      }
      return result({ list: [{ count: 0 }], data: {} })
    }
    if (args[0] === 'workitem' && args[1] === '+batch-get') {
      throw new Error('description 已由 MQL 返回，不应再逐条查询详情')
    }
    throw new Error(`unexpected args: ${args.join(' ')}`)
  }

  const output = await fetchMeegleWorkItems(
    { ...config, fetchDescriptions: false },
    runner,
  )
  assert.equal(output.fetched, 1)
  assert.equal(output.skipped, 0)
  assert.deepEqual(output.items[0], {
    externalId: 'rjcloud:story:7141584505',
    type: 'requirement',
    title: '真实需求',
    description: '来自查询的真实描述',
    priority: '高',
    owner: 'Alice',
    status: '进行中',
    feishuStatus: '开发中',
    projectLine: 'MACC,EWEB',
    updatedAt: '2026-10-29T00:00:00.000Z',
  })
})

test('Meegle CLI 解析 key_label_value 形式的缺陷状态', async () => {
  const runner: MeegleCommandRunner = async (_command, args) => {
    if (args[0] === 'workitem' && args[1] === 'query') {
      if (args[args.indexOf('--mql') + 1].includes('`story`')) {
        return result({ list: [{ count: 0 }], data: {} })
      }
      return result({
        list: [{ count: 1, group_infos: [{ group_id: '1' }] }],
        data: {
          '1': [
            {
              moql_field_list: [
                { key: 'work_item_id', value: { long_value: 201 } },
                { key: 'name', value: { string_value: '真实缺陷' } },
                {
                  key: 'work_item_status',
                  value: { key_label_value: { key: 'RESOLVED', label: '已解决' } },
                  value_type: 'key_label_value',
                },
              ],
            },
          ],
        },
      })
    }
    throw new Error(`unexpected args: ${args.join(' ')}`)
  }

  const output = await fetchMeegleWorkItems({ ...config, fetchDescriptions: false }, runner)
  assert.equal(output.items.length, 1)
  assert.equal(output.items[0]?.status, '已交付')
  assert.equal(output.items[0]?.feishuStatus, '已解决')
})

test('Meegle CLI 将评审中与重新打开映射为进行中', async () => {
  const items = [
    {
      work_item_id: 301,
      name: '评审需求',
      work_item_status: { key_label_value: { key: 'REVIEW', label: '评审中' } },
    },
    {
      work_item_id: 302,
      name: '重新打开缺陷',
      work_item_status: { key_label_value: { key: 'REOPENED', label: '重新打开' } },
    },
  ]
  const runner: MeegleCommandRunner = async (_command, args) => {
    if (args[0] === 'workitem' && args[1] === 'query') {
      if (args[args.indexOf('--mql') + 1].includes('`story`')) {
        return result({
          list: [{ count: 2, group_infos: [{ group_id: '1' }] }],
          data: {
            '1': items.map((item) => ({
              moql_field_list: [
                { key: 'work_item_id', value: { long_value: item.work_item_id } },
                { key: 'name', value: { string_value: item.name } },
                { key: 'work_item_status', value: item.work_item_status },
              ],
            })),
          },
        })
      }
      return result({ list: [{ count: 0 }], data: {} })
    }
    throw new Error(`unexpected args: ${args.join(' ')}`)
  }

  const output = await fetchMeegleWorkItems({ ...config, fetchDescriptions: false }, runner)
  assert.deepEqual(
    output.items.map((item) => ({ status: item.status, feishuStatus: item.feishuStatus })),
    [
      { status: '进行中', feishuStatus: '评审中' },
      { status: '进行中', feishuStatus: '重新打开' },
    ],
  )
})

test('Meegle CLI 对超长标题、描述和负责人做安全截断', async () => {
  const runner: MeegleCommandRunner = async (_command, args) => {
    if (args[0] === 'workitem' && args[1] === 'query') {
      if (args[args.indexOf('--mql') + 1].includes('`story`')) {
        return result({
          list: [{ count: 1, group_infos: [{ group_id: '1' }] }],
          data: {
            '1': [
              {
                moql_field_list: [
                  { key: 'name', value: { string_value: '标'.repeat(350) } },
                  {
                    key: 'current_status_operator',
                    value: { user_value_list: [{ name_cn: '负责人'.repeat(40) }] },
                  },
                  { key: 'work_item_id', value: { long_value: 42 } },
                ],
              },
            ],
          },
        })
      }
      return result({ list: [{ count: 0 }], data: {} })
    }
    if (args[0] === 'workitem' && args[1] === '+batch-get') {
      return result({
        results: [
          {
            work_item_id: '42',
            data: { description: '😀'.repeat(20_000) },
          },
        ],
      })
    }
    throw new Error(`unexpected args: ${args.join(' ')}`)
  }

  const output = await fetchMeegleWorkItems(config, runner)
  assert.equal(output.items.length, 1)
  assert.equal(Array.from(output.items[0]?.title ?? '').length, 300)
  assert.equal((output.items[0]?.description ?? '').length <= 20_000, true)
  assert.equal(Array.from(output.items[0]?.owner ?? '').length, 100)
})

test('缺少分页会话时标记为不完整，禁止执行删除对账', async () => {
  const runner: MeegleCommandRunner = async (_command, args) => {
    if (args[0] === 'workitem' && args[1] === 'query') {
      if (args[args.indexOf('--mql') + 1].includes('`story`')) {
        return result({
          list: [
            {
              count: 100,
              data: [{ work_item_id: '1', name: '需求 1' }],
            },
          ],
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
  assert.equal(output.complete, false)
  assert.match(output.warnings.join('\n'), /缺少 session_id/)
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

test('Meegle MCP 查询构造标题、状态、负责人和日期过滤', () => {
  const mql = buildMeegleWorkItemMql('rjcloud', 'story', 'field_c7834f', {
    search: "家用 O'Reilly_100%",
    status: '规划中',
    owner: '黄冰洋',
    since: '2026-10-01',
  })
  assert.match(mql, /FROM `rjcloud`\.`story`/)
  assert.match(mql, /`archiving_date` IS NULL/)
  assert.match(mql, /`updated_at` >= '2026-10-01'/)
  assert.match(mql, /`name` LIKE '%家用 O\\'Reilly\\_100\\%%'/)
  assert.match(mql, /`work_item_status` = '规划中'/)
  assert.match(mql, /`current_status_operator` = '黄冰洋'/)
  assert.match(mql, /LIMIT 50$/)
})

test('Meegle MCP 按需查询实时工作项并返回详情链接', async () => {
  const calls: string[][] = []
  const runner: MeegleCommandRunner = async (_command, args) => {
    calls.push(args)
    const mql = args.includes('--mql') ? args[args.indexOf('--mql') + 1] : ''
    if (mql.includes('`story`')) {
      return result({
        session_id: 'session-1',
        list: [{ count: 1, group_infos: [{ group_id: '1' }] }],
        data: {
          '1': [{
            moql_field_list: [
              { key: 'work_item_id', value: { long_value: 7141333577 } },
              { key: 'name', value: { string_value: '家用路由器需求' } },
              { key: 'work_item_status', value: { key_label_value_list: [{ label: '规划中' }] } },
              { key: 'current_status_operator', value: { user_value_list: [{ name_cn: '黄冰洋' }] } },
              { key: 'description', value: { string_value: '实时描述' } },
              { key: 'updated_at', value: { string_value: '2026-10-30' } },
            ],
          }],
        },
      })
    }
    return result({ list: [{ count: 0, data: [] }] })
  }

  const output = await queryMeegleWorkItems(
    config,
    { type: 'requirement', search: '家用', status: '规划中', owner: '黄冰洋', limit: 10 },
    runner,
  )
  assert.equal(output.total, 1)
  assert.equal(output.fetched, 1)
  assert.equal(output.items.length, 1)
  assert.deepEqual(
    {
      workItemId: output.items[0]?.workItemId,
      title: output.items[0]?.title,
      status: output.items[0]?.feishuStatus,
      owner: output.items[0]?.owner,
      url: output.items[0]?.url,
    },
    {
      workItemId: '7141333577',
      title: '家用路由器需求',
      status: '规划中',
      owner: '黄冰洋',
      url: 'https://project.feishu.cn/rjcloud/story/detail/7141333577',
    },
  )
  assert.equal(calls.some((args) => args.includes('--mql')), true)
})

test('Meegle MCP 按 ID 读取实时详情且不返回 Token', async () => {
  const runner: MeegleCommandRunner = async (_command, args) => {
    assert.deepEqual(args, [
      'workitem',
      'get',
      '--project-key',
      'rjcloud',
      '--work-item-id',
      '7141333577',
      '--format',
      'json',
    ])
    return result({
      work_item_attribute: { work_item_id: '7141333577', work_item_name: '实时需求' },
      work_item_fields: [{ key: 'description', value: '实时详情' }],
    })
  }
  const payload = await getMeegleWorkItem(config, '7141333577', runner)
  assert.match(JSON.stringify(payload), /实时详情/)
  assert.equal(JSON.stringify(payload).includes('access_token'), false)
})

test('Meegle MCP 登录状态只返回脱敏结果', async () => {
  const status = await getMeegleAuthStatus(config, async () =>
    result({ authenticated: true, access_token: 'must-not-leak' }),
  )
  assert.deepEqual(status, { authenticated: true, host: 'project.feishu.cn' })
})
