/** 审计日志（PRD G4）：所有远程指令与通知发送都要可追溯 */

import { useEffect, useState, type ReactElement } from 'react'
import { agentName, type AgentId, type AuditLog } from '@youyi/shared'

const ACTION_LABEL: Record<string, string> = {
  remote_auth: '远程放行',
  relay: '消息透传',
  reply_back: '回复回传',
  broadcast_stop: '全部停止',
  notify: '通知发送',
  hook_install: '钩子安装',
  data_clear: '清除数据'
}

const RESULT_BADGE: Record<string, string> = {
  success: 'badge--green',
  failed: 'badge--red',
  denied: 'badge--orange',
  pending: 'badge--gray'
}

const RESULT_LABEL: Record<string, string> = {
  success: '成功',
  failed: '失败',
  denied: '已拒绝',
  pending: '等待中'
}

export function AuditPage(): ReactElement {
  const [logs, setLogs] = useState<AuditLog[]>([])

  useEffect(() => {
    void window.youyi.getAuditLogs(300).then(setLogs)
  }, [])

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">审计日志</h1>
        <p className="page-desc">
          每一条从微信发来的指令、每一次远程放行、每一条发出去的通知都记在这里。
        </p>
      </header>

      <div className="card">
        {logs.length === 0 ? (
          <div className="empty">还没有任何记录。</div>
        ) : (
          <table className="audit-table">
            <thead>
              <tr>
                <th style={{ width: 130 }}>时间</th>
                <th style={{ width: 90 }}>类型</th>
                <th style={{ width: 100 }}>对象</th>
                <th>内容</th>
                <th style={{ width: 70 }}>结果</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td style={{ color: 'var(--ink3)' }}>
                    {new Date(log.created_at).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </td>
                  <td>{ACTION_LABEL[log.action] ?? log.action}</td>
                  <td>{log.agent_id ? agentName(log.agent_id as AgentId) : (log.channel ?? '—')}</td>
                  <td>{log.summary}</td>
                  <td>
                    <span className={`badge ${RESULT_BADGE[log.result] ?? 'badge--gray'}`}>
                      {RESULT_LABEL[log.result] ?? log.result}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
