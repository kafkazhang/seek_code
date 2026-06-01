# SeekCode

> 纯本地 AI 编程桌面工具 · 由 DeepSeek 驱动 · 只需一个 API Key 即可使用

融合 Claude Code（本地结对深度）与 Codex（任务委派）思路，基于 **Electron + Node + React/TypeScript**。
代码、索引、配置全部留在本机。网络出口由白名单强制约束：**用户代码/上下文只发往 DeepSeek 推理接口**；
仅在你主动安装扩展（Skills / MCP）时，才会访问少数公共只读源（GitHub / MCP 注册中心等），且不上传任何代码。

详见 [`技术方案文档.md`](技术方案文档.md)，UI 设计稿见 [`prototype.html`](prototype.html)。

## 特性（当前 MVP）

- 🧠 **结对 Agent**：流式对话 + 工具循环（`read_file` / `list_dir` / `grep` / `write_file` / `edit_file` / `run_command`）
- 🔐 **细粒度权限**：写盘与执行命令默认需手动批准（可在设置中开启自动批准）
- 💰 **缓存优先 + 成本透明**：系统提示与项目地图作为稳定前缀复用，实时展示 DeepSeek 缓存命中率、本会话费用与省下金额
- 🎚️ **混合推理档位（DeepSeek-V4）**：FAST=`deepseek-v4-flash`(thinking 关) · BALANCED=`deepseek-v4-pro`(thinking high) · DEEP=`deepseek-v4-pro`(thinking max)，含思维链展示；三档均支持工具调用
- 🛡️ **纯本地 + 出口白名单**：渲染层与主进程共用同一份白名单（见 `egress.ts`）。推理出口＝DeepSeek（用户代码唯一去处）；生态出口＝安装扩展所需的少数公共只读源；其余一切请求一律拦截
- 🔑 **零配置**：粘贴一个 DeepSeek API Key（safeStorage 加密落盘）即用

## 快速开始

前置：Node.js ≥ 18。

```bash
npm install        # 纯 JS 依赖，无需原生编译工具链
npm run dev        # 启动开发模式（electron-vite）
```

首次启动会弹出配置框：

1. 粘贴 **DeepSeek API Key**（默认接口 `https://api.deepseek.com`）
2. 点「测试连接」确认可用 →「保存并开始」
3. 点标题栏「打开项目文件夹…」选择一个本地项目
4. 在底部输入框提问，例如：“梳理这个项目的整体结构”

## 构建与打包

```bash
npm run build          # 编译主/预加载/渲染三端到 out/
npm run typecheck      # 类型检查（Node 端 + Web 端）
npm run package:win    # 打 Windows 安装包（mac / linux 同理）
```

## 项目结构

```
src/
  main/        # 主进程（Node）：窗口、Agent 内核、工具、网关、IPC、密钥、出口白名单
    index.ts       应用入口、窗口与安全配置
    config.ts      配置与 API Key（safeStorage 加密）
    net.ts         网络出口白名单
    gateway.ts     DeepSeek 网关（唯一出网）+ 缓存优先 Prompt + 成本核算
    tools.ts       文件/命令工具（限定项目目录内）
    agent.ts       Agent 循环（流式 + 工具调用 + 权限闸门）
    ipc.ts         IPC 处理 + 项目文件树 + 审批往返
  preload/     # 预加载（contextBridge 安全桥）
  renderer/    # 渲染进程（React + TS）：编辑界面、对话、成本仪表盘、设置
  shared/      # 主/渲染共享的类型与 IPC 常量
```

## 安全说明

- 渲染进程开启 `contextIsolation` / 关闭 `nodeIntegration` / `sandbox: true`，仅通过白名单 IPC 与主进程通信。
- 文件工具一律限定在当前项目根目录内，拒绝目录穿越。
- API Key 经操作系统级 `safeStorage` 加密保存于 userData，卸载即清除。
- **出口白名单覆盖渲染层与主进程两端**：渲染层经 `webRequest` 拦截，主进程经 `guardedFetch`（走 Electron `net.fetch`）拦截，二者共用 `egress.ts` 的同一判定。用户代码/上下文只发往 DeepSeek；扩展安装/市场仅访问内置的公共只读源；远程 MCP 服务器需用户显式配置后才登记为可信出口。
- DeepSeek 调用仅发生在主进程网关一处，且网关在出网前再次校验 baseURL 在白名单内，便于审计。

> 注：默认模型为 `deepseek-v4-flash` / `deepseek-v4-pro`（OpenAI 兼容协议）。
> 思考深度通过请求体 `thinking` 参数控制：`{ "type": "enabled"|"disabled", "reasoning_effort": "high"|"max" }`。
> V4 起 thinking 与 tools/temperature 解耦——三档推理均可带工具；`frequency_penalty`/`presence_penalty` 已弃用。
> 旧名 `deepseek-chat`/`deepseek-reasoner` 将于 2026-07-24 弃用。
