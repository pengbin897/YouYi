/** 设置页（PRD G4）：渠道、打扰档位、免打扰、自启、远程放行、隐私与数据 */

import { useEffect, useState, type ReactElement } from 'react'
import {
  AGENT_REGISTRY,
  ALL_AGENTS,
  AUTH_MODE_LABEL,
  CHANNEL_LABEL,
  CAPABILITY_LABEL,
  IPC,
  NOTIFY_TIER_DESC,
  NOTIFY_TIER_LABEL,
  type AgentId,
  type DiscoveredAgent,
  type NotifyTier
} from '@youyi/shared'
import type { useSentinelState } from '../state/useSentinelState.js'

type State = ReturnType<typeof useSentinelState>

const TIERS: NotifyTier[] = ['quiet', 'standard', 'full']

/** 只有这三家是 webhook 形态，单列出来才能在下面安全地按 key 取 url */
type WebhookChannelId = 'feishu' | 'dingtalk' | 'wecom'
const WEBHOOK_CHANNELS: WebhookChannelId[] = ['feishu', 'dingtalk', 'wecom']

export function Settings({ state }: { state: State }): ReactElement {
  const settings = state.settings!
  const [discovery, setDiscovery] = useState<DiscoveredAgent[]>([])
  const [busy, setBusy] = useState(false)
  // 微信重新扫码：会话过期后渠道会自愈并推一张新二维码过来，这里需要能接住并展示，
  // 否则用户点「重新绑定」或者会话自动过期恢复时，界面上什么反应都看不到
  const [wechatQr, setWechatQr] = useState<string | null>(null)
  const [needVerifyCode, setNeedVerifyCode] = useState(false)
  const [verifyCode, setVerifyCode] = useState('')
  const wechatBound = state.channels.find((c) => c.id === 'wechat')?.bound ?? false

  useEffect(() => {
    void window.youyi.getDiscovery().then(setDiscovery)
  }, [])

  useEffect(() => {
    const offQr = window.youyi.on<string>(IPC.pushWechatQr, setWechatQr)
    const offCode = window.youyi.on<boolean>(IPC.pushVerifyCodeRequired, () =>
      setNeedVerifyCode(true)
    )
    return () => {
      offQr()
      offCode()
    }
  }, [])

  // 重新连上之后二维码就没用了，及时清掉避免残留在页面上
  useEffect(() => {
    if (wechatBound) {
      setWechatQr(null)
      setNeedVerifyCode(false)
    }
  }, [wechatBound])

  const toggleAgent = async (id: AgentId): Promise<void> => {
    const enabled = settings.enabledAgents.includes(id)
    const next = enabled
      ? settings.enabledAgents.filter((x) => x !== id)
      : [...settings.enabledAgents, id]
    setBusy(true)
    await window.youyi.enableAgents(next)
    await state.refresh()
    setBusy(false)
  }

  /** 自动发现漏掉的，用户可以自己认领；认领后重新扫一遍拿到最新证据 */
  const addManually = async (id: AgentId): Promise<void> => {
    setBusy(true)
    await state.patchSettings({ manualAgents: [...settings.manualAgents, id] })
    setDiscovery(await window.youyi.getDiscovery())
    setBusy(false)
  }

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">设置</h1>
        <p className="page-desc">所有配置只保存在这台电脑上。</p>
      </header>

      <section className="section">
        <div className="section__title">接入的 Agent</div>
        <div className="card">
          {discovery.length === 0 && <div className="card__desc">正在扫描本机的 AI 应用…</div>}
          {discovery.map((agent) => {
            const meta = AGENT_REGISTRY[agent.id]
            const enabled = settings.enabledAgents.includes(agent.id)
            return (
              <div className="field" key={agent.id}>
                <div>
                  <div className="field__label">
                    {agent.name}
                    <span className="badge badge--gray" style={{ marginLeft: 8 }}>
                      {CAPABILITY_LABEL[agent.level]}
                    </span>
                    {agent.running && (
                      <span className="badge badge--green" style={{ marginLeft: 4 }}>
                        运行中
                      </span>
                    )}
                    {!agent.installed && (
                      <span className="badge badge--gray" style={{ marginLeft: 4 }}>
                        未检测到
                      </span>
                    )}
                    {agent.configOnly && (
                      <span className="badge badge--orange" style={{ marginLeft: 4 }}>
                        只找到配置
                      </span>
                    )}
                  </div>
                  <div className="field__hint">
                    {meta.subtitle} · {AUTH_MODE_LABEL[meta.authMode]}
                    {agent.evidence.length > 0 && ` · ${agent.evidence.join('；')}`}
                  </div>
                </div>
                {/* 装在非常规位置时自动发现会漏，给个手动兜底而不是让开关一直灰着 */}
                {agent.installed ? (
                  <button
                    className={`switch ${enabled ? 'switch--on' : ''}`}
                    disabled={busy}
                    onClick={() => void toggleAgent(agent.id)}
                    aria-label={`接入 ${agent.name}`}
                  />
                ) : (
                  <button
                    className="btn btn--sm"
                    disabled={busy}
                    onClick={() => void addManually(agent.id)}
                  >
                    我装了，手动添加
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </section>

      <section className="section">
        <div className="section__title">通知</div>
        <div className="card">
          <div className="field">
            <div>
              <div className="field__label">打扰档位</div>
              <div className="field__hint">{NOTIFY_TIER_DESC[settings.notifyTier]}</div>
            </div>
            <div className="segmented">
              {TIERS.map((tier) => (
                <button
                  key={tier}
                  className={`segmented__item ${
                    settings.notifyTier === tier ? 'segmented__item--active' : ''
                  }`}
                  onClick={() => void state.patchSettings({ notifyTier: tier })}
                >
                  {NOTIFY_TIER_LABEL[tier]}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <div>
              <div className="field__label">免打扰时段</div>
              <div className="field__hint">
                时段内只有「需要你确认」会立刻推送，其余攒到早报一起发。
              </div>
            </div>
            <div className="btn-row">
              <input
                className="input"
                style={{ minWidth: 80 }}
                type="time"
                value={settings.dnd.start}
                onChange={(e) =>
                  void state.patchSettings({ dnd: { ...settings.dnd, start: e.target.value } })
                }
              />
              <span style={{ color: 'var(--ink3)' }}>至</span>
              <input
                className="input"
                style={{ minWidth: 80 }}
                type="time"
                value={settings.dnd.end}
                onChange={(e) =>
                  void state.patchSettings({ dnd: { ...settings.dnd, end: e.target.value } })
                }
              />
              <button
                className={`switch ${settings.dnd.enabled ? 'switch--on' : ''}`}
                onClick={() =>
                  void state.patchSettings({ dnd: { ...settings.dnd, enabled: !settings.dnd.enabled } })
                }
                aria-label="免打扰开关"
              />
            </div>
          </div>

          <div className="field">
            <div>
              <div className="field__label">早报时间</div>
              <div className="field__hint">免打扰期间攒下的消息会在这个时间汇总成一条。没有内容就不发。</div>
            </div>
            <input
              className="input"
              style={{ minWidth: 80 }}
              type="time"
              value={settings.digestTime}
              onChange={(e) => void state.patchSettings({ digestTime: e.target.value })}
            />
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__title">渠道</div>
        <div className="card">
          <div className="field">
            <div>
              <div className="field__label">
                微信
                <span
                  className={`badge ${
                    state.channels.find((c) => c.id === 'wechat')?.bound
                      ? 'badge--green'
                      : 'badge--gray'
                  }`}
                  style={{ marginLeft: 8 }}
                >
                  {state.channels.find((c) => c.id === 'wechat')?.bound ? '已连接' : '未连接'}
                </span>
              </div>
              <div className="field__hint">
                主渠道。绑定后记得先在微信里给它发一句话，否则它没有会话上下文，通知发不出来。
              </div>
            </div>
            <div className="btn-row">
              <button
                className="btn btn--sm"
                onClick={() => {
                  setWechatQr(null)
                  void window.youyi.bindWechat()
                }}
              >
                重新绑定
              </button>
              <button
                className="btn btn--sm"
                onClick={async () => {
                  const result = await window.youyi.testChannel('wechat')
                  state.showToast({
                    kind: result.ok ? 'success' : 'error',
                    message: result.ok ? '测试消息已发出' : `发送失败：${result.error}`
                  })
                }}
              >
                发条测试
              </button>
            </div>
          </div>

          {!wechatBound && wechatQr && (
            <div className="qr-box" style={{ margin: '4px 0 16px' }}>
              <img className="qr-box__img" src={wechatQr} alt="微信登录二维码" />
              <div className="qr-box__hint">用微信扫描这个二维码重新登录</div>
            </div>
          )}

          {needVerifyCode && (
            <div className="field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div>
                <div className="field__label">需要输入配对码</div>
                <div className="field__hint">把手机微信上显示的那串数字填进来。</div>
              </div>
              <div className="btn-row" style={{ marginTop: 10 }}>
                <input
                  className="input"
                  value={verifyCode}
                  placeholder="配对码"
                  onChange={(e) => setVerifyCode(e.target.value)}
                />
                <button
                  className="btn btn--primary btn--sm"
                  onClick={async () => {
                    const ok = await window.youyi.submitVerifyCode(verifyCode)
                    setNeedVerifyCode(!ok)
                    setVerifyCode('')
                    if (!ok) state.showToast({ kind: 'error', message: '当前没有在等配对码' })
                  }}
                >
                  提交
                </button>
              </div>
            </div>
          )}

          {WEBHOOK_CHANNELS.map((id: WebhookChannelId) => {
            const config = settings.channels[id]
            return (
              <div className="field" key={id}>
                <div>
                  <div className="field__label">{CHANNEL_LABEL[id]}群机器人</div>
                  <div className="field__hint">
                    只能收通知，没法在群里回话——它们的上行消息需要公网回调地址，本地应用拿不到。
                  </div>
                </div>
                <input
                  className="input"
                  placeholder="粘贴 webhook 地址"
                  defaultValue={config.url}
                  onBlur={(e) =>
                    void state.patchSettings({
                      channels: {
                        ...settings.channels,
                        [id]: { enabled: Boolean(e.target.value), url: e.target.value }
                      }
                    })
                  }
                />
              </div>
            )
          })}

          <div className="field">
            <div>
              <div className="field__label">邮件兜底</div>
              <div className="field__hint">微信连续 2 次发送失败时改用邮件，恢复后自动切回。</div>
            </div>
            <div className="btn-row">
              <input
                className="input"
                style={{ minWidth: 130 }}
                placeholder="SMTP 服务器"
                defaultValue={settings.channels.email.host}
                onBlur={(e) => void patchEmail(state, { host: e.target.value })}
              />
              <input
                className="input"
                style={{ minWidth: 130 }}
                placeholder="账号"
                defaultValue={settings.channels.email.user}
                onBlur={(e) => void patchEmail(state, { user: e.target.value })}
              />
              <input
                className="input"
                style={{ minWidth: 110 }}
                type="password"
                placeholder="密码"
                defaultValue={settings.channels.email.pass}
                onBlur={(e) => void patchEmail(state, { pass: e.target.value })}
              />
              <input
                className="input"
                style={{ minWidth: 150 }}
                placeholder="收件人"
                defaultValue={settings.channels.email.to}
                onBlur={(e) => void patchEmail(state, { to: e.target.value, enabled: true })}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__title">远程放行</div>
        <div className="card">
          <div className="field">
            <div>
              <div className="field__label">允许在微信里放行 Agent 的操作</div>
              <div className="field__hint">
                关掉之后微信只能收通知、看状态，所有确认都必须回到电脑上做。
              </div>
            </div>
            <button
              className={`switch ${settings.remoteAuth.enabled ? 'switch--on' : ''}`}
              onClick={() =>
                void state.patchSettings({
                  remoteAuth: { ...settings.remoteAuth, enabled: !settings.remoteAuth.enabled }
                })
              }
              aria-label="远程放行开关"
            />
          </div>
          <div className="field">
            <div>
              <div className="field__label">允许写入永久放行规则</div>
              <div className="field__hint">
                默认关闭。开启后「继续」会让 Agent 记住这类操作以后都不用问，风险明显更高。
              </div>
            </div>
            <button
              className={`switch ${settings.remoteAuth.allowPermanentRules ? 'switch--on' : ''}`}
              onClick={() =>
                void state.patchSettings({
                  remoteAuth: {
                    ...settings.remoteAuth,
                    allowPermanentRules: !settings.remoteAuth.allowPermanentRules
                  }
                })
              }
              aria-label="永久规则开关"
            />
          </div>

          {/* 没有专用授权钩子的几家，只能拦在「工具调用前」，代价是会拖慢每次写文件与执行命令 */}
          {ALL_AGENTS.filter((meta) => meta.needsToolGate).map((meta) => {
            const on = settings.remoteAuth.gateToolUseAgents.includes(meta.id)
            return (
              <div className="field" key={meta.id}>
                <div>
                  <div className="field__label">在 {meta.name} 上拦下每次改动操作</div>
                  <div className="field__hint">
                    {meta.name} 没有专门的「需要确认」钩子，只能拦在工具调用前。开启后它每次写
                    文件或执行命令都会先等你回微信（等不到就自动转成本机确认），读代码、搜索不受
                    影响。
                  </div>
                </div>
                <button
                  className={`switch ${on ? 'switch--on' : ''}`}
                  onClick={() =>
                    void state.patchSettings({
                      remoteAuth: {
                        ...settings.remoteAuth,
                        gateToolUseAgents: on
                          ? settings.remoteAuth.gateToolUseAgents.filter((id) => id !== meta.id)
                          : [...settings.remoteAuth.gateToolUseAgents, meta.id]
                      }
                    })
                  }
                  aria-label={`${meta.name} 工具级闸门开关`}
                />
              </div>
            )
          })}

          <div className="notice notice--warn" style={{ marginTop: 4 }}>
            删除、推送代码、发布、支付、动云资源、碰密钥这些操作永远不能远程放行，
            无论开关怎么设置——它们做错了收不回来。
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__title">系统</div>
        <div className="card">
          <div className="field">
            <div>
              <div className="field__label">开机自启</div>
              <div className="field__hint">开机后直接进托盘值守，不弹窗打扰你。</div>
            </div>
            <button
              className={`switch ${settings.autoLaunch ? 'switch--on' : ''}`}
              onClick={() => void state.patchSettings({ autoLaunch: !settings.autoLaunch })}
              aria-label="开机自启开关"
            />
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__title">隐私与数据</div>
        <div className="card">
          <div className="card__desc" style={{ marginBottom: 12, lineHeight: 1.8 }}>
            · 所有任务、事件、日志都只存在本机 <code>~/.youyi</code>，没有任何上云路径。
            <br />· Hook 端点只监听 127.0.0.1，外部网络访问不到。
            <br />· 修改任何 Agent 的配置前都会先备份到 <code>~/.youyi/backups</code>。
            <br />· 通知里只带任务标题与状态摘要，不会把代码内容发出去。
          </div>
          <div className="btn-row">
            <button
              className="btn btn--sm"
              onClick={async () => {
                const path = await window.youyi.exportAudit()
                if (path) state.showToast({ kind: 'success', message: `已导出到 ${path}` })
              }}
            >
              导出审计日志
            </button>
            <button
              className="btn btn--sm btn--danger"
              onClick={async () => {
                await window.youyi.clearAllData()
                await state.refresh()
              }}
            >
              清除全部数据
            </button>
          </div>
        </div>
      </section>
    </>
  )
}

async function patchEmail(
  state: State,
  patch: Partial<{ host: string; user: string; pass: string; to: string; enabled: boolean }>
): Promise<void> {
  const settings = state.settings!
  await state.patchSettings({
    channels: { ...settings.channels, email: { ...settings.channels.email, ...patch } }
  })
}
