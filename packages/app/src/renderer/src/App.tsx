import { useEffect, useState, type ReactElement } from 'react'
import { useSentinelState } from './state/useSentinelState.js'
import { Onboarding } from './pages/Onboarding.js'
import { Dashboard } from './pages/Dashboard.js'
import { Settings } from './pages/Settings.js'
import { AuditPage } from './pages/Audit.js'

type Page = 'dashboard' | 'settings' | 'audit'

export function App(): ReactElement {
  const state = useSentinelState()
  const [page, setPage] = useState<Page>('dashboard')

  // toast 自动消失，避免遮挡内容
  useEffect(() => {
    if (!state.toast) return
    const timer = setTimeout(() => state.dismissToast(), 3200)
    return () => clearTimeout(timer)
  }, [state])

  if (state.loading || !state.settings) {
    return <div className="empty">正在启动…</div>
  }

  // 没走完引导之前不展示主界面，避免用户看到一个空面板不知所措
  if (!state.settings.onboarded) {
    return <Onboarding onDone={() => void state.refresh()} showToast={state.showToast} />
  }

  const needsAuth = state.pendingAuths.length
  const running = state.tasks.filter((t) => t.status === 'RUNNING').length

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <div className="sidebar__title">游奕</div>
          <div className="sidebar__subtitle">多 Agent 值守中控</div>
        </div>

        <nav className="sidebar__nav">
          <NavItem
            label="任务面板"
            active={page === 'dashboard'}
            badge={needsAuth || undefined}
            onClick={() => setPage('dashboard')}
          />
          <NavItem label="设置" active={page === 'settings'} onClick={() => setPage('settings')} />
          <NavItem label="审计日志" active={page === 'audit'} onClick={() => setPage('audit')} />
        </nav>

        <div className="sidebar__footer">
          <div>
            <span className={`status-dot ${running > 0 ? 'status-dot--on' : ''}`} />
            {running > 0 ? `${running} 个任务进行中` : '值守中'}
          </div>
          <div style={{ marginTop: 6 }}>
            <span
              className={`status-dot ${
                state.channels.find((c) => c.isPrimary)?.bound ? 'status-dot--on' : 'status-dot--warn'
              }`}
            />
            {state.channels.find((c) => c.isPrimary)?.bound ? '微信已连接' : '微信未连接'}
          </div>
        </div>
      </aside>

      <main className="main">
        {page === 'dashboard' && <Dashboard state={state} />}
        {page === 'settings' && <Settings state={state} />}
        {page === 'audit' && <AuditPage />}
      </main>

      {state.toast && <div className="toast">{state.toast.message}</div>}
    </div>
  )
}

function NavItem({
  label,
  active,
  badge,
  onClick
}: {
  label: string
  active: boolean
  badge?: number
  onClick: () => void
}): ReactElement {
  return (
    <button className={`nav-item ${active ? 'nav-item--active' : ''}`} onClick={onClick}>
      <span>{label}</span>
      {badge ? <span className="nav-item__badge">{badge}</span> : null}
    </button>
  )
}
