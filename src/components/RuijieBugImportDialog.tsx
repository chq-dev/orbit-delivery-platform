import {
  Bug,
  CheckCircle2,
  ExternalLink,
  LoaderCircle,
  Search,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { platformLinks } from '../appConfig'
import { useData } from '../store'
import type { RuijieSyncInput, RuijieSyncResult } from '../types'
import { Field, Modal, StatusBadge } from './ui'

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function RuijieBugImportDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { accounts, repositories, syncRuijie } = useData()
  const ruijieAccounts = useMemo(
    () => accounts.filter((account) => account.platform === 'ruijie'),
    [accounts],
  )
  const [accountId, setAccountId] = useState('')
  const [repoId, setRepoId] = useState('')
  const [bugIds, setBugIds] = useState('')
  const [keyword, setKeyword] = useState('')
  const [limit, setLimit] = useState('20')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<RuijieSyncResult | null>(null)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (!open) {
      wasOpen.current = false
      return
    }
    const opening = !wasOpen.current
    wasOpen.current = true
    setAccountId((current) =>
      ruijieAccounts.some((account) => account.id === current)
        ? current
        : ruijieAccounts[0]?.id ?? '',
    )
    setRepoId((current) =>
      repositories.some((repository) => repository.id === current)
        ? current
        : repositories[0]?.id ?? '',
    )
    if (opening) {
      setError('')
      setResult(null)
    }
  }, [open, repositories, ruijieAccounts])

  const submit = async () => {
    if (!accountId || !repoId || loading) return
    const input: RuijieSyncInput = {
      accountId,
      repoId,
      limit: Math.max(1, Math.min(100, Number(limit) || 20)),
    }
    if (bugIds.trim()) input.bugIds = bugIds.trim()
    if (keyword.trim()) input.keyword = keyword.trim()

    setLoading(true)
    setError('')
    try {
      setResult(await syncRuijie(input))
    } catch (submitError) {
      setError(messageOf(submitError, '锐捷 BUG 同步失败，请检查账号和网络后重试'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={loading}
      title="同步锐捷 BUG"
      subtitle="使用绑定的账号密码登录 BUG 系统，按编号、链接或关键词拉取缺陷并导入当前平台"
      size="lg"
      footer={
        <>
          <span className="modal-footer-hint">
            <ShieldCheck size={15} /> 账号密码仅由服务端解密使用
          </span>
          <div className="modal-footer-actions">
            <button className="btn btn-secondary" onClick={onClose} disabled={loading}>
              关闭
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void submit()}
              disabled={!accountId || !repoId || loading}
            >
              {loading ? <LoaderCircle size={15} className="spin" /> : <Search size={15} />}
              {loading ? '正在登录并获取…' : '获取并导入 BUG'}
            </button>
          </div>
        </>
      }
    >
      <div className="ruijie-source-card">
        <span className="ruijie-source-mark"><Bug size={18} /></span>
        <div>
          <strong>锐捷 BUG 系统</strong>
          <span>{platformLinks.ruijieBug}</span>
        </div>
        <span className="ruijie-source-state">
          <ShieldCheck size={13} /> {ruijieAccounts.length} 个账号可用
        </span>
      </div>

      {ruijieAccounts.length === 0 ? (
        <div className="form-note">
          <Bug size={14} />
          <strong>请先到账号中心绑定锐捷 BUG 账号</strong>，服务地址可填写 BUG 系统登录页地址。
        </div>
      ) : (
        <>
          {repositories.length === 0 && (
            <div className="form-error">当前没有关联仓库，请先接入代码仓库后再同步 BUG。</div>
          )}
          <div className="field-row">
            <Field label="登录账号" required>
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                {ruijieAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.username} · {account.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="关联仓库" required>
              <select value={repoId} onChange={(event) => setRepoId(event.target.value)}>
                {repositories.map((repository) => (
                  <option key={repository.id} value={repository.id}>
                    {repository.name} · {repository.branch}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field
            label="BUG 编号 / 链接（可选）"
            hint="支持每行一个，或粘贴多个 BUG 链接"
          >
            <textarea
              rows={4}
              value={bugIds}
              onChange={(event) => setBugIds(event.target.value)}
              placeholder={`例如：\n123456\nhttp://bugs.ruijie.com.cn/bug_switch/bug/main?bugId=654321`}
            />
          </Field>

          <div className="field-row">
            <Field label="标题关键词（可选）" hint="留空且未填编号时获取关注列表">
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="例如：WLAN 漫游"
              />
            </Field>
            <Field label="最多获取" hint="1-100 条">
              <input
                type="number"
                min={1}
                max={100}
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
              />
            </Field>
          </div>
        </>
      )}

      {error && <div className="form-error">{error}</div>}

      {result && (
        <section className="ruijie-sync-result">
          <div className="ruijie-sync-result-head">
            <span>
              <CheckCircle2 size={16} />
              <strong>已获取 {result.fetched} 条 BUG</strong>
            </span>
            <small>
              新增 {result.created} 条 · 更新 {result.updated} 条 · {result.syncedAt}
            </small>
          </div>
          <div className="ruijie-bug-list">
            {result.bugs.map((bug) => (
              <a
                key={bug.bugId}
                href={bug.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="ruijie-bug-id">{bug.bugId}</span>
                <span className="ruijie-bug-title">{bug.title}</span>
                <StatusBadge status={bug.priority} />
                <ExternalLink size={13} />
              </a>
            ))}
          </div>
          <p>{result.message}</p>
        </section>
      )}
    </Modal>
  )
}
