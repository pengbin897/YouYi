/**
 * 钩子安装 / 卸载的往返测试。
 *
 * 这些文件是用户自己的资产（~/.claude/settings.json 里往往塞满个人配置，
 * ~/.hermes/config.yaml 里可能还有注释），所以验收标准是：
 * 装完之后用户原有的条目一字不动，卸完之后只剩用户自己的东西。
 *
 * 安全前提：整个用例把 HOME 指向临时目录。下面会先断言方言表里的路径确实落在
 * 临时目录内，万一 HOME 覆盖失效就立刻失败——绝不能真去改开发者本机的配置。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const FAKE_HOME = mkdtempSync(join(tmpdir(), 'youyi-home-'))
const DATA_HOME = mkdtempSync(join(tmpdir(), 'youyi-data-'))
// 必须在导入任何被测模块之前设置：方言表在模块加载时就把 homedir() 定住了
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME
process.env.YOUYI_HOME = DATA_HOME

const dialects = await import('../src/main/adapters/base/dialect.js')
const { JsonHooksAdapter } = await import('../src/main/adapters/base/json-hooks-adapter.js')
const { HermesAdapter } = await import('../src/main/adapters/hermes.js')
const { OpenClawAdapter } = await import('../src/main/adapters/openclaw.js')
const { SettingsStore } = await import('../src/main/config/settings-store.js')
const { ClaudeCodeAdapter } = await import('../src/main/adapters/claude-code.js')
const { CursorAdapter } = await import('../src/main/adapters/cursor.js')
import type { AdapterContext } from '../src/main/adapters/types.js'

const BRIDGE = join(FAKE_HOME, '.youyi', 'bin', 'youyi-hook')
let ctx: AdapterContext

beforeAll(() => {
  // 兜底断言：HOME 没被真正覆盖就直接炸，别把开发者的配置写坏
  for (const dialect of dialects.JSON_DIALECTS) {
    if (!dialect.configFile.startsWith(FAKE_HOME)) {
      throw new Error(`HOME 覆盖失效，${dialect.agentId} 的路径指向了真实目录`)
    }
  }

  const settings = new SettingsStore(join(DATA_HOME, 'settings.json'))
  settings.patch({
    remoteAuth: {
      enabled: true,
      allowPermanentRules: false,
      timeoutMs: 10 * 60 * 1000,
      gateToolUseAgents: ['workbuddy', 'cursor']
    }
  })

  ctx = {
    settings,
    bridgeCommand: () => BRIDGE,
    hookUrl: (agentId: string, event: string) => `http://127.0.0.1:51234/h/tok123/${agentId}/${event}`
  } as unknown as AdapterContext
})

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true })
  rmSync(DATA_HOME, { recursive: true, force: true })
})

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, 'utf8'))
}

describe('Claude Code：原生 HTTP 条目', () => {
  const file = dialects.CLAUDE_CODE_DIALECT.configFile

  it('保留用户原有配置与原有钩子', async () => {
    mkdirSync(join(FAKE_HOME, '.claude'), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        model: 'opus',
        env: { FOO: 'bar' },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] }]
        }
      }),
      'utf8'
    )

    await new ClaudeCodeAdapter().install(ctx)
    const after = readJson(file)

    expect(after.model).toBe('opus')
    expect(after.env).toEqual({ FOO: 'bar' })
    // 用户自己的钩子还在，我们的追加在后面
    expect(after.hooks.PreToolUse[0].hooks[0].command).toBe('my-own-hook')
    expect(after.hooks.PreToolUse[1].hooks[0].type).toBe('http')
    expect(after.hooks.PermissionRequest[0].hooks[0].url).toContain('/claude-code/PermissionRequest')
  })

  it('远程放行的等待窗口要反映到钩子超时上', () => {
    const entry = readJson(file).hooks.PermissionRequest[0].hooks[0]
    // 用户设了 10 分钟，钩子超时必须比它长，否则 Agent 先放弃了
    expect(entry.timeout).toBeGreaterThanOrEqual(600)
  })

  it('重复安装不会堆积条目', async () => {
    await new ClaudeCodeAdapter().install(ctx)
    await new ClaudeCodeAdapter().install(ctx)
    const hooks = readJson(file).hooks.PreToolUse
    expect(hooks).toHaveLength(2)
  })

  it('卸载后只剩用户自己的钩子', async () => {
    await new ClaudeCodeAdapter().uninstall()
    const after = readJson(file)
    expect(after.hooks.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] }
    ])
    expect(after.hooks.PermissionRequest).toBeUndefined()
    expect(after.model).toBe('opus')
  })

  it('备份文件已生成，用户可自行回滚', () => {
    const backups = readFileSync(join(DATA_HOME, 'settings.json'), 'utf8')
    expect(backups).toBeTruthy()
    expect(existsSync(join(DATA_HOME, 'backups'))).toBe(true)
  })
})

describe('Codex / Workbuddy / Qoder：桥接命令条目', () => {
  it('Codex 的 SessionEnd 超时不能超过文档上限 3 秒', async () => {
    await new JsonHooksAdapter(dialects.CODEX_DIALECT).install(ctx)
    const hooks = readJson(dialects.CODEX_DIALECT.configFile).hooks
    expect(hooks.SessionEnd[0].hooks[0].timeout).toBeLessThanOrEqual(3)
    expect(hooks.PreToolUse[0].hooks[0].type).toBe('command')
    // 路径必须带引号：家目录里有空格时 shlex/shell 拆分会散架
    expect(hooks.PreToolUse[0].hooks[0].command).toBe(
      `"${BRIDGE}" --agent chatgpt-codex --event PreToolUse`
    )
  })

  it('Workbuddy 开了工具级闸门后，PreToolUse 超时随之放宽', async () => {
    await new JsonHooksAdapter(dialects.WORKBUDDY_DIALECT).install(ctx)
    const hooks = readJson(dialects.WORKBUDDY_DIALECT.configFile).hooks
    expect(hooks.PreToolUse[0].hooks[0].timeout).toBeGreaterThanOrEqual(600)
  })

  it('Qoder 没开闸门，PreToolUse 保持短超时不拖慢工具调用', async () => {
    await new JsonHooksAdapter(dialects.QODER_DIALECT).install(ctx)
    const hooks = readJson(dialects.QODER_DIALECT.configFile).hooks
    expect(hooks.PreToolUse[0].hooks[0].timeout).toBe(10)
    // 授权走专用事件，那里才需要长超时
    expect(hooks.PermissionRequest[0].hooks[0].timeout).toBeGreaterThanOrEqual(600)
  })

  it('卸载后 hooks 全空', async () => {
    await new JsonHooksAdapter(dialects.QODER_DIALECT).uninstall()
    expect(readJson(dialects.QODER_DIALECT.configFile).hooks).toEqual({})
  })
})

describe('Trae Work：带 version 的独立钩子文件', () => {
  it('写入 version 与 loop_limit', async () => {
    await new JsonHooksAdapter(dialects.TRAE_DIALECT).install(ctx)
    const config = readJson(dialects.TRAE_DIALECT.configFile)
    // 缺 version 整份配置会被 Trae 忽略
    expect(config.version).toBe(1)
    // 注入后 Trae 会再触发 Stop，靠 loop_limit 兜住免得来回续跑
    expect(config.hooks.Stop[0].loop_limit).toBe(3)
  })
})

describe('Cursor：扁平结构的钩子文件', () => {
  const file = join(FAKE_HOME, '.cursor', 'hooks.json')

  it('保留用户原有配置与原有钩子，条目是扁平对象而不是两层嵌套', async () => {
    mkdirSync(join(FAKE_HOME, '.cursor'), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        hooks: {
          afterFileEdit: [{ command: './hooks/format.sh' }]
        }
      }),
      'utf8'
    )

    await new CursorAdapter().install(ctx)
    const after = readJson(file)

    expect(after.version).toBe(1)
    // 用户自己的钩子（afterFileEdit 我们不接管）原样保留
    expect(after.hooks.afterFileEdit).toEqual([{ command: './hooks/format.sh' }])
    // 我们写的条目是扁平对象：{ command, timeout }，没有 matcher/hooks 两层嵌套
    expect(after.hooks.stop[0]).toEqual({
      command: `"${BRIDGE}" --agent cursor --event stop`,
      timeout: 20
    })
    expect(after.hooks.preToolUse[0].command).toBe(`"${BRIDGE}" --agent cursor --event preToolUse`)
  })

  it('开了工具级闸门后，preToolUse 超时随远程放行的等待窗口放宽', async () => {
    const hooks = readJson(file).hooks
    expect(hooks.preToolUse[0].timeout).toBeGreaterThanOrEqual(600)
  })

  it('重复安装不会堆积条目', async () => {
    await new CursorAdapter().install(ctx)
    await new CursorAdapter().install(ctx)
    expect(readJson(file).hooks.stop).toHaveLength(1)
  })

  it('卸载后只剩用户自己的钩子', async () => {
    await new CursorAdapter().uninstall()
    const after = readJson(file)
    expect(after.hooks.afterFileEdit).toEqual([{ command: './hooks/format.sh' }])
    expect(after.hooks.stop).toBeUndefined()
  })
})

describe('Hermes：YAML + 出站 webhook + 授信清单', () => {
  const configFile = join(FAKE_HOME, '.hermes', 'config.yaml')
  const allowlist = join(FAKE_HOME, '.hermes', 'shell-hooks-allowlist.json')

  it('保留用户注释与原有配置', async () => {
    mkdirSync(join(FAKE_HOME, '.hermes'), { recursive: true })
    writeFileSync(
      configFile,
      '# 我自己的注释，别删\nagent:\n  max_verify_nudges: 3\nhooks:\n  post_tool_call:\n    - command: /usr/local/bin/my-logger\n',
      'utf8'
    )

    await new HermesAdapter().install(ctx)
    const yaml = readFileSync(configFile, 'utf8')

    expect(yaml).toContain('# 我自己的注释，别删')
    expect(yaml).toContain('max_verify_nudges: 3')
    expect(yaml).toContain('/usr/local/bin/my-logger')
    expect(yaml).toContain('pre_tool_call')
    expect(yaml).toContain('pre_verify')
  })

  it('shell hook 不 fail_closed，哨兵挂了也不能卡住用户的 Agent', async () => {
    const yaml = readFileSync(configFile, 'utf8')
    expect(yaml).toContain('fail_closed: false')
  })

  it('出站 webhook 只注册一条，事件名由 body 携带', () => {
    const yaml = readFileSync(configFile, 'utf8')
    expect(yaml).toContain('name: youyi')
    expect(yaml).toContain('/hermes/_auto')
    expect(yaml).toContain('on_session_end')
  })

  it('写入授信清单，否则新钩子在非交互环境会被静默跳过', () => {
    const approvals = readJson(allowlist).approvals as { event: string; command: string }[]
    expect(approvals.map((a) => a.event).sort()).toEqual(['pre_tool_call', 'pre_verify'])
    expect(approvals[0].command).toContain('youyi-hook')
  })

  it('不去动 hooks_auto_accept 这个全局开关', () => {
    expect(readFileSync(configFile, 'utf8')).not.toContain('hooks_auto_accept')
  })

  it('卸载后用户的钩子和注释都还在，授信清单里只摘自己的', async () => {
    await new HermesAdapter().uninstall()
    const yaml = readFileSync(configFile, 'utf8')

    expect(yaml).toContain('# 我自己的注释，别删')
    expect(yaml).toContain('/usr/local/bin/my-logger')
    expect(yaml).not.toContain('youyi-hook')
    expect(yaml).not.toContain('pre_verify')
    expect(readJson(allowlist).approvals).toEqual([])
  })
})

describe('OpenClaw：生成 in-process handler', () => {
  const hookDir = join(FAKE_HOME, '.openclaw', 'hooks', 'youyi-sentinel')
  const configFile = join(FAKE_HOME, '.openclaw', 'config.json')

  it('生成 HOOK.md 与 handler.ts，并在配置里启用', async () => {
    mkdirSync(join(FAKE_HOME, '.openclaw'), { recursive: true })
    writeFileSync(configFile, JSON.stringify({ agents: { default: 'main' } }), 'utf8')

    const result = await new OpenClawAdapter().install(ctx)

    const manifest = readFileSync(join(hookDir, 'HOOK.md'), 'utf8')
    expect(manifest).toContain('message:received')
    expect(manifest).toContain('message:sent')

    const handler = readFileSync(join(hookDir, 'handler.ts'), 'utf8')
    expect(handler).toContain('/openclaw/_auto')
    // 不能 await 网络请求，也不能抛异常——这段代码跑在用户的 Agent 进程里
    expect(handler).toContain('void fetch')
    expect(handler).toContain('catch')

    const config = readJson(configFile)
    expect(config.agents).toEqual({ default: 'main' })
    expect(config.hooks.internal.enabled).toBe(true)
    expect(config.hooks.internal.entries['youyi-sentinel'].enabled).toBe(true)

    // 能力上限要如实告知
    expect(result.degradedReason).toContain('只能收通知')
  })

  it('卸载后目录与配置条目一起清掉', async () => {
    await new OpenClawAdapter().uninstall()
    expect(existsSync(hookDir)).toBe(false)
    const config = readJson(configFile)
    expect(config.hooks.internal.entries['youyi-sentinel']).toBeUndefined()
    expect(config.agents).toEqual({ default: 'main' })
  })
})
