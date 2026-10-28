import {
  AlertTriangle,
  CheckCircle2,
  CloudDownload,
  Link2,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Unplug,
} from 'lucide-react'
import { useState } from 'react'
import type { FeishuConnectInput } from '../api'
import { useData } from '../store'
import { Field, Modal, StatusBadge } from './ui'

export function FeishuIntegrationCard() {
  const {
    repositories,
    feishuIntegration,
    connectFeishu,
    testFeishu,
    syncFeishu,
    disconnectFeishu,
  } = useData()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'connect' | 'test' | 'sync' | 'disconnect' | null>(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState<FeishuConnectInput>({
    accessToken: '',
    userKey: '',
    projectKey: 'rjcloud',
    defaultRepoId: '',
    requirementTypeKey: 'story',
    defectTypeKey: 'issue',
    defaultOwner: '飞书同步',
    closeTransitionId: '',
    webhookSecret: '',
  })

  const update = (key: keyof FeishuConnectInput, value: string) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const openDialog = () => {
    setForm({
      accessToken: '',
      userKey: feishuIntegration.userKey ?? '',
      projectKey: feishuIntegration.projectKey ?? 'rjcloud',
      defaultRepoId: feishuIntegration.defaultRepoId ?? repositories[0]?.id ?? '',
      requirementTypeKey: feishuIntegration.requirementTypeKey ?? 'story',
      defectTypeKey: feishuIntegration.defectTypeKey ?? 'issue',
      defaultOwner: feishuIntegration.defaultOwner ?? '飞书同步',
      closeTransitionId: feishuIntegration.closeTransitionId ?? '',
      webhookSecret: '',
    })
    setError('')
    setOpen(true)
  }

  const submit = async () => {
    if (
      !form.accessToken?.trim() ||
      !form.projectKey.trim() ||
      !form.defaultRepoId ||
      !form.requirementTypeKey.trim() ||
      !form.defectTypeKey.trim()
    ) {
      setError('请填写访问 Token、项目标识、默认仓库和工作项类型 Key')
      return
    }
    setBusy('connect')
    setError('')
    try {
      await connectFeishu(form)
      setOpen(false)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '飞书项目绑定失败')
    } finally {
      setBusy(null)
    }
  }

  const runTest = async () => {
    setBusy('test')
    try {
      await testFeishu()
    } catch {
      // The data provider already reports the API error as a toast.
    } finally {
      setBusy(null)
    }
  }

  const runSync = async () => {
    setBusy('sync')
    try {
      await syncFeishu()
    } catch {
      // The data provider already reports the API error as a toast.
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async () => {
    if (!window.confirm('确认解除飞书项目绑定？已同步到本地的工作项会保留。')) return
    setBusy('disconnect')
    try {
      await disconnectFeishu()
    } catch {
      // The data provider already reports the API error as a toast.
    } finally {
      setBusy(null)
    }
  }

  const connected = feishuIntegration.connected
  const repository = repositories.find((item) => item.id === feishuIntegration.defaultRepoId)
  const status =
    connected && feishuIntegration.status === 'active'
      ? 'active'
      : connected
        ? 'warning'
        : 'pending'
  const statusLabel = connected
    ? feishuIntegration.status === 'active'
      ? '已绑定'
      : '连接异常'
    : '未绑定'

  return (
    <>
      <article className="card feishu-integration-card" id="feishu-integration">
        <div className="feishu-integration-head">
          <div className="feishu-integration-title">
            <span className="feishu-integration-logo">
              <Link2 size={18} />
            </span>
            <div>
              <h2>飞书项目绑定</h2>
              <p>使用当前飞书项目访问 Token 同步需求和缺陷，无需创建开放平台插件账号。</p>
            </div>
          </div>
          <StatusBadge status={status} label={statusLabel} />
        </div>

        {connected ? (
          <div className="feishu-integration-body">
            <div className="feishu-integration-meta">
              <span>
                <small>项目标识</small>
                <strong>{feishuIntegration.projectKey}</strong>
              </span>
              {feishuIntegration.authMode === 'token' ? (
                <span>
                  <small>访问凭证</small>
                  <strong>{feishuIntegration.accessTokenHint || '抓包 Token'}</strong>
                </span>
              ) : (
                <span>
                  <small>Plugin ID</small>
                  <strong>{feishuIntegration.pluginId}</strong>
                </span>
              )}
              <span>
                <small>工作项类型</small>
                <strong>
                  {feishuIntegration.requirementTypeKey} / {feishuIntegration.defectTypeKey}
                </strong>
              </span>
              <span>
                <small>默认仓库</small>
                <strong>{repository?.name ?? feishuIntegration.defaultRepoId}</strong>
              </span>
              <span>
                <small>关闭流转 ID</small>
                <strong>{feishuIntegration.closeTransitionId || '未配置'}</strong>
              </span>
              <span>
                <small>最近同步</small>
                <strong>{feishuIntegration.lastSyncAt || '尚未同步'}</strong>
              </span>
              <span>
                <small>回调 Token</small>
                <strong>{feishuIntegration.webhookConfigured ? '已配置' : '未配置'}</strong>
              </span>
            </div>
            <div className="feishu-integration-status-row">
              <span className={feishuIntegration.lastSyncStatus === 'failed' ? 'is-error' : ''}>
                {feishuIntegration.lastSyncStatus === 'failed' ? (
                  <AlertTriangle size={14} />
                ) : (
                  <CheckCircle2 size={14} />
                )}
                {feishuIntegration.lastSyncMessage || '等待首次同步'}
              </span>
              <code>{feishuIntegration.eventPath}</code>
            </div>
          </div>
        ) : (
          <div className="feishu-integration-empty">
            <ShieldCheck size={17} />
            <div>
              <strong>尚未绑定飞书项目</strong>
              <p>粘贴当前访问抓包得到的 X-Plugin-Token，即可同步需求和缺陷。</p>
            </div>
          </div>
        )}

        <div className="feishu-integration-actions">
          <button className="btn btn-primary" onClick={openDialog} disabled={busy !== null}>
            <Settings2 size={15} /> {connected ? '更新绑定' : '配置绑定'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={runTest}
            disabled={!connected || busy !== null}
          >
            <RefreshCw size={15} className={busy === 'test' ? 'spin' : ''} /> 测试连接
          </button>
          <button
            className="btn btn-secondary"
            onClick={runSync}
            disabled={!connected || busy !== null}
          >
            <CloudDownload size={15} className={busy === 'sync' ? 'spin' : ''} /> 同步工作项
          </button>
          {connected && (
            <button
              className="text-btn feishu-disconnect"
              onClick={disconnect}
              disabled={busy !== null}
            >
              <Unplug size={14} /> 解除绑定
            </button>
          )}
        </div>
      </article>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={connected ? '更新飞书项目访问凭证' : '绑定飞书项目'}
        subtitle="访问 Token 会使用 AES-256-GCM 加密保存，不会在前端回显"
        size="lg"
        footer={
          <>
            <span className="modal-footer-hint">
              <ShieldCheck size={15} /> 保存前会使用该 Token 校验项目访问权限和工作项类型
            </span>
            <div className="modal-footer-actions">
              <button className="btn btn-secondary" onClick={() => setOpen(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={submit} disabled={busy !== null}>
                {busy === 'connect' ? '正在校验…' : '保存并校验'}
              </button>
            </div>
          </>
        }
      >
        <div className="feishu-connect-form">
          <Field
            label="访问 Token（X-Plugin-Token）"
            required
            hint={
              connected && feishuIntegration.authMode === 'token'
                ? `当前 ${feishuIntegration.accessTokenHint ?? '已保存'}；过期后重新抓取`
                : '从已登录飞书项目页面的 /open_api 请求头复制，不是浏览器 Cookie'
            }
          >
            <input
              type="password"
              value={form.accessToken ?? ''}
              onChange={(event) => update('accessToken', event.target.value)}
              placeholder="p-xxxxxxxx 或 u-xxxxxxxx"
              autoComplete="new-password"
            />
          </Field>
          <div className="field-row">
            <Field label="User Key" hint="如果 Token 请求头同时包含 X-User-Key，请一并填写">
              <input
                value={form.userKey ?? ''}
                onChange={(event) => update('userKey', event.target.value)}
                placeholder="749112601802809xxxx"
                autoComplete="off"
              />
            </Field>
            <Field label="项目标识" required hint="空间 URL 的 simple_name 或双击空间名复制的 project_key">
              <input
                value={form.projectKey}
                onChange={(event) => update('projectKey', event.target.value)}
                placeholder="rjcloud"
              />
            </Field>
          </div>
          <div className="field-row field-row-3">
            <Field label="需求类型 Key" required hint="标准需求为 story，自定义类型通过 all-types 查询">
              <input
                value={form.requirementTypeKey}
                onChange={(event) => update('requirementTypeKey', event.target.value)}
                placeholder="story"
              />
            </Field>
            <Field label="缺陷类型 Key" required hint="标准缺陷为 issue，自定义类型通过 all-types 查询">
              <input
                value={form.defectTypeKey}
                onChange={(event) => update('defectTypeKey', event.target.value)}
                placeholder="issue"
              />
            </Field>
            <Field label="默认仓库" required>
              <select
                value={form.defaultRepoId}
                onChange={(event) => update('defaultRepoId', event.target.value)}
              >
                <option value="">请选择仓库</option>
                {repositories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="field-row">
            <Field label="默认负责人" hint="飞书未返回负责人时使用">
              <input
                value={form.defaultOwner}
                onChange={(event) => update('defaultOwner', event.target.value)}
                placeholder="飞书同步"
              />
            </Field>
            <Field label="关闭流转 ID" hint="从工作流详情接口的 connections.transition_id 获取">
              <input
                value={form.closeTransitionId}
                onChange={(event) => update('closeTransitionId', event.target.value)}
                placeholder="例如：123456"
                inputMode="numeric"
              />
            </Field>
          </div>
          <Field
            label="回调 Token（Callback Token）"
            hint={
              connected && feishuIntegration.webhookConfigured
                ? '已配置；留空将保留当前 Token'
                : '在插件构成 → 监听事件中自行配置的回调 Token'
            }
          >
            <input
              type="password"
              value={form.webhookSecret}
              onChange={(event) => update('webhookSecret', event.target.value)}
              placeholder="事件订阅回调 Token"
              autoComplete="new-password"
            />
          </Field>
          <div className="credential-note">
            <ShieldCheck size={16} />
            <div>
              <strong>访问 Token 获取方式</strong>
              <p>
                登录飞书项目 → 打开浏览器开发者工具 → Network → 筛选
                <code> /open_api </code> → 复制请求头中的
                <code> X-Plugin-Token </code>和可选的
                <code> X-User-Key </code>。Token 过期后需要重新抓取；内部
                <code> goapi </code>的 CSRF Token 不能代替它。
              </p>
            </div>
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
      </Modal>
    </>
  )
}
