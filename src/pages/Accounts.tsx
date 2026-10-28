import {
  CheckCircle2,
  ChevronRight,
  ClipboardPaste,
  CloudUpload,
  FileText,
  KeyRound,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  Search,
  ShieldCheck,
  TriangleAlert,
  Upload,
  UserPlus,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { FeishuImportDialog } from '../components/FeishuImportDialog'
import { FeishuIntegrationCard } from '../components/FeishuIntegrationCard'
import { platformMeta } from '../appConfig'
import { useData } from '../store'
import type { PlatformKey, WorkItemType } from '../types'
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

export function Accounts() {
  const { accounts, addAccount, importAccounts, feishuIntegration } = useData()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | PlatformKey>('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [mode, setMode] = useState<'manual' | 'import'>('manual')
  const [platform, setPlatform] = useState<PlatformKey>('git')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [label, setLabel] = useState('')
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState('')
  const [feishuMode, setFeishuMode] = useState<WorkItemType>('requirement')
  const [feishuImportOpen, setFeishuImportOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(
    () =>
      accounts.filter((account) => {
        const platformMatches = filter === 'all' || account.platform === filter
        const textMatches = [account.username, account.label, platformMeta[account.platform].name]
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
    setPlatform(nextPlatform)
    setUsername('')
    setPassword('')
    setLabel('')
    setModalOpen(true)
  }

  const openImport = () => {
    setMode('import')
    setImportText('')
    setImportError('')
    setModalOpen(true)
  }

  const submitManual = async () => {
    if (!username.trim() || !password.trim()) return
    try {
      await addAccount({ platform, username: username.trim(), password, label: label.trim() })
      setModalOpen(false)
    } catch {
      // The data provider already reports the API error as a toast.
    }
  }

  const submitImport = async () => {
    if (parsed.rows.length === 0) {
      setImportError('未识别到有效账号，请检查格式后重试')
      return
    }
    try {
      await importAccounts(parsed.rows)
      setModalOpen(false)
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
              ) : (
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
                  <td>
                    <button className="icon-btn" aria-label="账号操作">
                      <MoreHorizontal size={17} />
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7}>
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
        onClose={() => setModalOpen(false)}
        title={mode === 'manual' ? '绑定平台账号' : '批量导入账号'}
        subtitle={
          mode === 'manual'
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
              <button className="btn btn-secondary" onClick={() => setModalOpen(false)}>
                取消
              </button>
              {mode === 'manual' ? (
                <button
                  className="btn btn-primary"
                  onClick={submitManual}
                  disabled={!username || !password}
                >
                  验证并绑定
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
        <div className="account-modal-tabs">
          <button className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')}>
            <UserPlus size={15} /> 手动配置
          </button>
          <button className={mode === 'import' ? 'active' : ''} onClick={() => setMode('import')}>
            <ClipboardPaste size={15} /> 批量导入
          </button>
        </div>

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
              <Field label="密码 / Access Token" required>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="输入平台密码或访问令牌"
                />
              </Field>
            </div>
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
      <FeishuImportDialog
        open={feishuImportOpen}
        mode={feishuMode}
        onClose={() => setFeishuImportOpen(false)}
      />
    </div>
  )
}
