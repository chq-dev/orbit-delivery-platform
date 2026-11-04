import {
  CheckCircle2,
  ChevronRight,
  ClipboardPaste,
  CloudUpload,
  ExternalLink,
  FileText,
  Hammer,
  KeyRound,
  LockKeyhole,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Upload,
  UserPlus,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { FeishuImportDialog } from '../components/FeishuImportDialog'
import { FeishuIntegrationCard } from '../components/FeishuIntegrationCard'
import { FeishuLiveSyncCard } from '../components/FeishuLiveSyncCard'
import { platformMeta } from '../appConfig'
import { useData } from '../store'
import type {
  Account,
  BuildJobInfo,
  BuildTriggerResult,
  PlatformKey,
  WorkItemType,
} from '../types'
import { Field, Modal, StatusBadge } from '../components/ui'

const platformOrder: PlatformKey[] = ['git', 'feishu', 'build', 'device']

const aliasMap: Record<string, PlatformKey> = {
  git: 'git',
  gitlab: 'git',
  github: 'git',
  gitee: 'git',
  feishu: 'feishu',
  飞书: 'feishu',
  build: 'build',
  compile: 'build',
  编译: 'build',
  device: 'device',
  ota: 'device',
  设备: 'device',
}

interface ImportRow {
  platform: PlatformKey
  username: string
  password: string
  label: string
}

function parseImport(text: string) {
  const rows: ImportRow[] = []
  let invalid = 0
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line, index) => {
      if (index === 0 && /platform|平台/i.test(line)) return
      const cols = line.split(/[,\t，]/).map((col) => col.trim())
      const platform = aliasMap[cols[0]?.toLowerCase()] ?? aliasMap[cols[0] ?? '']
      if (!platform || !cols[1] || !cols[2]) {
        invalid += 1
        return
      }
      rows.push({
        platform,
        username: cols[1],
        password: cols[2],
        label: cols[3] || '导入账号',
      })
    })
  return { rows, invalid }
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function Accounts() {
  const {
    accounts,
    addAccount,
    updateAccount,
    deleteAccount,
    importAccounts,
    feishuIntegration,
    feishuAgentClients,
    selectedFeishuAgentClientId,
    notify,
  } = useData()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | PlatformKey>('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [mode, setMode] = useState<'manual' | 'import'>('manual')
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [platform, setPlatform] = useState<PlatformKey>('git')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [label, setLabel] = useState('')
  const [serviceUrl, setServiceUrl] = useState('')
  const [actionMenuId, setActionMenuId] = useState<string | null>(null)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState('')
  const [feishuMode, setFeishuMode] = useState<WorkItemType>('requirement')
  const [feishuImportOpen, setFeishuImportOpen] = useState(false)
  const [buildAccount, setBuildAccount] = useState<Account | null>(null)
  const [buildJob, setBuildJob] = useState<BuildJobInfo | null>(null)
  const [buildValues, setBuildValues] = useState<Record<string, string>>({})
  const [buildLoading, setBuildLoading] = useState(false)
  const [buildStarting, setBuildStarting] = useState(false)
  const [buildError, setBuildError] = useState('')
  const [buildResult, setBuildResult] = useState<BuildTriggerResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const buildRequestId = useRef(0)
  const buildClientName = feishuAgentClients.find(
    (client) => client.clientId === selectedFeishuAgentClientId,
  )?.clientName

  const filtered = useMemo(
    () =>
      accounts.filter((account) => {
        const platformMatches = filter === 'all' || account.platform === filter
        const textMatches = [
          account.username,
          account.label,
          account.serviceUrl ?? '',
          platformMeta[account.platform].name,
        ]
          .join(' ')
          .toLowerCase()
          .includes(search.toLowerCase())
        return platformMatches && textMatches
      }),
    [accounts, filter, search],
  )

  const parsed = useMemo(() => parseImport(importText), [importText])

  const openManual = (nextPlatform: PlatformKey = 'git') => {
    setMode('manual')
    setEditingAccount(null)
    setPlatform(nextPlatform)
    setUsername('')
    setPassword('')
    setLabel('')
    setServiceUrl('')
    setActionMenuId(null)
    setModalOpen(true)
  }

  const openEdit = (account: Account) => {
    setMode('manual')
    setEditingAccount(account)
    setPlatform(account.platform)
    setUsername(account.username)
    setPassword('')
    setLabel(account.label)
    setServiceUrl(account.serviceUrl ?? '')
    setActionMenuId(null)
    setModalOpen(true)
  }

  const closeModal = () => {
    setModalOpen(false)
    setEditingAccount(null)
  }

  const openImport = () => {
    setMode('import')
    setEditingAccount(null)
    setImportText('')
    setImportError('')
    setActionMenuId(null)
    setModalOpen(true)
  }

  const submitManual = async () => {
    if (!username.trim() || (!editingAccount && !password.trim())) return
    try {
      if (editingAccount) {
        await updateAccount(editingAccount.id, {
          platform,
          username: username.trim(),
          password: password.trim() ? password : undefined,
          label: label.trim(),
          serviceUrl: serviceUrl.trim(),
        })
      } else {
        await addAccount({
          platform,
          username: username.trim(),
          password,
          label: label.trim(),
          serviceUrl: serviceUrl.trim(),
        })
      }
      closeModal()
    } catch {
      // The data provider already reports the API error as a toast.
    }
  }

  const removeAccount = async (account: Account) => {
    setActionMenuId(null)
    if (!window.confirm(`确认删除账号「${account.username}」？删除后无法恢复。`)) return
    try {
      await deleteAccount(account.id)
    } catch {
      // The data provider already reports the API error as a toast.
    }
  }

  const openBuild = async (account: Account) => {
    const requestId = ++buildRequestId.current
    setActionMenuId(null)
    setBuildAccount(account)
    setBuildJob(null)
    setBuildValues({})
    setBuildResult(null)
    setBuildError('')
    setBuildLoading(true)
    try {
      const job = await api.getBuildJob(account.id, selectedFeishuAgentClientId)
      if (requestId !== buildRequestId.current) return
      setBuildJob(job)
      setBuildValues(
        Object.fromEntries(job.parameters.map((parameter) => [parameter.name, parameter.defaultValue])),
      )
    } catch (error) {
      if (requestId !== buildRequestId.current) return
      setBuildError(messageOf(error, '读取编译任务失败'))
    } finally {
      if (requestId === buildRequestId.current) setBuildLoading(false)
    }
  }

  const closeBuild = () => {
    buildRequestId.current += 1
    setBuildAccount(null)
    setBuildJob(null)
    setBuildValues({})
    setBuildError('')
    setBuildResult(null)
    setBuildStarting(false)
  }

  const submitBuild = async () => {
    if (!buildAccount || !buildJob || buildStarting) return
    const requestId = buildRequestId.current
    setBuildStarting(true)
    setBuildError('')
    try {
      const result = await api.triggerBuild(
        buildAccount.id,
        buildValues,
        selectedFeishuAgentClientId,
      )
      if (requestId !== buildRequestId.current) return
      setBuildResult(result)
      notify('内部编译已触发', `${result.jobName} 已进入 Jenkins 构建队列`)
    } catch (error) {
      if (requestId !== buildRequestId.current) return
      setBuildError(messageOf(error, '触发内部编译失败'))
    } finally {
      if (requestId === buildRequestId.current) setBuildStarting(false)
    }
  }

  const submitImport = async () => {
    if (parsed.rows.length === 0) {
      setImportError('未识别到有效账号，请检查格式后重试')
      return
    }
    try {
      await importAccounts(parsed.rows)
      closeModal()
    } catch {
      // The data provider already reports the API error as a toast.
    }
  }

  const readFile = (file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setImportText(String(reader.result ?? ''))
    reader.readAsText(file)
  }

  const openFeishuImport = (mode: WorkItemType) => {
    setFeishuMode(mode)
    setFeishuImportOpen(true)
  }

  return (
    <div className="page-enter">
      <div className="page-header">
        <div>
          <span className="eyebrow">
            <KeyRound size={13} /> CREDENTIAL VAULT
          </span>
          <h1>账号中心</h1>
          <p>统一绑定 Git、飞书、编译系统与设备端账号，供自动化流水线安全调用。</p>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-secondary" onClick={openImport}>
            <Upload size={16} /> 批量导入
          </button>
          <button className="btn btn-primary" onClick={() => openManual()}>
            <UserPlus size={16} /> 绑定账号
          </button>
        </div>
      </div>

      <div className="security-banner">
        <span className="security-banner-icon">
          <ShieldCheck size={22} />
        </span>
        <div>
          <strong>凭据保险箱已启用</strong>
          <p>所有密码使用 AES-256-GCM 加密存储，仅由流水线运行时按需注入，前端不会展示明文。</p>
        </div>
        <span className="security-status">
          <CheckCircle2 size={14} /> 加密存储已启用
        </span>
      </div>

      <FeishuIntegrationCard />

      <FeishuLiveSyncCard />

      <div className="platform-grid">
        {platformOrder.map((key) => {
          const meta = platformMeta[key]
          const items = accounts.filter((account) => account.platform === key)
          return (
            <article className={`platform-card platform-${key}`} key={key}>
              <div className="platform-card-head">
                <span
                  className="platform-logo"
                  style={{ color: meta.color, background: meta.softColor }}
                >
                  {meta.shortName}
                </span>
                <div>
                  <strong>{meta.name}</strong>
                  <small>{meta.description}</small>
                </div>
                <span className="bound-count">{items.length}</span>
              </div>
              <div className="platform-account-preview">
                {key === 'feishu' && feishuIntegration.connected && items.length === 0 ? (
                  <div className="platform-empty">项目 {feishuIntegration.projectKey} 已接入</div>
                ) : items.length > 0 ? (
                  items.slice(0, 2).map((account) => (
                    <span key={account.id}>
                      <span className="mini-avatar">{account.username.slice(0, 1).toUpperCase()}</span>
                      <span>
                        <strong>{account.username}</strong>
                        <small>{account.label}</small>
                      </span>
                      <span className={`account-status-dot account-status-${account.status}`} />
                    </span>
                  ))
                ) : (
                  <div className="platform-empty">尚未绑定账号</div>
                )}
              </div>
              {key === 'feishu' && (
                <div className="platform-external-links">
                  <button onClick={() => openFeishuImport('requirement')}>
                    <FileText size={12} /> 导入需求
                  </button>
                  <button onClick={() => openFeishuImport('defect')}>
                    <TriangleAlert size={12} /> 导入缺陷
                  </button>
                </div>
              )}
              {key === 'build' && items[0] && (
                <div className="platform-external-links build-platform-actions">
                  <button onClick={() => void openBuild(items[0])}>
                    <Hammer size={12} /> 内部编译
                  </button>
                  <button onClick={() => openManual('build')}>
                    <Plus size={12} /> 添加账号
                  </button>
                </div>
              )}
              {key === 'feishu' ? (
                <button
                  className="platform-add"
                  onClick={() =>
                    document
                      .getElementById('feishu-integration')
                      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }
                >
                  <KeyRound size={14} /> 应用绑定
                </button>
              ) : key === 'build' && items.length > 0 ? null : (
                <button className="platform-add" onClick={() => openManual(key)}>
                  <Plus size={14} /> 添加账号
                </button>
              )}
            </article>
          )
        })}
      </div>

      <article className="card accounts-table-card">
        <div className="card-toolbar">
          <div>
            <h2>全部平台账号</h2>
            <p>共 {accounts.length} 个账号，按平台统一管理</p>
          </div>
          <div className="toolbar-right">
            <div className="filter-chips compact">
              <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
                全部
              </button>
              {platformOrder.map((key) => (
                <button
                  key={key}
                  className={filter === key ? 'active' : ''}
                  onClick={() => setFilter(key)}
                >
                  {platformMeta[key].shortName}
                </button>
              ))}
            </div>
            <label className="toolbar-search narrow">
              <Search size={15} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索账号"
              />
            </label>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table accounts-table">
            <thead>
              <tr>
                <th>平台</th>
                <th>账号</th>
                <th>备注</th>
                <th>服务地址</th>
                <th>凭据</th>
                <th>状态</th>
                <th>绑定时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((account) => (
                <tr key={account.id}>
                  <td>
                    <span
                      className="platform-mini-logo"
                      style={{
                        color: platformMeta[account.platform].color,
                        background: platformMeta[account.platform].softColor,
                      }}
                    >
                      {platformMeta[account.platform].shortName}
                    </span>
                  </td>
                  <td>
                    <div className="account-cell">
                      <span className="mini-avatar large">{account.username.slice(0, 1).toUpperCase()}</span>
                      <div>
                        <strong>{account.username}</strong>
                        <small>{platformMeta[account.platform].name}</small>
                      </div>
                    </div>
                  </td>
                  <td>{account.label}</td>
                  <td>
                    {account.serviceUrl ? (
                      <a
                        className="service-url-cell"
                        href={account.serviceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={account.serviceUrl}
                      >
                        {account.serviceUrl}
                      </a>
                    ) : (
                      <span className="muted-cell">未配置</span>
                    )}
                  </td>
                  <td>
                    <span className="secret-cell">
                      <LockKeyhole size={13} /> {account.secretHint}
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={account.status} />
                  </td>
                  <td>
                    <span className="muted-cell">{account.createdAt}</span>
                  </td>
                  <td className="account-actions-cell">
                    <div className="account-actions">
                      <button
                        className="icon-btn"
                        aria-label={`${account.username} 账号操作`}
                        aria-expanded={actionMenuId === account.id}
                        onClick={() =>
                          setActionMenuId((current) =>
                            current === account.id ? null : account.id,
                          )
                        }
                      >
                        <MoreHorizontal size={17} />
                      </button>
                      {actionMenuId === account.id && (
                        <div className="account-action-menu">
                          {account.platform === 'build' && (
                            <button onClick={() => void openBuild(account)}>
                              <Hammer size={14} /> 内部编译
                            </button>
                          )}
                          <button onClick={() => openEdit(account)}>
                            <Pencil size={14} /> 编辑账号
                          </button>
                          {account.serviceUrl && (
                            <a
                              href={account.serviceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <ExternalLink size={14} /> 打开服务地址
                            </a>
                          )}
                          <button
                            className="account-action-danger"
                            onClick={() => void removeAccount(account)}
                          >
                            <Trash2 size={14} /> 删除账号
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state table-empty">
                      <h3>暂无平台账号</h3>
                      <p>绑定账号或批量导入后，账号会加密保存并显示在这里。</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={
          editingAccount
            ? '编辑平台账号'
            : mode === 'manual'
              ? '绑定平台账号'
              : '批量导入账号'
        }
        subtitle={
          editingAccount
            ? '可更新账号信息与服务地址；密码留空时保持原凭据不变'
            : mode === 'manual'
            ? '账号密码将被加密保管，并仅用于自动化流水线'
            : '上传 CSV 或粘贴多行账号，平台将自动识别并批量绑定'
        }
        size="lg"
        footer={
          <>
            <span className="modal-footer-hint">
              <ShieldCheck size={15} /> 凭据传输全程加密
            </span>
            <div className="modal-footer-actions">
              <button className="btn btn-secondary" onClick={closeModal}>
                取消
              </button>
              {mode === 'manual' ? (
                <button
                  className="btn btn-primary"
                  onClick={submitManual}
                  disabled={!username.trim() || (!editingAccount && !password.trim())}
                >
                  {editingAccount ? '保存修改' : '验证并绑定'}
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={submitImport}
                  disabled={parsed.rows.length === 0}
                >
                  导入 {parsed.rows.length || ''} 个账号
                </button>
              )}
            </div>
          </>
        }
      >
        {!editingAccount && (
          <div className="account-modal-tabs">
            <button className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')}>
              <UserPlus size={15} /> 手动配置
            </button>
            <button className={mode === 'import' ? 'active' : ''} onClick={() => setMode('import')}>
              <ClipboardPaste size={15} /> 批量导入
            </button>
          </div>
        )}

        {mode === 'manual' ? (
          <div className="manual-account-form">
            <div className="platform-picker">
              {platformOrder.map((key) => (
                <button
                  key={key}
                  className={platform === key ? 'active' : ''}
                  onClick={() => setPlatform(key)}
                >
                  <span
                    className="platform-picker-logo"
                    style={{
                      color: platformMeta[key].color,
                      background: platformMeta[key].softColor,
                    }}
                  >
                    {platformMeta[key].shortName}
                  </span>
                  <span>{platformMeta[key].name}</span>
                  {platform === key && <CheckCircle2 size={15} />}
                </button>
              ))}
            </div>
            <div className="field-row">
              <Field label="登录账号" required>
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="name@company.com"
                  autoFocus
                />
              </Field>
              <Field
                label="密码 / Access Token"
                required={!editingAccount}
                hint={editingAccount ? '留空保持不变' : undefined}
              >
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={
                    editingAccount ? '留空则保留当前凭据' : '输入平台密码或访问令牌'
                  }
                />
              </Field>
            </div>
            <Field
              label="服务地址"
              hint={platform === 'build' ? 'Jenkins 任务页面地址' : '可选，支持 http / https 链接'}
            >
              <input
                type="url"
                value={serviceUrl}
                onChange={(event) => setServiceUrl(event.target.value)}
                placeholder={
                  platform === 'build'
                    ? 'https://jenkins.example.com/job/your-project/'
                    : 'https://git.example.com 或 https://build.example.com'
                }
              />
            </Field>
            <Field label="账号备注">
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="例如：主研发账号、CI 自动化账号"
              />
            </Field>
            <div className="credential-note">
              <LockKeyhole size={16} />
              <div>
                <strong>最小权限原则</strong>
                <p>建议使用专用服务账号，并按平台授予仓库读写、构建触发或设备升级所需的最小权限。</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="import-account-form">
            <label
              className="upload-zone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                readFile(event.dataTransfer.files[0])
              }}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.txt"
                onChange={(event) => readFile(event.target.files?.[0])}
              />
              <span className="upload-icon">
                <CloudUpload size={24} />
              </span>
              <strong>拖拽 CSV 文件到这里，或点击选择文件</strong>
              <small>支持 CSV / TXT，每行一个账号</small>
            </label>
            <div className="import-divider"><span>或直接粘贴</span></div>
            <Field label="账号数据" hint="platform, username, password, label">
              <textarea
                className="import-textarea"
                value={importText}
                onChange={(event) => {
                  setImportText(event.target.value)
                  setImportError('')
                }}
                placeholder={`git,chen.hua,password123,主研发账号\nfeishu,quality@rjcloud.com,feishu-token,质量中心\nbuild,build-service-01,build-pass,编译服务\n设备,lab-ac03,device-pass,AC/AP 测试床 03`}
                rows={7}
              />
            </Field>
            {importError && <div className="form-error">{importError}</div>}
            {parsed.rows.length > 0 && (
              <div className="import-preview">
                <div className="import-preview-head">
                  <span>
                    <CheckCircle2 size={14} /> 已识别 {parsed.rows.length} 个有效账号
                  </span>
                  {parsed.invalid > 0 && <small>{parsed.invalid} 行格式无效，将被跳过</small>}
                </div>
                {parsed.rows.slice(0, 4).map((row, index) => (
                  <div className="import-preview-row" key={`${row.username}-${index}`}>
                    <span
                      className="platform-mini-logo"
                      style={{
                        color: platformMeta[row.platform].color,
                        background: platformMeta[row.platform].softColor,
                      }}
                    >
                      {platformMeta[row.platform].shortName}
                    </span>
                    <strong>{row.username}</strong>
                    <span className="secret-cell"><LockKeyhole size={12} /> ••••••••</span>
                    <small>{row.label}</small>
                    <ChevronRight size={14} />
                  </div>
                ))}
                {parsed.rows.length > 4 && (
                  <div className="import-preview-more">还有 {parsed.rows.length - 4} 个账号…</div>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>
      <Modal
        open={Boolean(buildAccount)}
        onClose={closeBuild}
        title={
          buildResult
            ? '编译任务已触发'
            : `内部编译${buildJob ? ` · ${buildJob.name}` : ''}`
        }
        subtitle={
          buildResult
            ? `${buildResult.jobName} 已进入 Jenkins 构建队列`
            : buildLoading
              ? '正在连接 Jenkins 并读取构建参数'
              : '确认本次工程编译参数后提交至 Jenkins'
        }
        size="md"
        footer={
          <>
            <span className="modal-footer-hint">
              <ShieldCheck size={15} /> 编译凭据仅由平台与受信执行客户端使用
              {' · '}
              {buildClientName ?? selectedFeishuAgentClientId ?? '直连失败时自动选择在线客户端'}
            </span>
            <div className="modal-footer-actions">
              <button className="btn btn-secondary" onClick={closeBuild}>
                {buildResult ? '关闭' : '取消'}
              </button>
              {!buildResult && buildJob && (
                <button
                  className="btn btn-primary"
                  onClick={() => void submitBuild()}
                  disabled={buildStarting || buildLoading || !buildJob.buildable}
                >
                  <Play size={15} /> {buildStarting ? '正在提交…' : '执行编译'}
                </button>
              )}
              {!buildResult && !buildJob && !buildLoading && buildError && buildAccount && (
                <button className="btn btn-primary" onClick={() => void openBuild(buildAccount)}>
                  重新读取
                </button>
              )}
            </div>
          </>
        }
      >
        {buildLoading ? (
          <div className="build-state">
            <Hammer size={21} />
            <strong>正在读取 Jenkins 任务</strong>
            <p>将自动加载任务地址与参数默认值。</p>
          </div>
        ) : buildResult ? (
          <>
            <div className="build-result-card">
              <span className="build-result-icon">
                <CheckCircle2 size={22} />
              </span>
              <div>
                <strong>{buildResult.jobName} 已进入构建队列</strong>
                <p>
                  {new Date(buildResult.triggeredAt).toLocaleString('zh-CN')} · 已提交{' '}
                  {buildResult.parameters.length} 个编译参数
                </p>
              </div>
            </div>
            <div className="build-result-links">
              {buildResult.queueUrl && (
                <a
                  className="btn btn-secondary"
                  href={buildResult.queueUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={14} /> 查看构建队列
                </a>
              )}
              <a
                className="btn btn-secondary"
                href={buildResult.jobUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={14} /> 打开 Jenkins 任务
              </a>
            </div>
          </>
        ) : !buildJob ? (
          <div className="build-state build-state-error">
            <TriangleAlert size={21} />
            <strong>无法读取编译任务</strong>
            <p>{buildError || '请检查编译账号服务地址和凭据配置。'}</p>
          </div>
        ) : (
          <>
            <div className="build-job-summary">
              <span className="build-job-icon">
                <Hammer size={18} />
              </span>
              <div>
                <strong>{buildJob.name}</strong>
                <small title={buildJob.jobUrl}>{buildJob.jobUrl}</small>
              </div>
              <span className="build-parameter-count">{buildJob.parameters.length} 个参数</span>
            </div>
            {buildJob.parameters.length === 0 ? (
              <div className="form-note">
                <Play size={14} /> <strong>该任务无需参数</strong>，可直接执行编译。
              </div>
            ) : (
              buildJob.parameters.map((parameter) => (
                <Field
                  key={parameter.name}
                  label={parameter.name}
                  hint={parameter.description}
                >
                  {parameter.choices?.length ? (
                    <select
                      value={buildValues[parameter.name] ?? parameter.defaultValue}
                      onChange={(event) =>
                        setBuildValues((current) => ({
                          ...current,
                          [parameter.name]: event.target.value,
                        }))
                      }
                    >
                      {parameter.choices.map((choice) => (
                        <option key={choice} value={choice}>
                          {choice}
                        </option>
                      ))}
                    </select>
                  ) : parameter.type === 'BooleanParameterDefinition' ? (
                    <select
                      value={buildValues[parameter.name] ?? parameter.defaultValue}
                      onChange={(event) =>
                        setBuildValues((current) => ({
                          ...current,
                          [parameter.name]: event.target.value,
                        }))
                      }
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : parameter.type === 'TextParameterDefinition' ? (
                    <textarea
                      rows={3}
                      value={buildValues[parameter.name] ?? parameter.defaultValue}
                      onChange={(event) =>
                        setBuildValues((current) => ({
                          ...current,
                          [parameter.name]: event.target.value,
                        }))
                      }
                    />
                  ) : (
                    <input
                      type={parameter.type.toLowerCase().includes('password') ? 'password' : 'text'}
                      value={buildValues[parameter.name] ?? parameter.defaultValue}
                      onChange={(event) =>
                        setBuildValues((current) => ({
                          ...current,
                          [parameter.name]: event.target.value,
                        }))
                      }
                    />
                  )}
                </Field>
              ))
            )}
            {buildError && <div className="form-error">{buildError}</div>}
            {!buildJob.buildable && (
              <div className="form-error">该 Jenkins 任务当前不可构建，请检查任务状态或权限。</div>
            )}
          </>
        )}
      </Modal>
      <FeishuImportDialog
        open={feishuImportOpen}
        mode={feishuMode}
        onClose={() => setFeishuImportOpen(false)}
      />
    </div>
  )
}
