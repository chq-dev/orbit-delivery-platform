import type {
  Account,
  PipelineRun,
  PipelineReport,
  PipelineStage,
  PlatformMeta,
  Priority,
  Repository,
  TestReport,
  WorkItem,
} from './types'

export const platformLinks = {
  gitRepository: 'http://cloudgit.rj.link/sme/sme-main.git',
  feishuIssue: 'https://project.feishu.cn/rjcloud/issue/homepage',
  feishuStory: 'https://project.feishu.cn/rjcloud/story/homepage',
} as const

export interface FeishuInboxItem {
  externalId: string
  type: 'requirement' | 'defect'
  title: string
  description: string
  priority: Priority
  repoId: string
  owner: string
  updatedAt: string
}

export const feishuInbox: FeishuInboxItem[] = [
  {
    externalId: 'STORY-2418',
    type: 'requirement',
    title: 'AC 下 AP 在线状态增加分组视图',
    description: '在 AC 管理页面按 AP 分组展示在线状态、射频负载与最近心跳，支持快速定位离线 AP。',
    priority: '高',
    repoId: 'repo-control',
    owner: '陈华',
    updatedAt: '12 分钟前',
  },
  {
    externalId: 'STORY-2415',
    type: 'requirement',
    title: '升级任务支持批量重试',
    description: 'AC/AP 与交换机批量升级失败后，允许仅对失败设备发起重试，并保留原任务批次与日志。',
    priority: '中',
    repoId: 'repo-control',
    owner: '林晓',
    updatedAt: '46 分钟前',
  },
  {
    externalId: 'STORY-2409',
    type: 'requirement',
    title: '测试报告增加设备型号与固件版本对比',
    description: '支持选择两个历史固件版本对比通过率、失败用例和耗时变化，并区分交换机与 AP 型号。',
    priority: '低',
    repoId: 'repo-control',
    owner: '苏悦',
    updatedAt: '2 小时前',
  },
  {
    externalId: 'ISSUE-836',
    type: 'defect',
    title: '升级后 PoE 端口周期掉电',
    description: '交换机升级至最新版本后，约每 30 分钟出现一次 PoE 端口掉电告警，需要定位升级前后的端口状态轮询差异。',
    priority: '紧急',
    repoId: 'repo-control',
    owner: '周明',
    updatedAt: '8 分钟前',
  },
  {
    externalId: 'ISSUE-829',
    type: 'defect',
    title: '测试报告导出缺少设备序列号',
    description: '导出的 Markdown 报告未包含交换机/AP 型号、设备序列号与固件版本。',
    priority: '高',
    repoId: 'repo-control',
    owner: '陈华',
    updatedAt: '1 小时前',
  },
  {
    externalId: 'ISSUE-824',
    type: 'defect',
    title: '流水线取消后按钮状态未恢复',
    description: '取消执行中的流水线后，启动按钮仍保持禁用状态，刷新页面后才能恢复。',
    priority: '中',
    repoId: 'repo-control',
    owner: '林晓',
    updatedAt: '昨天 17:42',
  },
]

export const platformMeta: Record<string, PlatformMeta> = {
  git: {
    key: 'git',
    name: 'Git 代码仓库',
    description: 'GitLab / GitHub / Gitee',
    color: '#f97316',
    softColor: '#fff4e8',
    shortName: 'Git',
  },
  feishu: {
    key: 'feishu',
    name: '飞书协作',
    description: 'rjcloud · 需求与缺陷',
    color: '#3370ff',
    softColor: '#edf3ff',
    shortName: '飞书',
  },
  build: {
    key: 'build',
    name: '编译系统',
    description: 'sm-web 与 RGOS 构建产物',
    color: '#8b5cf6',
    softColor: '#f4efff',
    shortName: '编译',
  },
  device: {
    key: 'device',
    name: '设备管理',
    description: 'AC/AP 与交换机固件升级',
    color: '#0f9f87',
    softColor: '#e9faf6',
    shortName: '设备',
  },
}

const stageDefinitions: Omit<PipelineStage, 'status'>[] = [
  {
    key: 'analysis',
    name: '需求解析',
    description: '识别需求意图、验收条件与影响模块',
  },
  {
    key: 'design',
    name: '开发设计报告',
    description: '生成技术方案、改动范围与测试策略',
  },
  {
    key: 'coding',
    name: '自动需求编码',
    description: '按设计报告生成代码变更与单元测试',
  },
  {
    key: 'integration',
    name: '集成验证报告',
    description: '合并变更并输出依赖、接口与风险结论',
  },
  {
    key: 'commit',
    name: '提交代码',
    description: '提交变更至目标分支并关联工作项',
  },
  {
    key: 'build',
    name: '自动编译',
    description: '触发编译系统构建版本',
  },
  {
    key: 'upgrade',
    name: '设备升级',
    description: '推送固件到 AC/AP 或交换机并完成升级',
  },
  {
    key: 'test',
    name: '自动化测试',
    description: '执行冒烟与全量回归测试',
  },
  {
    key: 'report',
    name: '测试报告归档',
    description: '生成测试报告并关闭缺陷',
  },
]

