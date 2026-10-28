import {
  ArrowRight,
  Box,
  CheckCircle2,
  Clock3,
  Copy,
  GitBranch,
  GitFork,
  Link2,
  Plus,
  Search,
  Settings2,
  Sparkles,
  TriangleAlert,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { DeliveryDialog } from '../components/DeliveryDialog'
import { Field, Modal, StatusBadge } from '../components/ui'
import { useData } from '../store'
import type { PageKey, Repository } from '../types'

const repoColors = ['#5b5ce2', '#0f9f87', '#2575d9', '#e07a2f']

export function Repositories({
  onNavigate,
}: {
  onNavigate: (page: PageKey, runId?: string) => void
}) {
  const { repositories, accounts, workItems, pipelines, addRepository, notify } = useData()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'healthy' | 'warning'>('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  const [deliveryItemId, setDeliveryItemId] = useState<string>()
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [branch, setBranch] = useState('develop')
  const [language, setLanguage] = useState('Vue 3 + Lua')
  const [accountId, setAccountId] = useState(
    accounts.find((account) => account.platform === 'git')?.id ?? '',
  )

  const gitAccounts = accounts.filter((account) => account.platform === 'git')
  const filtered = useMemo(
    () =>
      repositories.filter((repo) => {
        const matchesSearch = [repo.name, repo.url, repo.branch, repo.language]
          .join(' ')
          .toLowerCase()
          .includes(search.toLowerCase())
        const matchesFilter = filter === 'all' || repo.status === filter
        return matchesSearch && matchesFilter
      }),
    [filter, repositories, search],
  )

  const openDelivery = (repo: Repository) => {
    const item = workItems.find(
      (entry) => entry.repoId === repo.id && entry.status !== '已关闭',
    )
    setDeliveryItemId(item?.id)
    setDeliveryOpen(true)
  }

  const inferName = (value: string) => {
    const withoutGit = value.replace(/\.git$/, '').replace(/\/$/, '')
    const inferred = withoutGit.split(/[/:]/).pop() ?? ''
    if (!name && inferred) setName(inferred)
  }

  const submitRepo = async () => {
    if (!url.trim() || !name.trim() || !branch.trim() || !accountId) return
    try {
      await addRepository({
        name: name.trim(),
        url: url.trim(),
        branch: branch.trim(),
        language,
        accountId,
      })
      setModalOpen(false)
      setUrl('')
      setName('')
      setBranch('develop')
    } catch {
      // The data provider already reports the API error as a toast.
    }
  }

  const copyRepositoryUrl = async (repo: Repository) => {
    try {
      await navigator.clipboard.writeText(repo.url)
      notify('仓库地址已复制', `${repo.name} · ${repo.url}`, 'info')
    } catch {
      notify('复制失败', '浏览器未授予剪贴板权限，请手动选择地址', 'warning')
    }
  }

  const healthyCount = repositories.filter((repo) => repo.status === 'healthy').length
  const branchCount = new Set(repositories.map((repo) => repo.branch)).size
  const latestSync = repositories[0]?.lastSync

  return (
    <div className="page-enter">
      <div className="page-header">
        <div>
          <span className="eyebrow">
            <GitFork size={13} /> CODE SOURCES
          </span>
          <h1>代码仓库</h1>
          <p>接入需要管理与修订的 Git 仓库，指定默认分支并关联平台凭据。</p>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-secondary" onClick={() => onNavigate('accounts')}>
            <Link2 size={16} /> 账号中心
          </button>
          <button className="btn btn-primary" onClick={() => setModalOpen(true)}>
            <Plus size={16} /> 接入 Git 仓库
          </button>
        </div>
      </div>

      <div className="repo-summary-strip">
        <div>
          <span className="summary-icon indigo">
            <GitFork size={18} />
          </span>
          <span>
            <small>已接入仓库</small>
            <strong>{repositories.length}</strong>
          </span>
        </div>
        <div>
          <span className="summary-icon green">
            <CheckCircle2 size={18} />
          </span>
          <span>
            <small>仓库健康</small>
            <strong>{healthyCount} / {repositories.length}</strong>
          </span>
        </div>
        <div>
          <span className="summary-icon blue">
            <GitBranch size={18} />
          </span>
          <span>
            <small>默认分支</small>
            <strong>{branchCount}</strong>
          </span>
        </div>
        <div>
          <span className="summary-icon orange">
            <Clock3 size={18} />
          </span>
          <span>
            <small>最近同步</small>
            <strong>{latestSync ?? '暂无同步'}</strong>
          </span>
        </div>
      </div>

      <div className="list-toolbar">
        <div className="filter-chips">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            全部仓库 <span>{repositories.length}</span>
          </button>
          <button
            className={filter === 'healthy' ? 'active' : ''}
            onClick={() => setFilter('healthy')}
          >
            健康 <span>{healthyCount}</span>
          </button>
          <button
            className={filter === 'warning' ? 'active' : ''}
            onClick={() => setFilter('warning')}
          >
            需关注 <span>{repositories.length - healthyCount}</span>
          </button>
        </div>
        <label className="toolbar-search">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索仓库、分支或语言"
          />
        </label>
      </div>

      <div className="repo-grid">
        {filtered.map((repo, index) => {
          const account = accounts.find((entry) => entry.id === repo.accountId)
          const repoRuns = pipelines.filter((run) => run.repoId === repo.id)
          const latestRun = repoRuns[0]
          return (
            <article className="repo-card card" key={repo.id}>
              <div className="repo-card-head">
                <span
                  className="repo-logo repo-logo-large"
                  style={{ background: repoColors[index % repoColors.length] }}
                >
                  {repo.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="repo-card-title">
                  <h2>{repo.name}</h2>
                  <button
                    className="repo-url repo-url-copy"
                    onClick={() => copyRepositoryUrl(repo)}
                    title="复制仓库地址，不打开外部页面"
                  >
                    {repo.url}
                    <Copy size={11} />
                  </button>
                </div>
                <span className={`repo-health repo-health-${repo.status}`}>
                  <span />
                  {repo.status === 'healthy' ? '健康' : '需关注'}
                </span>
              </div>

              <div className="repo-branch-pill">
                <GitBranch size={15} />
                <span>{repo.branch}</span>
                <small>默认分支</small>
              </div>

              <div className="repo-meta-grid">
                <div>
                  <small>代码语言</small>
                  <strong>{repo.language}</strong>
                </div>
                <div>
                  <small>认证账号</small>
                  <strong>{account?.username ?? '未绑定'}</strong>
                </div>
                <div>
                  <small>最新版本</small>
                  <strong>{repo.latestVersion}</strong>
                </div>
                <div>
                  <small>最近同步</small>
                  <strong>{repo.lastSync}</strong>
                </div>
              </div>

              <div className="repo-latest-run">
                <span className="repo-run-icon">
                  {latestRun ? <Box size={16} /> : <Sparkles size={16} />}
                </span>
                <div>
                  <small>最近一次交付</small>
                  {latestRun ? (
                    <span>
                      <strong>{latestRun.id}</strong>
                      <StatusBadge status={latestRun.status} />
                    </span>
                  ) : (
                    <strong>尚未执行</strong>
                  )}
                </div>
                {latestRun && (
                  <button
                    className="icon-btn"
                    onClick={() => onNavigate('pipelines', latestRun.id)}
                    aria-label="查看流水线"
                  >
                    <ArrowRight size={16} />
                  </button>
                )}
              </div>

              <div className="repo-card-footer">
                <button className="btn btn-quiet" onClick={() => onNavigate('accounts')}>
                  <Settings2 size={15} /> 配置
                </button>
                <button className="btn btn-soft-primary" onClick={() => openDelivery(repo)}>
                  发起交付 <ArrowRight size={15} />
                </button>
              </div>
              {repo.status === 'warning' && (
                <div className="repo-warning">
                  <TriangleAlert size={13} /> 最近同步失败，请检查分支权限或凭据状态
                </div>
              )}
            </article>
          )
        })}
      </div>

      {filtered.length === 0 && (
        <div className="card empty-state">
          <h3>没有匹配的仓库</h3>
          <p>尝试调整搜索词或筛选条件。</p>
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="接入 Git 仓库"
        subtitle="配置仓库地址、目标分支与认证账号"
        footer={
          <>
            <span className="modal-footer-hint">
              <CheckCircle2 size={15} /> 仓库信息将持久化到本地数据库
            </span>
            <div className="modal-footer-actions">
              <button className="btn btn-secondary" onClick={() => setModalOpen(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={submitRepo}
                disabled={!url || !name || !branch || !accountId}
              >
                连接并校验
              </button>
            </div>
          </>
        }
      >
        <Field label="Git 仓库地址" required hint="支持 SSH 与 HTTPS">
          <div className="input-with-icon">
            <GitFork size={15} />
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onBlur={() => inferName(url)}
              placeholder="http://cloudgit.rj.link/sme/sme-main.git"
              autoFocus
            />
          </div>
        </Field>
        <div className="field-row">
          <Field label="仓库名称" required>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="project-name"
            />
          </Field>
          <Field label="默认管理分支" required>
            <div className="input-with-icon">
              <GitBranch size={15} />
              <input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="develop 或 release/v12.0"
              />
            </div>
          </Field>
        </div>
        <div className="field-row">
          <Field label="主要语言">
            <select value={language} onChange={(event) => setLanguage(event.target.value)}>
              <option>Vue 3 + Lua</option>
              <option>Vue 3</option>
              <option>Lua</option>
              <option>TypeScript</option>
              <option>React</option>
              <option>C++</option>
              <option>Python</option>
              <option>Rust</option>
              <option>Go</option>
              <option>Shell</option>
            </select>
          </Field>
          <Field label="认证账号" required>
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {gitAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.username} · {account.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="form-note">
          <Link2 size={15} />
          <span>
            尚未绑定 Git 账号？前往 <button className="inline-link" onClick={() => onNavigate('accounts')}>账号中心</button> 添加
          </span>
        </div>
      </Modal>

      <DeliveryDialog
        open={deliveryOpen}
        onClose={() => setDeliveryOpen(false)}
        initialWorkItemId={deliveryItemId}
        onStarted={(run) => onNavigate('pipelines', run.id)}
      />
    </div>
  )
}
