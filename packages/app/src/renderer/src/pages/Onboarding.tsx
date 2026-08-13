/**
 * 五步引导（PRD G1）。
 *
 * 每一步的选择都即时落盘，所以中途关掉应用再打开能接着上次继续，
 * 不会因为走到第四步退出就要从头再来。
 */

import { useEffect, useState, type ReactElement } from 'react'
import {
  AGENT_REGISTRY,
  AUTH_MODE_LABEL,
  IPC,
  CAPABILITY_LABEL,
  type AgentId,
  type DiscoveredAgent,
  type ToastPayload
} from '@youyi/shared'

const STEPS = ['认识哨兵', '发现 Agent', '安装钩子', '绑定微信', '开始值守']

export function Onboarding({
  onDone,
  showToast
}: {
  onDone: () => void
  showToast: (toast: ToastPayload) => void
}): ReactElement {
  const [step, setStep] = useState(0)
  const [discovery, setDiscovery] = useState<DiscoveredAgent[]>([])
  const [selected, setSelected] = useState<AgentId[]>([])
  const [installing, setInstalling] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [qr, setQr] = useState<string | null>(null)
  const [wechatReady, setWechatReady] = useState(false)
  const [verifyCode, setVerifyCode] = useState('')
  const [needVerifyCode, setNeedVerifyCode] = useState(false)

  useEffect(() => {
    void window.youyi.getSettings().then((settings) => {
      setSelected(settings.enabledAgents)
      if (settings.channels.wechat.boundUserId) setWechatReady(true)
    })

    const offQr = window.youyi.on<string>(IPC.pushWechatQr, setQr)
    const offCode = window.youyi.on<boolean>(IPC.pushVerifyCodeRequired, () =>
      setNeedVerifyCode(true)
    )
    const offChannels = window.youyi.on<{ id: string; bound: boolean }[]>(
      IPC.pushChannelStates,
      (states) => {
        const wechat = states.find((s) => s.id === 'wechat')
        if (wechat?.bound) {
          setWechatReady(true)
          setQr(null)
        }
      }
    )
    return () => {
      offQr()
      offCode()
      offChannels()
    }
  }, [])

  useEffect(() => {
    if (step === 1 && discovery.length === 0) {
      void window.youyi.getDiscovery().then(setDiscovery)
    }
  }, [step, discovery.length])

  const installHooks = async (): Promise<void> => {
    setInstalling(true)
    await window.youyi.enableAgents(selected)
    setInstalling(false)
    setInstalled(true)
  }

  const finish = async (): Promise<void> => {
    await window.youyi.finishOnboarding()
    onDone()
  }

  return (
    <div className="onboarding">
      <div className="onboarding__stepper">
        {STEPS.map((label, index) => (
          <div
            key={label}
            className={`step ${index === step ? 'step--active' : ''} ${
              index < step ? 'step--done' : ''
            }`}
          >
            <span className="step__index">{index < step ? '✓' : index + 1}</span>
            <span className="step__label">{label}</span>
          </div>
        ))}
      </div>

      <div className="onboarding__panel">
        {step === 0 && (
          <>
            <h1 className="onboarding__title">游奕会替你盯着这台电脑上的 AI</h1>
            <p className="onboarding__desc">
              它常驻在托盘里，通过各个 AI 应用自带的 Hook 机制感知任务状态。
              任务卡住、需要确认、跑完了，它都会用微信告诉你；你在微信里回一句话，
              它也能把话原样转回给正在干活的 Agent。
            </p>
            <div className="notice notice--info">
              全程只在本机运行：事件数据存在本地，Hook 端点只监听 127.0.0.1，
              修改任何配置前都会先备份。
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h1 className="onboarding__title">看看这台电脑上装了哪些 AI</h1>
            <p className="onboarding__desc">
              勾选你想让哨兵盯着的。能力等级说明它能做到什么程度，装完之后随时可以改。
            </p>
            {discovery.length === 0 && <div className="empty">扫描中…</div>}
            <div className="agent-list">
              {discovery.map((agent) => {
                const checked = selected.includes(agent.id)
                return (
                  <button
                    key={agent.id}
                    className={`agent-item ${checked ? 'agent-item--on' : ''} ${
                      agent.installed ? '' : 'agent-item--off'
                    }`}
                    disabled={!agent.installed}
                    onClick={() =>
                      setSelected((prev) =>
                        checked ? prev.filter((x) => x !== agent.id) : [...prev, agent.id]
                      )
                    }
                  >
                    <div className="agent-item__main">
                      <div className="agent-item__name">
                        {agent.name}
                        <span className="badge badge--gray" style={{ marginLeft: 8 }}>
                          {CAPABILITY_LABEL[agent.level]}
                        </span>
                        {agent.running && (
                          <span className="badge badge--green" style={{ marginLeft: 4 }}>
                            运行中
                          </span>
                        )}
                      </div>
                      <div className="agent-item__desc">
                        {agent.installed
                          ? // 能力上限如实写在这里：各家钩子给到的口子确实不一样
                            `${AUTH_MODE_LABEL[AGENT_REGISTRY[agent.id].authMode]}${
                              agent.evidence.length > 0 ? ` · ${agent.evidence.join('；')}` : ''
                            }`
                          : '这台电脑上没找到它'}
                      </div>
                    </div>
                    <span className={`checkbox ${checked ? 'checkbox--on' : ''}`} />
                  </button>
                )
              })}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="onboarding__title">把钩子装进去</h1>
            <p className="onboarding__desc">
              哨兵会往这些 Agent 的配置文件里加几行钩子配置，让它们在关键节点通知哨兵。
              原有配置会先备份，取消勾选时只会精确移除哨兵自己加的那几行。
            </p>
            <div className="card">
              {selected.length === 0 ? (
                <div className="card__desc">上一步没有勾选任何 Agent，可以退回去选一个。</div>
              ) : (
                selected.map((id) => (
                  <div className="field" key={id}>
                    <div>
                      <div className="field__label">{AGENT_REGISTRY[id].name}</div>
                      <div className="field__hint">{AGENT_REGISTRY[id].configPath}</div>
                    </div>
                    <span className={`badge ${installed ? 'badge--green' : 'badge--gray'}`}>
                      {installed ? '已安装' : '待安装'}
                    </span>
                  </div>
                ))
              )}
            </div>
            {!installed && (
              <button
                className="btn btn--primary"
                style={{ marginTop: 14 }}
                disabled={installing || selected.length === 0}
                onClick={() => void installHooks()}
              >
                {installing ? '正在安装…' : '开始安装'}
              </button>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <h1 className="onboarding__title">用微信扫一下</h1>
            <p className="onboarding__desc">
              扫码之后，所有通知都会发到这个微信上，你也可以直接在对话里回复指令。
            </p>

            {wechatReady ? (
              <div className="notice notice--info">
                微信已连接。<b>记得在微信里先给它发一句话</b>
                ——它需要有一条来自你的消息才能主动给你发通知。
              </div>
            ) : (
              <div className="qr-box">
                {qr ? (
                  <>
                    <img className="qr-box__img" src={qr} alt="微信登录二维码" />
                    <div className="qr-box__hint">用微信扫描这个二维码</div>
                  </>
                ) : (
                  <>
                    <div className="qr-box__placeholder">还没有二维码</div>
                    <button className="btn btn--primary" onClick={() => void window.youyi.bindWechat()}>
                      生成二维码
                    </button>
                  </>
                )}
              </div>
            )}

            {needVerifyCode && (
              <div className="card" style={{ marginTop: 14 }}>
                <div className="card__title">需要输入配对码</div>
                <div className="card__desc">把手机微信上显示的那串数字填进来。</div>
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
                      if (!ok) showToast({ kind: 'error', message: '当前没有在等配对码' })
                    }}
                  >
                    提交
                  </button>
                </div>
              </div>
            )}

            <div className="notice notice--warn" style={{ marginTop: 14 }}>
              也可以先跳过，之后在设置里随时绑定。不绑渠道的话，通知只会留在应用里。
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h1 className="onboarding__title">可以开始了</h1>
            <p className="onboarding__desc">
              哨兵已经在托盘里值守。关掉窗口它不会退出，退出要从托盘菜单点「退出哨兵」。
            </p>
            <div className="card">
              <div className="card__title">在微信里可以这样跟它说话</div>
              <div className="card__desc" style={{ lineHeight: 2 }}>
                继续 / 停止 —— 放行或拒绝正在等确认的操作
                <br />
                状态 —— 看所有 Agent 在干什么
                <br />
                交给 Claude：帮我看下日志 —— 把话转给指定的 Agent
                <br />
                其他任何话 —— 原样转给当前 Agent
              </div>
            </div>
            <label className="autolaunch">
              <input
                type="checkbox"
                onChange={(e) => void window.youyi.setSettings({ autoLaunch: e.target.checked })}
              />
              <span>开机时自动启动哨兵</span>
            </label>
          </>
        )}
      </div>

      <div className="onboarding__actions">
        {step > 0 && (
          <button className="btn" onClick={() => setStep(step - 1)}>
            上一步
          </button>
        )}
        <div style={{ flex: 1 }} />
        {step < STEPS.length - 1 ? (
          <button
            className="btn btn--primary"
            disabled={step === 2 && !installed && selected.length > 0}
            onClick={() => setStep(step + 1)}
          >
            {step === 3 && !wechatReady ? '暂时跳过' : '下一步'}
          </button>
        ) : (
          <button className="btn btn--primary" onClick={() => void finish()}>
            进入面板
          </button>
        )}
      </div>
    </div>
  )
}
