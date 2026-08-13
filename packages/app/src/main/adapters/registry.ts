/** 适配器注册表：钩子请求的派发中枢，以及批量安装/卸载与自动发现的入口 */

import { AGENT_REGISTRY, type AgentId, type DiscoveredAgent } from '@youyi/shared'
import type { HookOutcome, HookRequest } from '../hook-server/server.js'
import { createLogger } from '../util/logger.js'
import type { AdapterContext, AgentAdapter, InstallResult } from './types.js'

const log = createLogger('adapters')

export class AdapterRegistry {
  private readonly adapters = new Map<AgentId, AgentAdapter>()

  constructor(private readonly ctx: AdapterContext) {}

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  get(id: AgentId): AgentAdapter | undefined {
    return this.adapters.get(id)
  }

  all(): AgentAdapter[] {
    return [...this.adapters.values()]
  }

  /**
   * 纠正事件归属。
   *
   * Trae Work 除了自己的 ~/.trae-cn/hooks.json，还会读取 ~/.claude/settings.json，
   * 也就是我们装给 Claude Code 的钩子可能被 Trae 一并执行，事件会挂到 Claude 名下。
   * 好在 Trae 的 payload 带着 workspace_roots / llm_tool_name 这两个 Claude 没有的字段，
   * 据此改判归属，免得两家的任务在面板上串成一条。
   */
  private reattribute(req: HookRequest): HookRequest {
    if (req.agentId !== 'claude-code' || !this.adapters.has('trae-work')) return req

    const payload = req.payload as { workspace_roots?: unknown; llm_tool_name?: unknown }
    const looksLikeTrae =
      Array.isArray(payload.workspace_roots) || typeof payload.llm_tool_name === 'string'
    if (!looksLikeTrae) return req

    log.info('事件带 Trae 特征字段，改判归属', { event: req.event })
    return { ...req, agentId: 'trae-work' }
  }

  /** HookServer 的派发入口。任何异常都收敛成放行，不能因为哨兵出错卡住用户的 Agent。 */
  async dispatch(input: HookRequest): Promise<HookOutcome> {
    const req = this.reattribute(input)
    const adapter = this.adapters.get(req.agentId)
    if (!adapter) {
      log.warn('没有对应的适配器，放行', { agent: req.agentId, event: req.event })
      return { exit: 0 }
    }
    try {
      return await adapter.handle(req, this.ctx)
    } catch (err) {
      log.error('适配器处理事件失败，放行', {
        agent: req.agentId,
        event: req.event,
        error: String(err)
      })
      return { exit: 0 }
    }
  }

  async install(ids: AgentId[]): Promise<Map<AgentId, InstallResult>> {
    const results = new Map<AgentId, InstallResult>()
    for (const id of ids) {
      const adapter = this.adapters.get(id)
      if (!adapter) continue
      try {
        const result = await adapter.install(this.ctx)
        results.set(id, result)
        log.info('钩子安装完成', { agent: id, ok: result.ok, files: result.touchedFiles })
      } catch (err) {
        log.error('钩子安装失败', { agent: id, error: String(err) })
        results.set(id, {
          ok: false,
          degradedReason: `安装失败：${String(err)}`,
          touchedFiles: []
        })
      }
    }
    return results
  }

  async uninstall(ids: AgentId[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.adapters.get(id)?.uninstall(this.ctx)
        log.info('钩子已卸载', { agent: id })
      } catch (err) {
        log.error('钩子卸载失败', { agent: id, error: String(err) })
      }
    }
  }

  /** 自动发现：并发探测所有已注册适配器（PRD B2） */
  async detectAll(): Promise<DiscoveredAgent[]> {
    const manual = this.ctx.settings.get().manualAgents
    const entries = await Promise.all(
      this.all().map(async (adapter) => {
        const meta = AGENT_REGISTRY[adapter.id]
        const manuallyAdded = manual.includes(adapter.id)
        try {
          const detected = await adapter.detect()
          const evidence = manuallyAdded
            ? [...detected.evidence, '你手动添加的']
            : detected.evidence
          return {
            id: adapter.id,
            name: meta.name,
            subtitle: meta.subtitle,
            level: meta.level,
            // 用户说装了就按装了算，自动发现不是唯一依据
            installed: detected.installed || manuallyAdded,
            running: detected.running,
            configOnly: detected.configOnly,
            evidence
          } satisfies DiscoveredAgent
        } catch (err) {
          log.warn('探测失败', { agent: adapter.id, error: String(err) })
          return {
            id: adapter.id,
            name: meta.name,
            subtitle: meta.subtitle,
            level: meta.level,
            installed: manuallyAdded,
            running: false,
            configOnly: false,
            evidence: manuallyAdded ? ['你手动添加的'] : []
          } satisfies DiscoveredAgent
        }
      })
    )
    return entries
  }
}
