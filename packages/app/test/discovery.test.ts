/**
 * 自动发现的判定测试。
 *
 * 关注三件容易出错的事：
 * 1. IDE 类的几家不在 PATH 上，得按平台惯例找到应用本体；
 * 2. 只剩配置目录（卸载残留）不能当成「装着」，要如实标 configOnly；
 * 3. 自动发现漏掉时，用户手动添加要能兜住。
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const FAKE_HOME = mkdtempSync(join(tmpdir(), 'youyi-detect-'))
const DATA_HOME = mkdtempSync(join(tmpdir(), 'youyi-detect-data-'))
process.env.HOME = FAKE_HOME
process.env.YOUYI_HOME = DATA_HOME

const dialects = await import('../src/main/adapters/base/dialect.js')
const { JsonHooksAdapter } = await import('../src/main/adapters/base/json-hooks-adapter.js')
const { AdapterRegistry } = await import('../src/main/adapters/registry.js')
const { SettingsStore } = await import('../src/main/config/settings-store.js')
const { appInstallPaths } = await import('../src/main/util/process-scan.js')
import type { AdapterContext } from '../src/main/adapters/types.js'

let settings: InstanceType<typeof SettingsStore>
let ctx: AdapterContext

beforeAll(() => {
  settings = new SettingsStore(join(DATA_HOME, 'settings.json'))
  ctx = { settings } as unknown as AdapterContext
})

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true })
  rmSync(DATA_HOME, { recursive: true, force: true })
})

describe('安装位置探测', () => {
  it('图形应用按平台惯例给出候选路径', () => {
    const paths = appInstallPaths('Qoder')
    if (process.platform === 'darwin') {
      expect(paths).toContain('/Applications/Qoder.app')
    } else if (process.platform === 'win32') {
      expect(paths.length).toBeGreaterThan(0)
    }
  })

  /** 合成方言：开发机上可能真装着 Qoder / Trae，用真方言就变成在测这台机器了 */
  function ghostDialect(dir: string): (typeof dialects)['QODER_DIALECT'] {
    return {
      ...dialects.QODER_DIALECT,
      configFile: join(dir, 'settings.json'),
      detect: {
        bins: ['definitely-not-installed-youyi'],
        dirs: [dir],
        apps: ['DefinitelyNotInstalledYouyi'],
        processes: ['definitely-not-installed-youyi']
      }
    }
  }

  it('配置目录早就没动静了，才算卸载残留', async () => {
    const stale = join(FAKE_HOME, '.stale-agent')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'settings.json'), '{}', 'utf8')
    // 把目录时间调到一年前，模拟「卸载后留下的空壳」
    const longAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    utimesSync(stale, longAgo, longAgo)

    const result = await new JsonHooksAdapter(ghostDialect(stale)).detect()
    expect(result.installed).toBe(true)
    expect(result.configOnly).toBe(true)
    expect(result.evidence.join()).toContain('配置目录')
  })

  it('配置目录近期还在用，就不该报「只找到配置」', async () => {
    // 真实场景：claude 装在版本管理器里，PATH 上查不到，
    // 但 ~/.claude 每天都在写会话记录——这时候报卸载残留就是误判
    const active = join(FAKE_HOME, '.active-agent')
    mkdirSync(join(active, 'sessions'), { recursive: true })
    writeFileSync(join(active, 'settings.json'), '{}', 'utf8')

    const result = await new JsonHooksAdapter(ghostDialect(active)).detect()
    expect(result.installed).toBe(true)
    expect(result.configOnly).toBe(false)
    expect(result.evidence.join()).toContain('最近有使用记录')
  })

  it('什么都没有就是没装', async () => {
    const result = await new JsonHooksAdapter({
      ...dialects.WORKBUDDY_DIALECT,
      configFile: join(FAKE_HOME, '.nope', 'settings.json'),
      detect: {
        bins: ['definitely-not-installed-youyi'],
        dirs: [join(FAKE_HOME, '.nope')],
        processes: ['definitely-not-installed-youyi']
      }
    }).detect()

    expect(result.installed).toBe(false)
    expect(result.evidence).toEqual([])
  })
})

describe('手动添加兜底', () => {
  it('用户认领后即视为已安装，并说明依据是手动添加', async () => {
    const registry = new AdapterRegistry(ctx)
    registry.register(
      new JsonHooksAdapter({
        ...dialects.WORKBUDDY_DIALECT,
        configFile: join(FAKE_HOME, '.nope', 'settings.json'),
        detect: {
          bins: ['definitely-not-installed-youyi'],
          dirs: [join(FAKE_HOME, '.nope')],
          processes: ['definitely-not-installed-youyi']
        }
      })
    )

    let list = await registry.detectAll()
    expect(list[0].installed).toBe(false)

    settings.patch({ manualAgents: ['workbuddy'] })
    list = await registry.detectAll()
    expect(list[0].installed).toBe(true)
    expect(list[0].evidence).toContain('你手动添加的')
  })
})

describe('事件归属纠正', () => {
  it('带 Trae 特征字段的事件不会挂到 Claude Code 名下', async () => {
    const seen: string[] = []
    const registry = new AdapterRegistry(ctx)
    // 两个占位适配器，只记录自己收到了什么
    for (const id of ['claude-code', 'trae-work'] as const) {
      registry.register({
        id,
        install: async () => ({ ok: true, touchedFiles: [] }),
        uninstall: async () => undefined,
        detect: async () => ({ installed: true, running: false, configOnly: false, evidence: [] }),
        handle: async () => {
          seen.push(id)
          return {}
        }
      })
    }

    await registry.dispatch({
      agentId: 'claude-code',
      event: 'PreToolUse',
      // Trae 独有：Claude Code 的 payload 里没有这两个字段
      payload: { workspace_roots: ['/Users/demo/web'], llm_tool_name: 'run_command' },
      transport: 'bridge'
    })
    expect(seen).toEqual(['trae-work'])

    await registry.dispatch({
      agentId: 'claude-code',
      event: 'PreToolUse',
      payload: { tool_name: 'Bash', tool_input: { command: 'ls' } },
      transport: 'http'
    })
    expect(seen).toEqual(['trae-work', 'claude-code'])
  })
})
