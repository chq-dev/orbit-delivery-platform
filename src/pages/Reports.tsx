import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  Clock3,
  Download,
  FileBarChart2,
  FileCheck2,
  FlaskConical,
  GitBranch,
  Search,
  ShieldCheck,
  Sparkles,
  TimerReset,
  Workflow,
  XCircle,
} from 'lucide-react'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Modal, StatusBadge } from '../components/ui'
import { averageDuration } from '../duration'
import { useData } from '../store'
import type { PageKey, TestReport } from '../types'

function reportTone(report: TestReport) {
  const rate = report.passed / report.total
  return rate >= 0.98 ? 'green' : rate >= 0.95 ? 'orange' : 'red'
}

export function Reports({
  selectedReportId,
  onNavigate,
}: {
  selectedReportId?: string
  onNavigate: (page: PageKey, id?: string) => void
}) {
  const { reports, notify } = useData()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'passed' | 'warning'>('all')
  const [selectedId, setSelectedId] = useState<string | undefined>(selectedReportId)

  useEffect(() => {
    if (selectedReportId) setSelectedId(selectedReportId)
  }, [selectedReportId])

  const filtered = useMemo(
    () =>
      reports.filter((report) => {
        const filterMatches = filter === 'all' || report.status === filter
        const textMatches = [report.id, report.project, report.version]
          .join(' ')
          .toLowerCase()
          .includes(search.toLowerCase())
        return filterMatches && textMatches
      }),
    [filter, reports, search],
  )

  const selected = reports.find((report) => report.id === selectedId)
  const totalCases = reports.reduce((sum, report) => sum + report.total, 0)
  const passedCases = reports.reduce((sum, report) => sum + report.passed, 0)
  const failedCases = reports.reduce((sum, report) => sum + report.failed, 0)
  const overallRate = totalCases ? ((passedCases / totalCases) * 100).toFixed(1) : '0'
  const averageReportDuration = averageDuration(reports.map((report) => report.duration))

  const exportReport = (report: TestReport) => {
    const content = [
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
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${report.id}-${report.version}.md`
    anchor.click()
    URL.revokeObjectURL(url)
    notify('测试报告已导出', `${report.id} 已下载为 Markdown 文件`)
  }

  const selectedRate = selected ? (selected.passed / selected.total) * 100 : 0
  const ringStyle = {
    background: `conic-gradient(#0f9f87 0deg ${selectedRate * 3.6}deg, #edf0f6 ${selectedRate * 3.6}deg 360deg)`,
  } as CSSProperties

  return (
    <div className="page-enter">
      <div className="page-header">
        <div>
          <span className="eyebrow">
            <FlaskConical size={13} /> TEST INTELLIGENCE
          </span>
          <h1>测试报告</h1>
          <p>自动汇总 AC/AP 与交换机升级后的无线、交换和稳定性测试结果，形成可追溯的质量档案。</p>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-secondary" onClick={() => onNavigate('pipelines')}>
            <Workflow size={16} /> 查看流水线
          </button>
          <button className="btn btn-primary" onClick={() => exportReport(reports[0])} disabled={!reports.length}>
            <Download size={16} /> 导出最近报告
          </button>
        </div>
      </div>

      <div className="report-summary-grid">
        <article className="report-summary-card report-summary-hero">
          <div>
            <span className="summary-kicker"><CircleGauge size={10} /> 总体通过率</span>
            <strong>{overallRate}<small>%</small></strong>
            <span className="summary-change">
              {reports.length ? `基于 ${reports.length} 份已归档报告` : '暂无测试报告'}
            </span>
          </div>
          <div className="report-ring-small" style={{ background: `conic-gradient(#fff 0deg ${Number(overallRate) * 3.6}deg, rgba(255,255,255,.18) ${Number(overallRate) * 3.6}deg 360deg)` }}>
            <span>{overallRate}%</span>
          </div>
        </article>
        <article className="report-summary-card">
          <span className="summary-icon indigo"><FileCheck2 size={18} /></span>
          <div><small>报告总数</small><strong>{reports.length}</strong><span>累计归档</span></div>
        </article>
        <article className="report-summary-card">
          <span className="summary-icon green"><CheckCircle2 size={18} /></span>
          <div><small>通过用例</small><strong>{passedCases.toLocaleString()}</strong><span>共 {totalCases.toLocaleString()} 条</span></div>
        </article>
        <article className="report-summary-card">
          <span className="summary-icon orange"><AlertTriangle size={18} /></span>
          <div><small>失败用例</small><strong>{failedCases}</strong><span>需关注 {failedCases} 条</span></div>
        </article>
        <article className="report-summary-card">
          <span className="summary-icon blue"><TimerReset size={18} /></span>
          <div><small>平均耗时</small><strong>{averageReportDuration}</strong><span>来自已归档报告</span></div>
        </article>
      </div>

      <article className="card reports-table-card">
        <div className="card-toolbar">
          <div>
            <h2>测试报告归档</h2>
            <p>按流水线自动生成，支持导出用于评审与归档</p>
          </div>
          <div className="toolbar-right">
            <div className="filter-chips compact">
              <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
                全部 <span>{reports.length}</span>
              </button>
              <button className={filter === 'passed' ? 'active' : ''} onClick={() => setFilter('passed')}>
                通过
              </button>
              <button className={filter === 'warning' ? 'active' : ''} onClick={() => setFilter('warning')}>
                有风险
              </button>
            </div>
            <label className="toolbar-search narrow">
              <Search size={15} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索报告或版本"
              />
            </label>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table reports-table">
            <thead>
              <tr>
                <th>报告</th>
                <th>项目 / 版本</th>
                <th>用例结果</th>
                <th>通过率</th>
                <th>耗时</th>
                <th>状态</th>
                <th>生成时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((report) => {
                const rate = (report.passed / report.total) * 100
                return (
                  <tr key={report.id} onClick={() => setSelectedId(report.id)}>
                    <td>
                      <div className="report-id-cell">
                        <span className={`report-file-icon report-file-${reportTone(report)}`}>
                          <FileBarChart2 size={17} />
                        </span>
                        <div><strong>{report.id}</strong><small>{report.pipelineId}</small></div>
                      </div>
                    </td>
                    <td>
                      <div className="table-repo-cell">
                        <strong>{report.project}</strong>
                        <small><GitBranch size={11} /> {report.version}</small>
                      </div>
                    </td>
                    <td>
                      <div className="case-counts">
                        <span className="text-green"><Check size={11} /> {report.passed}</span>
                        <span className="text-red"><X size={11} /> {report.failed}</span>
                        <span>跳过 {report.skipped}</span>
                      </div>
                    </td>
                    <td>
                      <div className="pass-rate-cell">
                        <div className="mini-progress"><span style={{ width: `${rate}%` }} /></div>
                        <strong>{rate.toFixed(1)}%</strong>
                      </div>
                    </td>
                    <td><span className="muted-cell inline-icon"><Clock3 size={12} /> {report.duration}</span></td>
                    <td>
                      <StatusBadge
                        status={report.status}
                        label={report.status === 'warning' ? '有风险' : '通过'}
                      />
                    </td>
                    <td><span className="muted-cell">{report.createdAt}</span></td>
                    <td>
                      <div className="table-actions">
                        <button
                          className="icon-btn"
                          aria-label="导出报告"
                          onClick={(event) => {
                            event.stopPropagation()
                            exportReport(report)
                          }}
                        >
                          <Download size={15} />
                        </button>
                        <ChevronRight size={15} className="row-chevron" />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="empty-state table-empty">
            <h3>没有匹配的测试报告</h3>
            <p>完成一次交付流水线后，测试报告会自动归档到这里。</p>
          </div>
        )}
      </article>

      <Modal
        open={Boolean(selected)}
        onClose={() => setSelectedId(undefined)}
        title={selected ? `${selected.id} · 测试报告` : ''}
        subtitle={selected ? `${selected.project} · ${selected.version}` : ''}
        size="lg"
        footer={
          <>
            <span className="modal-footer-hint">
              <ShieldCheck size={15} /> 报告随流水线归档，可追溯至对应工作项
            </span>
            <div className="modal-footer-actions">
              <button className="btn btn-secondary" onClick={() => selected && onNavigate('pipelines', selected.pipelineId)}>
                <Workflow size={15} /> 查看流水线
              </button>
              <button className="btn btn-primary" onClick={() => selected && exportReport(selected)}>
                <Download size={15} /> 导出报告
              </button>
            </div>
          </>
        }
      >
        {selected && (
          <div className="report-detail">
            <div className="report-detail-hero">
              <div className="report-detail-fields">
                <div className="detail-badges">
                  <StatusBadge status={selected.status} label={selected.status === 'warning' ? '有风险' : '测试通过'} />
                  <span className="soft-tag"><Sparkles size={12} /> 自动化归档</span>
                </div>
                <div className="report-detail-meta">
                  <span><GitBranch size={13} /> {selected.version}</span>
                  <span><Clock3 size={13} /> 耗时 {selected.duration}</span>
                  <span><FlaskConical size={13} /> 生成于 {selected.createdAt}</span>
                </div>
              </div>
              <div className="report-score-ring" style={ringStyle}>
                <div><strong>{selectedRate.toFixed(1)}<small>%</small></strong><span>通过率</span></div>
              </div>
            </div>

            <div className="report-case-summary">
              <div><small>执行用例</small><strong>{selected.total}</strong></div>
              <div><small>通过</small><strong className="text-green">{selected.passed}</strong></div>
              <div><small>失败</small><strong className="text-red">{selected.failed}</strong></div>
              <div><small>跳过</small><strong>{selected.skipped}</strong></div>
            </div>

            <div className="report-detail-section">
              <h3>测试套件</h3>
              <div className="suite-list">
                {selected.suites.map((suite) => {
                  const suiteRate = Math.round((suite.passed / suite.total) * 100)
                  return (
                    <div className="suite-row" key={suite.name}>
                      <span className="suite-name">{suite.name}</span>
                      <div className="suite-bar"><span style={{ width: `${suiteRate}%` }} /></div>
                      <span className="suite-numbers"><strong>{suite.passed}</strong> / {suite.total}</span>
                      <span className="suite-duration">{suite.duration}</span>
                      <span className={`suite-result ${suite.failed ? 'has-failure' : ''}`}>
                        {suite.failed ? `${suite.failed} 失败` : '全部通过'}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="report-detail-section">
              <h3>失败用例分析 <span>{selected.failedCases.length}</span></h3>
              {selected.failedCases.length ? (
                <div className="failed-case-list">
                  {selected.failedCases.map((item) => (
                    <div className="failed-case" key={item.name}>
                      <span className="failed-case-icon"><XCircle size={16} /></span>
                      <div>
                        <strong>{item.name}</strong>
                        <p>{item.reason}</p>
                      </div>
                      <span className="soft-tag">{item.suite}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="no-failure"><CheckCircle2 size={18} /> 本次测试没有失败用例</div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

function Check({ size }: { size: number }) {
  return <CheckCircle2 size={size} />
}

function X({ size }: { size: number }) {
  return <XCircle size={size} />
}
