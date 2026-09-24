# 新增 GitHub Actions 打包 Windows 安装包工作流

## 背景

本地是 macOS，没有 Windows 打包环境；需要通过 GitHub Actions 的 `windows-latest` runner 产出 NSIS 安装包（`YouYi-x.y.z-setup.exe`）。

## 方案

新增 `.github/workflows/build-windows.yml`：

- **触发方式**：手动触发（`workflow_dispatch`）只构建并上传 Artifact；推送 `v*` 标签则额外创建 GitHub Release 并上传安装包 + `latest.yml` + blockmap（electron-updater 的更新源）。
- **打包步骤**：等价于本地 `npm run pack:win`（npm ci → 根 build 构建全部 workspace → 生成图标 → electron-builder --win），但拆开执行以便给 electron-builder 传 `--publish never`，发 Release 统一交给 `softprops/action-gh-release`，避免 electron-builder 在 CI 检测到 tag 后因缺少 GH_TOKEN 自行发布失败。
- **原生模块**：better-sqlite3 由 electron-builder 的 npmRebuild 在 runner 上针对 Electron ABI 重编，windows-latest 自带 VS 工具链，无需额外步骤。

## 附带修正

`packages/app/electron-builder.yml` 中 `publish.owner/repo` 由占位符 `CHANGE_ME/youyi` 修正为实际仓库 `pengbin897/YouYi`，否则 electron-updater 无法检查更新。

## 影响评估

- 仅新增 CI 配置与修正发布占位符，不影响应用运行时逻辑与本地打包命令。
- Release 创建依赖工作流的 `contents: write` 权限，已在 workflow 中声明，使用默认 `GITHUB_TOKEN`，无需额外配置 Secret。
- 安装包未做代码签名，Windows 安装时会有 SmartScreen 提示，属预期行为。