export function createStages(completed = 0, running = -1, failed = -1): PipelineStage[] {
  return stageDefinitions.map((stage, index) => ({
    ...stage,
    status:
      index === failed
        ? 'failed'
        : index < completed
          ? 'success'
          : index === running
            ? 'running'
            : 'pending',
    duration: index < completed ? `${3 + index * 2}m ${12 + index * 7}s` : undefined,
  }))
}

type PipelineReportInput = Pick<
  PipelineRun,
  'id' | 'workItemId' | 'title' | 'repoName' | 'branch' | 'version'
>

export function createDesignReport(
  run: PipelineReportInput,
  createdAt = '刚刚',
): PipelineReport {
  const reportId = run.id.replace('RUN-', '')
  return {
    id: `DESIGN-${reportId}`,
    title: '开发设计报告',
    summary: `已完成「${run.title}」的影响分析、技术方案与测试策略设计`,
    createdAt,
    sections: [
      {
        title: '需求理解',
        content: `关联工作项 ${run.workItemId}。需求目标已拆解为网络配置验收条件，覆盖创建、修改、删除、参数边界、设备回显、升级后配置保留与回滚场景。`,
      },
      {
        title: '技术方案',
        content: `在 ${run.repoName}/${run.branch} 上评估 web/ 与 lua/ 改动：Vue 3 页面与联邦组件负责配置交互，LuCI api/service/middle 层负责参数校验和 RGOS CLI/JSON 转换，沿用现有设备配置接口契约。`,
      },
      {
        title: '影响范围',
        content: '预计影响 4 个网络业务模块、6 个文件，涉及配置模型、CLI 转换与页面表单；新增字段保持向后兼容，无数据库结构变更。',
      },
      {
        title: '测试策略',
        content: '优先执行 Vue/Lua 单测与静态检查，再覆盖配置 CRUD、CLI 回显一致性、AC/AP 联动、VLAN/DHCP 边界校验以及升级后配置保留与回滚。',
      },
    ],
  }
}

export function createIntegrationReport(
  run: PipelineReportInput,
  createdAt = '刚刚',
): PipelineReport {
  const reportId = run.id.replace('RUN-', '')
  return {
    id: `INTEGRATION-${reportId}`,
    title: '集成报告',
    summary: `代码已完成集成验证，未发现阻塞性冲突，可以提交至 ${run.branch}`,
    createdAt,
    sections: [
      {
        title: '集成结果',
        content: `基于 ${run.branch} 的最新提交完成合并预演，0 个冲突，变更可干净应用。`,
      },
      {
        title: '静态检查',
        content: 'Vue TypeScript 类型检查、Lua 单测、代码规范与依赖漏洞扫描全部通过；无新增高危依赖。',
      },
      {
        title: '接口兼容性',
        content: 'REST/JSON-RPC 接口与设备配置 JSON 保持兼容，新增字段均为可选；旧固件返回结构可继续解析。',
      },
      {
        title: '风险结论',
        content: '集成风险低。建议在提交后立即触发固件编译，并在 AC/AP 与交换机测试床验证升级、配置下发和回滚。',
      },
    ],
  }
}

export const initialRepositories: Repository[] = [
  {
    id: 'repo-control',
    name: 'sme-main',
    url: platformLinks.gitRepository,
    branch: 'develop',
    language: 'Vue 3 + Lua',
    accountId: 'acc-git-main',
    lastSync: '3 分钟前',
    status: 'healthy',
    latestVersion: 'v12.0.3-rc.18',
  },
]

