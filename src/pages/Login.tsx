import { AlertTriangle, ArrowRight, CheckCircle2, KeyRound, LockKeyhole, ShieldCheck, UserRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth'

type AuthMode = 'login' | 'register'

export function LoginPage() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<AuthMode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const switchMode = (next: AuthMode) => {
    setMode(next)
    setError('')
    setPassword('')
    setConfirmPassword('')
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (mode === 'register' && password !== confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }
    setSubmitting(true)
    try {
      if (mode === 'login') await login(username, password)
      else await register(username, password)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '认证请求失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  const securePage = window.location.protocol === 'https:'

  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <div className="auth-brand">
          <div className="brand-mark auth-brand-mark">
            <span className="brand-orbit" />
            <span className="brand-planet" />
          </div>
          <div>
            <strong>ORBIT</strong>
            <span>研发交付平台</span>
          </div>
        </div>
        <div className="auth-brand-copy">
          <span className="auth-kicker">SECURE DELIVERY WORKSPACE</span>
          <h1>让每一次交付<br />都有迹可循。</h1>
          <p>需求、代码、验证与审查汇聚在同一个安全工作区。账号凭据不会以明文保存，所有受保护请求均需登录会话。</p>
        </div>
        <div className="auth-security-list">
          <span><ShieldCheck size={16} /> scrypt 加盐密码哈希</span>
          <span><LockKeyhole size={16} /> HttpOnly 会话 Cookie</span>
          <span><CheckCircle2 size={16} /> 生产环境强制 HTTPS</span>
        </div>
      </section>

      <section className="auth-form-panel">
        <div className="auth-card">
          <div className="auth-card-head">
            <span className="auth-icon"><KeyRound size={19} /></span>
            <div>
              <h2>{mode === 'login' ? '登录工作区' : '创建账号'}</h2>
              <p>{mode === 'login' ? '使用账号密码继续访问交付平台' : '注册后将自动登录当前工作区'}</p>
            </div>
          </div>

          <div className="auth-tabs" role="tablist">
            <button className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')} role="tab">
              登录
            </button>
            <button className={mode === 'register' ? 'active' : ''} onClick={() => switchMode('register')} role="tab">
              注册
            </button>
          </div>

          {!securePage && (
            <div className="auth-warning">
              <AlertTriangle size={16} />
              <span>当前页面未使用 HTTPS。生产环境请启用证书或反向代理，Cookie 的 Secure 标记会随 HTTPS 自动生效。</span>
            </div>
          )}

          <form onSubmit={submit}>
            <label className="field">
              <span className="field-label">用户名</span>
              <span className="auth-input">
                <UserRound size={16} />
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  placeholder="请输入用户名"
                  minLength={3}
                  maxLength={64}
                  required
                  autoFocus
                />
              </span>
            </label>
            <label className="field">
              <span className="field-label">密码</span>
              <span className="auth-input">
                <LockKeyhole size={16} />
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  placeholder="至少 8 位，包含字母和数字"
                  minLength={8}
                  maxLength={128}
                  required
                />
              </span>
            </label>
            {mode === 'register' && (
              <label className="field">
                <span className="field-label">确认密码</span>
                <span className="auth-input">
                  <LockKeyhole size={16} />
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    autoComplete="new-password"
                    placeholder="再次输入密码"
                    minLength={8}
                    maxLength={128}
                    required
                  />
                </span>
              </label>
            )}

            {error && <div className="auth-error"><AlertTriangle size={15} /> {error}</div>}

            <button className="btn btn-primary auth-submit" type="submit" disabled={submitting}>
              {submitting ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
              {!submitting && <ArrowRight size={16} />}
            </button>
          </form>

          <p className="auth-footnote">
            密码仅以单向哈希形式存储，平台无法查看或还原原始密码。
          </p>
        </div>
      </section>
    </main>
  )
}
