/** 任务面板（PRD G2）：卡片式任务列表 + 待确认请求 + 任务详情 */

import { useEffect, useState, type ReactElement } from 'react'
import {
  STATUS_COLOR,
  STATUS_LABEL,
  agentName,
  type PendingAuth,
  type Task,
  type UnifiedEvent
} from '@youyi/shared'
import type { useSentinelState } from '../state/useSentinelState.js'

type State = ReturnType<typeof useSentinelState>

export function Dashboard({ state }: { state: State }): ReactElement {
  const [detailId, setDetailId] = useState<string | null>(null)

  const active = state.tasks.filter((t) => ['RUNNING', 'PENDING', 'NEEDS_AUTH'].includes(t.status))
  const finished = state.tasks.filter((t) => ['COMPLETED', 'FAILED', 'STALLED'].includes(t.status))

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">任务面板</h1>
        <p className="page-desc">
          这里是所有 Agent 的实时状态。需要你确认的事会排在最上面，微信里也会同步收到。
        </p>
      </header>

      {state.pendingAuths.length > 0 && (
        <section className="section">
          <div className="section__title">等你确认（{state.pendingAuths.length}）</div>
          {state.pendingAuths.map((auth) => (
            <PendingAuthCard key={auth.id} auth={auth} />
          ))}
        </section>
      )}

      <section className="section">
        <div className="section__title">进行中（{active.length}）</div>
        {active.length === 0 ? (
          <div className="empty">
            当前没有正在跑的任务。
            <br />
            去任意一个已接入的 Agent 里派个活，这里就会亮起来。
          </div>
        ) : (
          <div className="task-grid">
            {active.map((task) => (
              <TaskCard key={task.task_id} task={task} onOpen={() => setDetailId(task.task_id)} />
            ))}
          </div>
        )}
      </section>

      {finished.length > 0 && (
        <section className="section">
          <div className="section__title">已结束（{finished.length}）</div>
          <div className="task-grid">
            {finished.slice(0, 12).map((task) => (
              <TaskCard key={task.task_id} task={task} onOpen={() => setDetailId(task.task_id)} />
            ))}
          </div>
        </section>
      )}

      {detailId && <TaskDetail taskId={detailId} onClose={() => setDetailId(null)} />}
    </>
  )
}

function PendingAuthCard({ auth }: { auth: PendingAuth }): ReactElement {
  const [busy, setBusy] = useState(false)

  const decide = async (decision: 'allow' | 'deny'): Promise<void> => {
    setBusy(true)
    await window.youyi.resolveAuth({ id: auth.id, decision, source: 'dashboard' })
    setBusy(false)
  }

  return (
    <div className="card auth-card">
      <div className="auth-card__head">
        <span className="badge badge--orange">{agentName(auth.agent_id)} 需要确认</span>
        {auth.high_risk && <span className="badge badge--red">高危操作</span>}
      </div>
      <div className="auth-card__text">{auth.request_text}</div>
      {auth.high_risk && (
        <div className="notice notice--danger" style={{ marginTop: 8 }}>
          {auth.high_risk_reason}，这类操作不能通过微信远程放行，只能在这里确认。
        </div>
      )}
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => void decide('allow')}>
          允许这一次
        </button>
        <button className="btn btn--sm" disabled={busy} onClick={() => void decide('deny')}>
          拒绝
        </button>
        <span className="auth-card__expiry">
          {formatRemaining(auth.expires_at)}后自动交回 {agentName(auth.agent_id)} 处理
        </span>
      </div>
    </div>
  )
}

function TaskCard({ task, onOpen }: { task: Task; onOpen: () => void }): ReactElement {
  const color = STATUS_COLOR[task.status]

  return (
    <button className="task-card" onClick={onOpen}>
      <div className="task-card__head">
        <span className="task-card__agent">{agentName(task.agent_id)}</span>
        <span className={`badge badge--${color}`}>{STATUS_LABEL[task.status]}</span>
      </div>
      <div className="task-card__title">{task.title}</div>

      {task.status === 'RUNNING' && (
        <div className="progress">
          <div className="progress__bar" style={{ width: `${Math.round(task.progress * 100)}%` }} />
        </div>
      )}

      <div className="task-card__meta">
        <span>{formatElapsed(task)}</span>
        {task.step_count > 0 && <span>· {task.step_count} 步</span>}
        {task.muted && <span>· 已静音</span>}
      </div>
    </button>
  )
}

function TaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }): ReactElement {
  const [data, setData] = useState<{ task: Task; events: UnifiedEvent[] } | null>(null)

  useEffect(() => {
    void window.youyi.getTaskDetail(taskId).then(setData)
  }, [taskId])

  return (
    <div className="drawer-mask" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        {!data ? (
          <div className="empty">加载中…</div>
        ) : (
          <>
            <div className="drawer__head">
              <div>
                <div className="drawer__title">{data.task.title}</div>
                <div className="drawer__sub">
                  {agentName(data.task.agent_id)} · {STATUS_LABEL[data.task.status]} ·{' '}
                  {formatElapsed(data.task)}
                </div>
              </div>
              <button className="btn btn--sm" onClick={onClose}>
                关闭
              </button>
            </div>

            {data.task.cwd && <div className="drawer__path">{data.task.cwd}</div>}

            {data.task.summary && (
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card__title">最后一次回复</div>
                <div className="card__desc" style={{ whiteSpace: 'pre-wrap' }}>
                  {data.task.summary}
                </div>
              </div>
            )}

            <div className="btn-row" style={{ marginBottom: 14 }}>
              <button
                className="btn btn--sm"
                onClick={() => void window.youyi.muteTask(taskId, !data.task.muted)}
              >
                {data.task.muted ? '取消静音' : '静音这个任务'}
              </button>
            </div>

            <div className="section__title">事件时间线（{data.events.length}）</div>
            <ol className="timeline">
              {data.events
                .slice()
                .reverse()
                .map((event) => (
                  <li key={event.event_id} className="timeline__item">
                    <span className={`timeline__dot timeline__dot--${event.severity}`} />
                    <div>
                      <div className="timeline__title">{event.title}</div>
                      <div className="timeline__detail">{event.detail}</div>
                      <div className="timeline__time">
                        {new Date(event.occurred_at).toLocaleTimeString('zh-CN')} · {event.source.hook}
                      </div>
                    </div>
                  </li>
                ))}
            </ol>
          </>
        )}
      </aside>
    </div>
  )
}

function formatElapsed(task: Task): string {
  const end = task.finished_at ? new Date(task.finished_at) : new Date()
  const minutes = Math.round((end.getTime() - new Date(task.started_at).getTime()) / 60000)
  if (minutes < 1) return '刚刚开始'
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}

function formatRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (ms <= 0) return '即将'
  const minutes = Math.ceil(ms / 60000)
  return `${minutes} 分钟`
}
