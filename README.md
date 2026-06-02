<div align="center">

# SeekCode

### 🔒 纯本地 AI 编程工作站 · 由 DeepSeek 驱动 · 一个 API Key 即用

**A privacy-first, fully-local AI coding agent & IDE for your desktop — powered by DeepSeek.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue.svg)](#构建与打包)
[![Built with Electron](https://img.shields.io/badge/Electron-31-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Powered by DeepSeek](https://img.shields.io/badge/Powered%20by-DeepSeek-6E5BFF.svg)](https://www.deepseek.com/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#贡献)
[![GitHub stars](https://img.shields.io/github/stars/kafkazhang/seek_code?style=social)](https://github.com/kafkazhang/seek_code/stargazers)

融合 **Claude Code**（本地结对深度）与 **Codex**（任务委派）思路，基于 **Electron + Node + React/TypeScript** 构建的桌面级 AI 结对编程工具。
集成 **Agent 工具循环、纯本地代码索引检索、记忆系统、Skills / MCP 扩展、内置终端与编辑器**——
**你的代码全程留在本机，仅推理请求发往 DeepSeek，绝不上传到任何第三方服务器。**

[快速开始](#快速开始) · [核心能力](#核心能力) · [扩展生态](#扩展生态skills--mcp--市场) · [安全模型](#安全模型) · [Roadmap](#roadmap) · [贡献](#贡献)

</div>

---

<div align="center">

![SeekCode 界面截图](img.png)

</div>

## 为什么选择 SeekCode？

| | SeekCode | 云端 AI 编程工具 |
| --- | --- | --- |
| 🔒 数据归属 | **代码全程留在本机**，仅推理请求发往 DeepSeek | 代码上传至第三方服务器 |
| 💰 成本 | 仅按 DeepSeek API 计费，**实时透明展示花费 / 缓存命中 / 省下金额** | 订阅制 / 不透明计费 |
| 🛡️ 网络出口 | **强制白名单**，主进程 + 渲染层双端拦截，可审计 | 出口不可控 |
| 🧩 可扩展 | 内置 **Skills / MCP / 扩展市场**，按需安装 | 取决于平台 |
| 🗂️ 代码理解 | **纯本地 BM25 索引 + 符号大纲**，离线、无 embedding 上传 | 多依赖云端向量库 |
| 🔑 上手 | 粘贴一个 API Key 即用，零后端 | 需注册 / 登录 / 配置 |

> 一句话：**想要 Claude Code 式的本地结对体验，又在意隐私与成本，SeekCode 就是为你准备的。**

## 核心能力

### 🧠 Agent 工具循环
- 流式对话 + 多步工具循环（单回合最多 25 步，自动推进直至任务真正完成）
- 工具集：`read_file` / `list_dir` / `grep` / `search_code` / `write_file` / `edit_file` / `run_command` / `list_skills` / `read_skill`，外加按需挂载的 MCP 工具
- **上下文自动压缩**：会话过长时用 fast 档把早期对话摘要为要点，仅在 user 消息边界裁剪，不破坏工具调用配对
- **防"光说不做"**：模型只宣布计划却未动手时自动催办，强制其真正调用工具落地

### 🎚️ 混合推理档位（DeepSeek-V4）
| 档位 | 模型 | thinking | 适用 |
| --- | --- | --- | --- |
| **FAST** | `deepseek-v4-flash` | 关闭 | 最快最省，简单改动 |
| **BALANCED** | `deepseek-v4-pro` | `high` | 日常默认 |
| **DEEP** | `deepseek-v4-pro` | `max` | 复杂推理 / 架构 |

含思维链展示；V4 起 thinking 与 tools/temperature 解耦，**三档均支持工具调用**。

### 🔐 四档权限模式（参考 Claude Code）
- **询问授权 `ask`**：每次写文件 / 执行命令都需确认（默认）
- **接受编辑 `acceptEdits`**：自动写文件，命令仍需确认
- **计划模式 `plan`**：只读分析，先产出实施方案再动手
- **全自动 `auto`**：写入与命令全部自动放行
- 写入操作附带 **diff 预览审查**；`rm -rf` / `shutdown` 等**危险命令即使全自动也强制弹审批**；按名批量杀 `node`/`electron` 的"自杀命令"直接硬拒绝
- **联网命令强制审批**：`curl` / `wget` / `git push` / `ssh` 等可能出网的命令，即使在全自动模式下也强制弹审批（详见[安全模型](#安全模型)中关于子进程出口的说明）

### 💰 缓存优先 + 成本透明
- 系统提示与项目代码地图作为**稳定前缀**复用，稳定命中 DeepSeek 服务端前缀缓存
- 实时展示缓存命中率、本会话花费与相比无缓存**省下的金额**
- 内置 DeepSeek 账户余额查询

### 🗂️ 纯本地代码索引（离线 · 无 embedding）
- **符号大纲**（AST-lite 正则提取 function/class/type…）→ 注入"代码地图"，让模型秒懂项目结构
- **BM25 词法倒排索引** → `search_code` 工具做检索式 RAG，大项目里优先定位而非逐个读文件
- 索引**持久化落盘 + 按 mtime 增量更新 + 文件监听**，重启免重建；大项目自动提示模型优先检索

### 🧩 记忆系统
- **项目记忆 `SEEK.md`**：随项目根目录存放，可随仓库提交、团队共享（兼容 `CLAUDE.md`）
- **全局记忆**：跨项目的用户偏好
- 对话中 `/remember …` 一句话写入记忆，每次对话自动注入上下文

### 🖼️ 本地 OCR 识图
- 粘贴/附带截图时，用内置 `tesseract.js`（中文 + 英文字库随包内置）**本地识别文字**再拼进 prompt
- 完全离线，不依赖任何视觉接口——代码与截图都不出本机

### 🖥️ 内置终端 & 编辑器
- 内置流式终端面板（Windows 走 PowerShell 并强制 UTF-8 杜绝中文乱码 / Unix 走默认 shell），支持会话环境变量、`cd` 跟踪与 stdin 交互
- Monaco 编辑器 + 行内 / 并排 **Diff 视图**，文件树浏览、文件预览、HTML 一键预览
- 多会话管理、命令面板、`@` 文件引用、斜杠命令（`/fast` `/deep` `/plan` `/cost` `/memory` `/remember` `/clear` …）、5 套主题

### ⚙️ 后台任务（任务委派）
- 把目标委派给后台**自主 Agent**（auto 权限）并发执行，与前台对话互不阻塞
- 队列化（限制并发数）、**持久化落盘**、完成时系统通知；重启后恢复任务列表

## 扩展生态（Skills / MCP / 市场）

### Skills 技能
- 技能 = 目录 + `SKILL.md`（与 Claude Code / Kiro 一致），分**全局** / **项目**两级
- 支持从 **GitHub 目录 / 单文件 URL 一键安装**、记录来源后**一键更新**、**扫描仓库自动发现**其中所有技能
- 内置 `code-review` / `commit-message` 等示例，模型可 `list_skills` / `read_skill` 按需加载工作流

### MCP（Model Context Protocol）
- 同时支持 **stdio 本地子进程**与 **Streamable HTTP 远程**两种传输
- 配置 `<project>/.seek/mcp.json` 或全局 `mcp.json`，连接后工具自动注入 Agent
- 远程 MCP 服务器需用户显式配置后，才登记为可信出口

### 内置扩展市场（搜索式在线安装）
- 内置常用 MCP 目录：`filesystem` / `memory` / `sequential-thinking` / `github` / `brave-search` / `puppeteer` / `context7` 等
- 在线搜索：官方 **MCP Registry** + **GitHub 技能仓库**，搜到即可一键安装

## 快速开始

前置：**Node.js ≥ 18**。

```bash
git clone https://github.com/kafkazhang/seek_code.git
cd seek_code
npm install        # 纯 JS 依赖，无需原生编译工具链
npm run dev        # 启动开发模式（electron-vite）
```

首次启动会弹出配置框：

1. 粘贴 **DeepSeek API Key**（默认接口 `https://api.deepseek.com`）
2. 点「测试连接」确认可用 →「保存并开始」
3. 点标题栏「打开项目文件夹…」选择一个本地项目
4. 在底部输入框提问，例如："梳理这个项目的整体结构"

## 构建与打包

```bash
npm run build          # 编译主/预加载/渲染三端到 out/
npm run typecheck      # 类型检查（Node 端 + Web 端）
npm run package:win    # 打 Windows 安装包
npm run package:mac    # macOS（支持 --x64 / --arm64）
npm run package:linux  # Linux
```

## 项目结构

```
src/
  main/        # 主进程（Node）
    index.ts        应用入口、窗口与安全配置
    config.ts       配置与 API Key（safeStorage 加密）
    egress.ts       出口白名单判定 + 主进程受控 fetch（guardedFetch）
    net.ts          渲染层出口白名单（webRequest 拦截）
    gateway.ts      DeepSeek 网关（唯一出网）+ 缓存优先 Prompt + 成本核算 + FIM 补全
    agent.ts        Agent 循环（流式 + 工具调用 + 权限闸门 + 上下文压缩）
    tools.ts        文件/命令工具（限定项目目录内）
    codeindex.ts    纯本地代码索引：符号大纲 + BM25 检索（持久化/增量/监听）
    memory.ts       记忆系统（SEEK.md / 全局）
    skills.ts       技能：扫描 / 安装 / 更新 / 仓库发现
    mcp.ts          MCP 客户端（stdio + Streamable HTTP）
    marketplace.ts  扩展市场（内置目录 + 在线搜索安装）
    tasks.ts        后台任务（并发自主 Agent + 队列 + 持久化）
    terminal.ts     内置终端（流式、UTF-8、stdin 交互）
    ocr.ts          本地 OCR 识图（tesseract.js）
    sessions.ts     会话持久化
    ipc.ts          IPC 处理 + 项目文件树 + 审批往返
  preload/     # 预加载（contextBridge 安全桥）
  renderer/    # 渲染进程（React + TS）：对话、编辑器、终端、文件树、市场、设置、成本仪表盘
  shared/      # 主/渲染共享的类型与 IPC 常量
```

## 安全模型

SeekCode 的核心承诺是 **「用户代码只发往 DeepSeek」**，并以强制手段落地：

- **出口白名单覆盖两端**：渲染层经 `webRequest` 拦截，主进程经 `guardedFetch`（走 Electron `net.fetch`）拦截，二者共用 `egress.ts` 的同一判定。受信任出口仅三类：
  1. **推理出口**＝DeepSeek（用户代码/上下文的唯一去处，随配置同步）
  2. **生态出口**＝安装扩展所需的少数公共只读源（GitHub / MCP 注册中心等，不上传代码）
  3. **用户显式信任**＝你主动配置的远程 MCP 服务器 host
  其余一切 http/https/ws 请求一律拦截。
- 渲染进程开启 `contextIsolation` / 关闭 `nodeIntegration` / `sandbox: true`，仅通过白名单 IPC 与主进程通信。
- 文件工具一律限定在当前项目根目录内，拒绝目录穿越。
- API Key 经操作系统级 `safeStorage` 加密保存于 userData，卸载即清除。
- DeepSeek 调用仅发生在主进程网关一处，出网前再次校验 baseURL 在白名单内，便于审计。

> **重要边界说明（请务必知悉）**：出口白名单约束的是 **SeekCode 应用自身的网络栈**（渲染层 `webRequest` + 主进程 `net.fetch`）。
> 但当你（或 Agent）通过 `run_command` / 内置终端执行 shell 命令时，**衍生的子进程走操作系统网络栈，不经过 Electron，因此不受出口白名单约束**——例如 `curl`、`git push`、`pip install` 等命令本就需要联网才能工作。
> 为此 SeekCode 增加了一道**纵深防御**：识别出可能联网的命令（`curl`/`wget`/`git push`/`ssh`/`scp`/`rsync` 等）并**强制人工审批**，即使在全自动模式下也会弹窗。
> 这是启发式黑名单（无法穷尽间接执行、脚本内联网等情形），用于降低而非根除外传风险。**请勿在全自动模式下让 Agent 执行你不信任的命令。**

> 注：默认模型 `deepseek-v4-flash` / `deepseek-v4-pro`（OpenAI 兼容协议）。
> 思考深度通过请求体 `thinking` 参数控制：`{ "type": "enabled"|"disabled", "reasoning_effort": "high"|"max" }`。
> V4 起 thinking 与 tools/temperature 解耦——三档推理均可带工具；`frequency_penalty`/`presence_penalty` 已弃用。
> 旧名 `deepseek-chat`/`deepseek-reasoner` 将于 2026-07-24 弃用。

## Roadmap

- [ ] 多模型供应商支持（OpenAI 兼容接口热插拔）
- [ ] 代码库语义向量检索（与现有 BM25 混合召回）
- [ ] 子代理 / 多代理协作编排
- [ ] 更丰富的扩展市场与一键分享
- [ ] 内置 Git 面板与变更评审

> 有想法？欢迎到 [Issues](https://github.com/kafkazhang/seek_code/issues) 提建议。

## 常见问题（FAQ）

**Q：我的代码会被上传吗？**
A：SeekCode **应用自身**的网络请求都被白名单强制拦截——除了发往 DeepSeek 的推理请求（你的提问与上下文），其余一切应用级请求都拒绝；安装扩展时仅访问少数公共只读源，且不上传任何代码；代码索引与识图均在本机完成。
**但需注意**：你或 Agent 通过 `run_command` / 终端执行的 shell 命令（如 `curl`、`git push`）运行在子进程中，不受应用白名单约束——这类联网命令已被纳入**强制审批**，但安全性最终取决于你对所执行命令的判断。详见[安全模型](#安全模型)。

**Q：需要自己搭后端吗？**
A：不需要。SeekCode 是纯桌面应用，零后端，只需一个 DeepSeek API Key。

**Q：大型项目会不会把整个代码库塞进 prompt？**
A：不会。本地 BM25 索引 + 符号大纲只注入"代码地图"，正文按需检索；项目较大时还会提示模型优先用 `search_code` 定位。

**Q：支持哪些平台？**
A：Windows / macOS / Linux 均可构建打包。

## 贡献

欢迎任何形式的贡献——提 Issue、提 PR、完善文档或分享使用体验。

1. Fork 本仓库
2. 新建分支：`git checkout -b feat/your-feature`
3. 提交并推送，发起 Pull Request

如果这个项目对你有帮助，欢迎点一个 ⭐ **Star** 支持一下！

## 许可证

本项目采用 [MIT License](LICENSE) 开源。

Copyright © 2026 SeekCode

「SeekCode」名称与标识仅用于指代本项目，不等同于对商标或商业品牌的额外授权。
