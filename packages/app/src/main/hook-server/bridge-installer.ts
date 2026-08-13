/**
 * 把桥接程序与 youyi CLI 部署到 ~/.youyi/bin。
 *
 * 关键考量：这两个脚本都由外部进程拉起（钩子命令被各家 Agent 以子进程方式执行，
 * CLI 被用户或其他程序在终端调用），我们无法假设用户的 PATH 里有 node
 * （Trae/Qoder 是 IDE 内嵌，环境变量与用户 shell 未必一致；Hermes 更是用 shell=False
 * 执行，连 ~ 都不会展开）。因此：
 * - 一律写绝对路径；
 * - 用一个 shell/cmd 包装脚本，以 ELECTRON_RUN_AS_NODE 模式复用哨兵自带的 Electron
 *   二进制当 Node 运行时，用户机器上不需要装 Node。
 */

import { chmodSync, copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { PATHS, ensureDirs } from '../config/paths.js'
import { createLogger } from '../util/logger.js'

const log = createLogger('bridge-installer')

export interface DeployResult {
  /** 可被外部直接执行的包装器绝对路径 */
  command: string
  ok: boolean
  error?: string
}

/** 解析随包资源的源文件路径：打包后在 resources 下，开发模式在各包的 dist 下 */
function resolveSource(resourceDir: string, devRelative: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, resourceDir, 'index.js')
  }
  // 开发模式：out/main → packages/app → packages → packages/<pkg>/dist
  return join(__dirname, '../../..', devRelative, 'dist/index.js')
}

/**
 * 通用部署：把零依赖脚本复制到 ~/.youyi/bin，并生成对应平台的包装器。
 * 包装器以 ELECTRON_RUN_AS_NODE 复用哨兵自带 Electron 作为 Node 运行时。
 */
function deployScript(input: {
  source: string
  scriptName: string
  wrapperUnix: string
  wrapperWin: string
  buildHint: string
}): DeployResult {
  ensureDirs()
  const target = join(PATHS.bin, input.scriptName)
  const wrapper = join(PATHS.bin, process.platform === 'win32' ? input.wrapperWin : input.wrapperUnix)

  try {
    if (!existsSync(input.source)) {
      const error = `找不到脚本：${input.source}（开发模式下需要先执行 ${input.buildHint}）`
      log.error(error)
      return { command: wrapper, ok: false, error }
    }
    copyFileSync(input.source, target)

    if (process.platform === 'win32') {
      writeFileSync(
        wrapper,
        ['@echo off', 'set ELECTRON_RUN_AS_NODE=1', `"${process.execPath}" "${target}" %*`, ''].join(
          '\r\n'
        ),
        'utf8'
      )
    } else {
      writeFileSync(
        wrapper,
        ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${target}" "$@"`, ''].join(
          '\n'
        ),
        'utf8'
      )
      chmodSync(wrapper, 0o755)
    }

    log.info('脚本已部署', { wrapper })
    return { command: wrapper, ok: true }
  } catch (err) {
    log.error('脚本部署失败', { script: input.scriptName, error: String(err) })
    return { command: wrapper, ok: false, error: String(err) }
  }
}

export type BridgeInstallation = DeployResult

export function installBridge(): BridgeInstallation {
  return deployScript({
    source: resolveSource('hook-bridge', 'hook-bridge'),
    scriptName: 'youyi-hook.mjs',
    wrapperUnix: 'youyi-hook',
    wrapperWin: 'youyi-hook.cmd',
    buildHint: 'npm run build -w @youyi/hook-bridge'
  })
}

/** 部署 youyi 命令行客户端（PRD I2）。失败不阻塞启动，只是 CLI 用不了。 */
export function installCli(): DeployResult {
  return deployScript({
    source: resolveSource('cli', 'cli'),
    scriptName: 'youyi-cli.mjs',
    wrapperUnix: 'youyi',
    wrapperWin: 'youyi.cmd',
    buildHint: 'npm run build -w @youyi/cli'
  })
}