export const initialAccounts: Account[] = [
  {
    id: 'acc-git-main',
    platform: 'git',
    username: 'chen.hua',
    label: '主研发账号',
    secretHint: '••••••••7K2m',
    status: 'active',
    createdAt: '2026-09-18',
  },
  {
    id: 'acc-git-ci',
    platform: 'git',
    username: 'rjcloud-ci-bot',
    label: 'CI 自动化账号',
    secretHint: '••••••••9Qa1',
    status: 'active',
    createdAt: '2026-08-03',
  },
  {
    id: 'acc-feishu-main',
    platform: 'feishu',
    username: 'quality@rjcloud.com',
    label: '质量中心',
    secretHint: '••••••••',
    status: 'active',
    createdAt: '2026-07-21',
  },
  {
    id: 'acc-build-main',
    platform: 'build',
    username: 'build-service-01',
    label: '编译服务账号',
    secretHint: '••••••••1X8s',
    status: 'active',
    createdAt: '2026-06-12',
  },
  {
    id: 'acc-device-lab',
    platform: 'device',
    username: 'lab-ac03',
    label: 'AC/AP 测试床 03',
    secretHint: '••••••••2Lp',
    status: 'expiring',
    createdAt: '2026-03-09',
  },
]

export const initialWorkItems: WorkItem[] = [
  {
    id: 'REQ-1082',
    type: 'requirement',
    title: '交换机 VLAN 配置支持批量导入',
    description: '支持从 CSV 批量导入 VLAN、SVI 与 DHCP 地址池配置，校验 VLAN ID 重复、地址池重叠和 SVI 地址冲突。',
    priority: '高',
    status: '进行中',
    repoId: 'repo-control',
    branch: 'develop',
    owner: '陈华',
    updatedAt: '今天 10:42',
    createdAt: '2026-10-24',
  },
  {
    id: 'REQ-1079',
    type: 'requirement',
    title: 'AP 分组支持批量下发射频模板',
    description: '在 AC 管理页面按 AP 分组批量下发 2.4G/5G 射频模板，并展示下发进度与失败原因。',
    priority: '中',
    status: '待处理',
    repoId: 'repo-control',
    branch: 'develop',
    owner: '林晓',
    updatedAt: '今天 09:18',
    createdAt: '2026-10-23',
  },
  {
    id: 'BUG-236',
    type: 'defect',
    title: 'PoE 端口供电状态偶发误报',
    description: '交换机连续插拔受电设备后，部分端口上报 PoE 掉电告警但实际供电正常，需要校准端口状态轮询与告警抑制。',
    priority: '紧急',
    status: '待处理',
    repoId: 'repo-control',
    branch: 'develop',
    owner: '周明',
    updatedAt: '昨天 18:30',
    createdAt: '2026-10-25',
  },
  {
    id: 'BUG-228',
    type: 'defect',
    title: '无线终端漫游后无法续租地址',
    description: '终端在 AP 间漫游后偶发无法重新获取 DHCP 地址，需要排查 CAPWAP 隧道、VLAN 映射与 DHCP 中继状态。',
    priority: '高',
    status: '进行中',
    repoId: 'repo-control',
    branch: 'develop',
    owner: '陈华',
    updatedAt: '昨天 16:04',
    createdAt: '2026-10-22',
  },
  {
    id: 'REQ-1071',
    type: 'requirement',
    title: 'WLAN 黑名单支持批量导入',
    description: '支持 CSV 批量导入终端 MAC 到无线动态黑名单，并同步到 AC 与在线 AP。',
    priority: '中',
    status: '已交付',
    repoId: 'repo-control',
    branch: 'develop',
    owner: '林晓',
    updatedAt: '10 月 23 日',
    createdAt: '2026-10-18',
  },
  {
    id: 'BUG-219',
    type: 'defect',
    title: '端口镜像配置升级后丢失',
    description: '交换机从旧版本升级后，镜像会话配置未恢复，需要补齐配置迁移与回滚验证。',
    priority: '中',
    status: '已关闭',
    repoId: 'repo-control',
    branch: 'develop',
    owner: '周明',
    updatedAt: '10 月 21 日',
    createdAt: '2026-10-17',
  },
]

