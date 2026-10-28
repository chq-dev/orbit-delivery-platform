import type { AppDatabase } from '../db/database.js'
import { notFound } from '../domain/errors.js'
import { formatDisplayTime, nowIso } from '../domain/time.js'
import type {
  FailedCase,
  ReportStatus,
  TestReport,
  TestSuite,
} from '../domain/types.js'

interface TestReportRow {
  id: string
  pipeline_id: string
  project: string
  version: string
  status: ReportStatus
  total: number
  passed: number
  failed: number
  skipped: number
  duration: string
  created_at: string
}

interface TestSuiteRow {
  report_id: string
  name: string
  total: number
  passed: number
  failed: number
  duration: string
}

interface FailedCaseRow {
  report_id: string
  name: string
  suite: string
  reason: string
}

export interface TestReportSource {
  pipelineId: string
  project: string
  version: string
}

const generatedSuites: TestSuite[] = [
  { name: '无线配置与接入', total: 96, passed: 95, failed: 1, duration: '3m 42s' },
  { name: 'VLAN 与交换转发', total: 148, passed: 147, failed: 1, duration: '7m 18s' },
  { name: '固件升级与异常恢复', total: 106, passed: 104, failed: 0, duration: '5m 06s' },
  { name: 'AC/AP 兼容性', total: 76, passed: 76, failed: 0, duration: '3m 10s' },
]

const generatedFailedCases: FailedCase[] = [
  {
    name: 'VLAN 批量导入冲突校验',
    suite: 'VLAN 与交换转发',
    reason: '地址池重叠场景未返回明确的冲突字段',
  },
  {
    name: 'AP 断线重连后终端地址续租',
    suite: '无线配置与接入',
    reason: 'CAPWAP 隧道重建后 DHCP 续租耗时超过 2s',
  },
]

export function createTestReport(db: AppDatabase, source: TestReportSource): TestReport {
  const existing = db
    .prepare('SELECT id FROM test_reports WHERE pipeline_id = ?')
    .get(source.pipelineId) as { id: string } | undefined
  if (existing) return getTestReport(db, existing.id)

  const total = generatedSuites.reduce((sum, suite) => sum + suite.total, 0)
  const passed = generatedSuites.reduce((sum, suite) => sum + suite.passed, 0)
  const failed = generatedSuites.reduce((sum, suite) => sum + suite.failed, 0)
  const skipped = 2
  const id = `TR-${source.pipelineId.replace('RUN-', '')}`
  const now = nowIso()

  db.prepare(
    `INSERT INTO test_reports
      (id, pipeline_id, project, version, status, total, passed, failed, skipped, duration, created_at)
     VALUES (?, ?, ?, ?, 'passed', ?, ?, ?, ?, '19m 16s', ?)`,
  ).run(id, source.pipelineId, source.project, source.version, total, passed, failed, skipped, now)

  const insertSuite = db.prepare(
    `INSERT INTO test_suites (report_id, suite_index, name, total, passed, failed, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  generatedSuites.forEach((suite, index) => {
    insertSuite.run(id, index, suite.name, suite.total, suite.passed, suite.failed, suite.duration)
  })

  const insertFailedCase = db.prepare(
    `INSERT INTO failed_cases (report_id, case_index, name, suite, reason)
     VALUES (?, ?, ?, ?, ?)`,
  )
  generatedFailedCases.forEach((item, index) => {
    insertFailedCase.run(id, index, item.name, item.suite, item.reason)
  })

  return getTestReport(db, id)
}

export function listTestReports(db: AppDatabase): TestReport[] {
  const rows = db
    .prepare(
      `SELECT id, pipeline_id, project, version, status, total, passed, failed, skipped, duration, created_at
       FROM test_reports ORDER BY created_at DESC, id DESC`,
    )
    .all() as TestReportRow[]
  return rows.map((row) => hydrateReport(db, row))
}

export function getTestReport(db: AppDatabase, id: string): TestReport {
  const row = db
    .prepare(
      `SELECT id, pipeline_id, project, version, status, total, passed, failed, skipped, duration, created_at
       FROM test_reports WHERE id = ?`,
    )
    .get(id) as TestReportRow | undefined
  if (!row) throw notFound('测试报告')
  return hydrateReport(db, row)
}

function hydrateReport(db: AppDatabase, row: TestReportRow): TestReport {
  const suites = db
    .prepare(
      `SELECT report_id, name, total, passed, failed, duration
       FROM test_suites WHERE report_id = ? ORDER BY suite_index ASC`,
    )
    .all(row.id) as TestSuiteRow[]
  const failedCases = db
    .prepare(
      `SELECT report_id, name, suite, reason
       FROM failed_cases WHERE report_id = ? ORDER BY case_index ASC`,
    )
    .all(row.id) as FailedCaseRow[]

  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    project: row.project,
    version: row.version,
    createdAt: formatDisplayTime(row.created_at),
    status: row.status,
    total: row.total,
    passed: row.passed,
    failed: row.failed,
    skipped: row.skipped,
    duration: row.duration,
    suites: suites.map((suite) => ({
      name: suite.name,
      total: suite.total,
      passed: suite.passed,
      failed: suite.failed,
      duration: suite.duration,
    })),
    failedCases: failedCases.map((item) => ({
      name: item.name,
      suite: item.suite,
      reason: item.reason,
    })),
  }
}

export function reportAsMarkdown(report: TestReport): string {
  return [
    `# ${report.id} 测试报告`,
    '',
    `- 项目：${report.project}`,
    `- 版本：${report.version}`,
    `- 生成时间：${report.createdAt}`,
    `- 用例：${report.total} / 通过：${report.passed} / 失败：${report.failed} / 跳过：${report.skipped}`,
    `- 通过率：${((report.passed / report.total) * 100).toFixed(1)}%`,
    `- 耗时：${report.duration}`,
    '',
    '## 测试套件',
    ...report.suites.map(
      (suite) =>
        `- ${suite.name}: ${suite.passed}/${suite.total} 通过，${suite.failed} 失败，耗时 ${suite.duration}`,
    ),
    '',
    '## 失败用例',
    ...(report.failedCases.length
      ? report.failedCases.map((item) => `- [${item.suite}] ${item.name}：${item.reason}`)
      : ['无失败用例']),
  ].join('\n')
}
