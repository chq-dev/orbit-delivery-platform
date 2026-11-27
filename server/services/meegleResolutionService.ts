import { spawnSync } from 'node:child_process'
import type { DefectResolution } from '../domain/types.js'
import { parseFeishuExternalId } from './deliveryFeishuContext.js'

export type MeegleJsonRunner = (args: string[]) => unknown

function parseJsonOutput(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

export function runMeegleJson(args: string[]): unknown {
  const command = process.env.MEEGLE_BIN?.trim() || 'meegle'
  const result = spawnSync(command, [...args, '--format', 'json'], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  })
  if (result.error) throw new Error(`执行 Meegle CLI 失败：${result.error.message}`)
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().slice(-2_000)
    throw new Error(`Meegle CLI 退出码 ${result.status}：${detail || '未返回错误详情'}`)
  }
  const payload = parseJsonOutput(result.stdout ?? '')
  if (payload === undefined) throw new Error('Meegle CLI 未返回可解析的 JSON')
  return payload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (isRecord(value)) {
    for (const key of ['label', 'name', 'text', 'value', 'key', 'option_name', 'option_id']) {
      const text = scalarText(value[key])
      if (text) return text
    }
  }
  return ''
}

export function buildMeegleResolutionFields(
  metadata: unknown,
  resolution: DefectResolution,
): Array<{ field_key: string; field_value: unknown }> {
  const fields = isRecord(metadata) && Array.isArray(metadata.list)
    ? metadata.list.filter(isRecord)
    : []
  const findField = (key: string, name: string) =>
    fields.find((field) => scalarText(field.field_key) === key) ??
    fields.find((field) => scalarText(field.field_name) === name)
  const selectValue = (
    field: Record<string, unknown> | undefined,
    label: string,
  ): unknown => {
    const options = field && Array.isArray(field.option) ? field.option.filter(isRecord) : []
    const option = options.find((item) => scalarText(item.option_name) === label)
    const value = option ? scalarText(option.option_id) : ''
    return value ? { label, value } : undefined
  }
  const result: Array<{ field_key: string; field_value: unknown }> = []
  const add = (key: string, name: string, value: unknown) => {
    const field = findField(key, name)
    if (!field || value === undefined) return
    result.push({ field_key: scalarText(field.field_key), field_value: value })
  }
  add(
    'field_880d7e',
    '是否遗留BUG',
    selectValue(findField('field_880d7e', '是否遗留BUG'), resolution.legacyBug ? '是' : '否'),
  )
  add(
    'field_e34974',
    '是否修订引入',
    selectValue(findField('field_e34974', '是否修订引入'), resolution.introduced ? '是' : '否'),
  )
  add('field_953b68', '解决方案', resolution.solution?.trim())
  add('field_462c75', '根因分析', resolution.rootCause?.trim())
  add('field_b70e69', '影响面分析', resolution.impact?.trim())
  return result
}

export function resolveMeegleDefect(
  externalId: string,
  resolution: DefectResolution,
  runner: MeegleJsonRunner = runMeegleJson,
): Record<string, unknown> {
  const target = parseFeishuExternalId(externalId)
  if (!target) throw new Error(`无法解析飞书缺陷标识：${externalId}`)
  const transitions = runner([
    'workflow',
    'list-state-transitions',
    '--project-key',
    target.projectKey,
    '--work-item-id',
    target.workItemId,
    '--work-item-type',
    target.typeKey,
  ])
  const currentState = isRecord(transitions) ? scalarText(transitions.state_key) : ''
  const metadata = runner([
    'workitem',
    'meta-fields',
    '--project-key',
    target.projectKey,
    '--work-item-type',
    target.typeKey,
  ])
  const fields = buildMeegleResolutionFields(metadata, resolution)
  if (fields.length < 5) {
    throw new Error('飞书缺陷字段配置不完整，无法写入是否遗留、是否修订引入、解决方案、根因分析和影响面')
  }
  if (currentState.toUpperCase() === 'RESOLVED') {
    runner([
      'workitem',
      'update',
      '--project-key',
      target.projectKey,
      '--work-item-id',
      target.workItemId,
      '--params',
      JSON.stringify({ fields }),
    ])
    return {
      alreadyResolved: true,
      fieldsUpdated: true,
      stateKey: currentState,
      stateName: scalarText(isRecord(transitions) ? transitions.state_name : ''),
    }
  }
  const candidates = isRecord(transitions) && Array.isArray(transitions.transition)
    ? transitions.transition.filter(isRecord)
    : []
  const transition = candidates.find((item) => {
    const key = scalarText(item.state_key)
    const name = scalarText(item.state_name)
    return key.toUpperCase() === 'RESOLVED' || /已解决/.test(name)
  })
  if (!transition) throw new Error('飞书缺陷工作流中未找到流转到“已解决”的操作')
  const transitionId = scalarText(transition.id ?? transition.transition_id)
  if (!transitionId) throw new Error('飞书缺陷“已解决”流转缺少 transition_id')

  const result = runner([
    'workflow',
    'transition-state',
    '--project-key',
    target.projectKey,
    '--work-item-id',
    target.workItemId,
    '--transition-id',
    transitionId,
    '--params',
    JSON.stringify({ fields }),
  ])
  return {
    alreadyResolved: false,
    fieldsUpdated: true,
    stateKey: scalarText(transition.state_key),
    stateName: scalarText(transition.state_name),
    transitionId,
    result: isRecord(result) ? result : undefined,
  }
}