export const initialPipelines: PipelineRun[] = [
  {
    id: 'RUN-2409',
    workItemId: 'REQ-1082',
    title: '交换机 VLAN 配置支持批量导入',
    itemType: 'requirement',
    repoId: 'repo-control',
    repoName: 'sme-main',
    branch: 'develop',
    commit: 'a8f3c72',
    version: 'v12.0.3-rc.18',
    status: 'running',
    progress: 68,
    currentStage: 6,
    stages: createStages(6, 6).map((stage, index) =>
      index === 6
        ? { ...stage, duration: '02m 14s', log: '正在向 AC/AP 测试床 03 推送固件，已完成 3/5 台设备升级' }
        : index === 0
          ? { ...stage, log: '识别到 4 个影响模块：VLAN、SVI、DHCP 地址池、配置校验' }
          : index === 1
            ? { ...stage, log: '开发设计报告已生成：4 个影响模块，技术方案与测试策略已确认' }
            : index === 2
              ? { ...stage, log: '自动编码完成：6 个文件变更，新增 12 个单元测试' }
              : index === 3
                ? { ...stage, log: '集成报告已生成：0 个冲突，接口兼容性与静态检查通过' }
                : index === 4
                  ? { ...stage, log: '分支 develop 已提交 3 个文件，变更 +186 / -42' }
                  : index === 5
                    ? { ...stage, log: '编译成功，产物 rgos12x-v12.0.3-rc.18.bin（286MB）' }
                    : stage,
    ),
    designReport: createDesignReport(
      {
        id: 'RUN-2409',
        workItemId: 'REQ-1082',
        title: '交换机 VLAN 配置支持批量导入',
        repoName: 'sme-main',
        branch: 'develop',
        version: 'v12.0.3-rc.18',
      },
      '今天 10:44',
    ),
    integrationReport: createIntegrationReport(
      {
        id: 'RUN-2409',
        workItemId: 'REQ-1082',
        title: '交换机 VLAN 配置支持批量导入',
        repoName: 'sme-main',
        branch: 'develop',
        version: 'v12.0.3-rc.18',
      },
      '今天 10:48',
    ),
    createdAt: '今天 10:42',
    triggeredBy: '陈华',
    autoCommit: true,
    autoClose: true,
    simulation: false,
  },
  {
    id: 'RUN-2408',
    workItemId: 'BUG-228',
    title: '无线终端漫游后无法续租地址',
    itemType: 'defect',
    repoId: 'repo-control',
    repoName: 'sme-main',
    branch: 'develop',
    commit: 'f31b09e',
    version: 'v12.0.3-rc.17',
    status: 'success',
    progress: 100,
    currentStage: 9,
    stages: createStages(9),
    designReport: createDesignReport(
      {
        id: 'RUN-2408',
        workItemId: 'BUG-228',
        title: '无线终端漫游后无法续租地址',
        repoName: 'sme-main',
        branch: 'develop',
        version: 'v12.0.3-rc.17',
      },
      '今天 09:32',
    ),
    integrationReport: createIntegrationReport(
      {
        id: 'RUN-2408',
        workItemId: 'BUG-228',
        title: '无线终端漫游后无法续租地址',
        repoName: 'sme-main',
        branch: 'develop',
        version: 'v12.0.3-rc.17',
      },
      '今天 09:37',
    ),
    createdAt: '今天 09:26',
    triggeredBy: '陈华',
    autoCommit: true,
    autoClose: true,
    simulation: false,
  },
  {
    id: 'RUN-2407',
    workItemId: 'REQ-1071',
    title: 'WLAN 黑名单支持批量导入',
    itemType: 'requirement',
    repoId: 'repo-control',
    repoName: 'sme-main',
    branch: 'develop',
    commit: '9d2eab1',
    version: 'v12.0.3-rc.16',
    status: 'success',
    progress: 100,
    currentStage: 9,
    stages: createStages(9),
    designReport: createDesignReport(
      {
        id: 'RUN-2407',
        workItemId: 'REQ-1071',
        title: 'WLAN 黑名单支持批量导入',
        repoName: 'sme-main',
        branch: 'develop',
        version: 'v12.0.3-rc.16',
      },
      '昨天 17:54',
    ),
    integrationReport: createIntegrationReport(
      {
        id: 'RUN-2407',
        workItemId: 'REQ-1071',
        title: 'WLAN 黑名单支持批量导入',
        repoName: 'sme-main',
        branch: 'develop',
        version: 'v12.0.3-rc.16',
      },
      '昨天 17:59',
    ),
    createdAt: '昨天 17:48',
    triggeredBy: '林晓',
    autoCommit: true,
    autoClose: true,
    simulation: false,
  },
  {
    id: 'RUN-2406',
    workItemId: 'BUG-219',
    title: '端口镜像配置升级后丢失',
    itemType: 'defect',
    repoId: 'repo-control',
    repoName: 'sme-main',
    branch: 'develop',
    commit: '71bc0dd',
    version: 'v12.0.3-rc.15',
    status: 'failed',
    progress: 56,
    currentStage: 5,
    stages: createStages(5, -1, 5).map((stage, index) =>
      index === 5
        ? {
            ...stage,
            duration: '01m 08s',
            log: '编译失败：lua/luci/modules/monitor_session/middle/json2cli.lua:87 attempt to index a nil value (local `session`)',
          }
        : stage,
    ),
    designReport: createDesignReport(
      {
        id: 'RUN-2406',
        workItemId: 'BUG-219',
        title: '端口镜像配置升级后丢失',
        repoName: 'sme-main',
        branch: 'develop',
        version: 'v12.0.3-rc.15',
      },
      '10 月 21 日 14:18',
    ),
    integrationReport: createIntegrationReport(
      {
        id: 'RUN-2406',
        workItemId: 'BUG-219',
        title: '端口镜像配置升级后丢失',
        repoName: 'sme-main',
        branch: 'develop',
        version: 'v12.0.3-rc.15',
      },
      '10 月 21 日 14:24',
    ),
    createdAt: '10 月 21 日',
    triggeredBy: '周明',
    autoCommit: true,
    autoClose: true,
    simulation: false,
  },
]

