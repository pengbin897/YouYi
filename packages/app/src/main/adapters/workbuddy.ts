/**
 * Workbuddy（CodeBuddy Code）适配器。
 *
 * 钩子机制与其他 Claude 系方言完全一致（见 JsonHooksAdapter），唯一差异是额外实现
 * resumeSession：通过 CodeBuddy Agent SDK 的 query() + Options.resume 无头续跑一个
 * 已有会话，为前端会话续聊（v1.1）提供消息投递与回复收集能力。
 *
 * 关键约定：
 * - settingSources 必须显式加载 user 级配置。SDK 默认不加载任何文件系统配置，
 *   漏了这一项哨兵装的钩子就不会触发，任务面板将看不到这一轮的生命周期。
 * - 只用 V1 稳定 API（query），不碰 unstable_v2_*（实验期，接口可能变化）。
 */

import { AbortError, CLIStartupError, ExecutionError, query } from '@tencent-ai/agent-sdk'
import { WORKBUDDY_DIALECT } from './base/dialect.js'
import { JsonHooksAdapter } from './base/json-hooks-adapter.js'
import { createLogger } from '../util/logger.js'

/** 一轮无头续跑的上限，与 sendHeadless 的超时约定保持一致 */
const RESUME_TIMEOUT_MS = 10 * 60 * 1000

export class WorkbuddyAdapter extends JsonHooksAdapter {
  private readonly sdkLog = createLogger('workbuddy-sdk')

  constructor() {
    super(WORKBUDDY_DIALECT)
  }

  async resumeSession(
    text: string,
    options: { sessionId: string; cwd?: string; abortController?: AbortController }
  ): Promise<{ ok: boolean; reply?: string; error?: string }> {
    // 调用方（SessionChat）持控制器用于应用退出时叫停；超时也走同一个控制器
    const controller = options.abortController ?? new AbortController()
    const timer = setTimeout(() => controller.abort(), RESUME_TIMEOUT_MS)
    timer.unref?.()

    try {
      const q = query({
        prompt: text,
        options: {
          resume: options.sessionId,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          settingSources: ['user'],
          abortController: controller,
          stderr: (data) => this.sdkLog.debug('CLI stderr', data)
        }
      })

      let reply = ''
      for await (const message of q) {
        // query() 在首个 result 消息后自动收尾，这里只需接住最终结果
        if (message.type === 'result' && message.subtype === 'success') {
          reply = message.result
        }
      }
      return reply ? { ok: true, reply } : { ok: true }
    } catch (err) {
      const error = describeError(err)
      this.sdkLog.warn('无头续跑失败', { session: options.sessionId, error })
      return { ok: false, error }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 把 SDK 的错误翻译成用户能看懂的一句话 */
function describeError(err: unknown): string {
  if (err instanceof AbortError) return '这一轮超时或被中断了。'
  if (err instanceof CLIStartupError) {
    return 'CodeBuddy CLI 没能启动，请确认它已安装并登录。'
  }
  if (err instanceof ExecutionError) {
    return `执行出错：${err.errors.join('；') || err.message}`
  }
  return String(err instanceof Error ? err.message : err)
}
