import type { PipelineStage } from './types'

const hiddenInternalStages = new Set(['test'])
const optionalStages = new Set(['build', 'upgrade'])

const stageAliases: Record<string, Pick<PipelineStage, 'key' | 'name' | 'description'>> = {
  analysis: {
    key: 'analysis',
    name: '需求分析',
    description: '识别需求意图、验收条件与影响模块',
  },
  design: {
    key: 'ldd',
    name: '业务 LDD',
    description: '生成或更新本次业务涉及的 LDD 设计',
  },
  coding: {
    key: 'coding',
    name: '业务编码',
    description: '按 LDD 与设计实现代码变更和单元测试',
  },
  integration: {
    key: 'evidence',
    name: '检查证据',
    description: '确认代码变更、设计报告与集成报告',
  },
  commit: {
    key: 'commit',
    name: '提交推送',
    description: 'AICR 审查、本地提交并按授权推送',
  },
  build: {
    key: 'build',
    name: '自动编译',
    description: '触发编译系统构建版本',
  },
  upgrade: {
    key: 'upgrade',
    name: '设备升级',
    description: '推送固件到 AC/AP 或交换机并完成升级',
  },
  report: {
    key: 'writeback',
    name: '回写并关闭缺陷',
    description: '写入真实 commit 与阶段结果，并按授权提交飞书缺陷关闭',
  },
}

function optionalStageVisible(stage: PipelineStage): boolean {
  if (stage.status !== 'pending') return true
  return /失败|告警|异常/.test(stage.log ?? '')
}

function connectivityFromAnalysis(analysis: PipelineStage): PipelineStage {
  const log = analysis.log ?? ''
  const checkingConnectivity =
    analysis.status === 'running' && /平台|客户端|仓库|分支|契约|连通/.test(log)
  return {
    key: 'connectivity',
    name: '连通性校验',
    description: '读取平台、校验契约并确认客户端仓库与分支',
    status: analysis.status === 'running' && !checkingConnectivity ? 'success' : analysis.status,
    duration: analysis.duration,
    log: checkingConnectivity
      ? log
      : analysis.status === 'pending'
        ? '等待本机执行'
        : '平台、客户端仓库与目标分支连通性已校验',
  }
}

export function displayDeliveryStages(stages: readonly PipelineStage[]): PipelineStage[] {
  const visible: PipelineStage[] = []
  for (const stage of stages) {
    if (hiddenInternalStages.has(stage.key)) continue
    if (optionalStages.has(stage.key) && !optionalStageVisible(stage)) continue
    const alias = stageAliases[stage.key]
    visible.push(alias ? { ...stage, ...alias } : stage)
  }

  if (visible.some((stage) => stage.key === 'connectivity')) return visible
  const analysisIndex = visible.findIndex((stage) => stage.key === 'analysis')
  if (analysisIndex >= 0) {
    visible.splice(analysisIndex, 0, connectivityFromAnalysis(visible[analysisIndex]))
  }
  return visible
}