export const initialReports: TestReport[] = [
  {
    id: 'TR-2408',
    pipelineId: 'RUN-2408',
    project: 'sme-main',
    version: 'v12.0.3-rc.17',
    createdAt: '今天 09:44',
    status: 'passed',
    total: 386,
    passed: 377,
    failed: 6,
    skipped: 3,
    duration: '18m 42s',
    suites: [
      { name: 'WLAN 接入与漫游', total: 128, passed: 126, failed: 2, duration: '6m 12s' },
      { name: 'DHCP 地址分配', total: 86, passed: 86, failed: 0, duration: '4m 38s' },
      { name: 'VLAN 与端口转发', total: 94, passed: 91, failed: 3, duration: '3m 26s' },
      { name: '升级与异常恢复', total: 78, passed: 74, failed: 1, duration: '4m 26s' },
    ],
    failedCases: [
      {
        name: '终端跨 AP 漫游后续租',
        suite: 'DHCP 地址分配',
        reason: '第 18 次漫游后 DHCP DISCOVER 超时 1.2s，超过 800ms 基线',
      },
      {
        name: '升级后 CAPWAP 隧道重建',
        suite: '升级与异常恢复',
        reason: 'AC 重启后 2 台 AP 的 CAPWAP 隧道重建超过 30s',
      },
    ],
  },
  {
    id: 'TR-2407',
    pipelineId: 'RUN-2407',
    project: 'sme-main',
    version: 'v12.0.3-rc.16',
    createdAt: '昨天 18:06',
    status: 'passed',
    total: 384,
    passed: 380,
    failed: 2,
    skipped: 2,
    duration: '17m 55s',
    suites: [
      { name: 'WLAN 黑名单配置', total: 112, passed: 111, failed: 1, duration: '5m 40s' },
      { name: 'AC 与云端配置同步', total: 82, passed: 81, failed: 1, duration: '3m 14s' },
      { name: 'VLAN 与端口转发', total: 94, passed: 94, failed: 0, duration: '3m 26s' },
      { name: '异常恢复测试', total: 96, passed: 94, failed: 0, duration: '5m 35s' },
    ],
    failedCases: [
      {
        name: '黑名单批量导入跨 AC 同步',
        suite: 'AC 与云端配置同步',
        reason: '备用 AC 的配置缓存未及时失效',
      },
    ],
  },
  {
    id: 'TR-2404',
    pipelineId: 'RUN-2404',
    project: 'sme-main',
    version: 'v12.0.2-rc.41',
    createdAt: '10 月 24 日',
    status: 'warning',
    total: 512,
    passed: 488,
    failed: 17,
    skipped: 7,
    duration: '31m 08s',
    suites: [
      { name: 'AP 上线与分组', total: 96, passed: 91, failed: 5, duration: '8m 21s' },
      { name: '无线漫游稳定性', total: 144, passed: 138, failed: 6, duration: '9m 02s' },
      { name: 'PoE 供电诊断', total: 108, passed: 104, failed: 4, duration: '6m 44s' },
      { name: '固件升级与回滚', total: 164, passed: 155, failed: 2, duration: '7m 01s' },
    ],
    failedCases: [
      {
        name: '弱信号终端跨楼层漫游',
        suite: '无线漫游稳定性',
        reason: '第 63 次漫游出现 180ms 业务中断',
      },
      {
        name: '升级后 PoE 端口状态轮询',
        suite: 'PoE 供电诊断',
        reason: '2 个端口状态上报延迟超过 30s',
      },
    ],
  },
]

export const teamMembers = ['陈华', '林晓', '周明', '苏悦', '赵一鸣']

export const teamColors: Record<string, string> = {
  陈华: '#5b5ce2',
  林晓: '#0f9f87',
  周明: '#ef7b32',
  苏悦: '#d14f8e',
  赵一鸣: '#2575d9',
}
