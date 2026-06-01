// 主进程与渲染进程共享的类型定义（纯类型，无运行时副作用）

export type ReasoningMode = 'fast' | 'balanced' | 'deep'

/**
 * 权限模式（参考 Claude Code）：
 *  - ask         询问授权：每次写文件/执行命令都需确认
 *  - acceptEdits 接受编辑：自动写文件，命令仍需确认
 *  - plan        计划模式：只读分析，禁止写入/执行，先产出方案
 *  - auto        全自动：写入与命令全部自动放行
 */
export type PermissionMode = 'ask' | 'acceptEdits' | 'plan' | 'auto'

export interface AppConfig {
  /** 是否已配置 API Key（不回传明文） */
  hasKey: boolean
  baseURL: string
  /** 快速档模型：deepseek-v4-flash（默认关闭 thinking） */
  flashModel: string
  /** 深度档模型：deepseek-v4-pro（开启 thinking） */
  proModel: string
  /** FIM 补全模型 */
  fimModel: string
  reasoning: ReasoningMode
  /** 权限模式 */
  permissionMode: PermissionMode
  /** 界面主题 */
  theme: ThemeId
  /** 网络出口白名单（仅允许这些 host） */
  egressAllowlist: string[]
  /** 价格（人民币元 / 百万 token），用于成本估算 */
  pricing: Pricing
}

/** 界面主题标识（对应 styles.css 中 [data-theme] 配色） */
export type ThemeId = 'abyss' | 'midnight' | 'ember' | 'forest' | 'daylight'

export interface Pricing {
  cacheHitInput: number
  cacheMissInput: number
  output: number
}

export interface ConfigPatch {
  apiKey?: string
  baseURL?: string
  flashModel?: string
  proModel?: string
  fimModel?: string
  reasoning?: ReasoningMode
  permissionMode?: PermissionMode
  theme?: ThemeId
}

/** DeepSeek-V4 thinking 参数（嵌套于请求体 thinking 字段） */
export interface ThinkingParam {
  type: 'enabled' | 'disabled'
  reasoning_effort?: 'high' | 'max'
}

export interface FileNode {
  name: string
  path: string // 相对项目根的路径
  type: 'file' | 'dir'
  children?: FileNode[]
}

export interface ProjectInfo {
  root: string
  name: string
  tree: FileNode[]
}

/** 项目引用（渲染层只需根路径与名字；文件树仅供主进程构建上下文） */
export interface ProjectRef {
  root: string
  name: string
}

export type ChatRole = 'user' | 'assistant'

export interface StoredTool {
  callId: string
  name: string
  args: string
  status: 'running' | 'done' | 'error' | 'denied'
  result?: string
  preview?: EditPreview
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  reasoning: string
  tools: StoredTool[]
  streaming?: boolean
  mode?: ReasoningMode
  /** 系统提示行（斜杠命令反馈等），居中淡色渲染 */
  note?: boolean
  /** 本回合出错的原始信息（渲染为友好错误卡） */
  error?: string
  /** 用户消息附带的图片（data URL，气泡缩略图展示） */
  images?: string[]
  /** 引用的文件 / 文本附件名（气泡内 chip 展示） */
  files?: string[]
}

export interface MemorySnapshot {
  project: string | null
  global: string | null
}

export interface SkillMeta {
  id: string
  name: string
  description: string
  scope: 'global' | 'project'
  /** 安装来源 URL（用于「更新」重新拉取） */
  source?: string
}

/** 从仓库扫描发现的技能 */
export interface DiscoveredSkill {
  id: string
  name: string
  dir: string
  url: string
}

/** 市场目录条目（MCP 或技能）—— 用于搜索式在线安装 */
export interface CatalogEntry {
  id: string
  name: string
  description: string
  market: string
  tags: string[]
  transport?: 'stdio' | 'http'
  needsConfig?: string
  /** 安装前需填写的字段（如 token / 目录），由市场条目声明 */
  fields?: { key: string; label: string; placeholder?: string }[]
  installed: boolean
  /** 来源：本地内置 / 远程注册中心 */
  remote?: boolean
  homepage?: string
  version?: string
}

export interface McpStatus {
  name: string
  status: 'connecting' | 'ready' | 'error'
  tools: number
  toolNames: string[]
  error?: string
}

/** 写入/编辑操作的 diff 预览（用于审查） */
export interface EditPreview {
  path: string
  oldText: string
  newText: string
  isNew: boolean
}

/** 一个会话：绑定一个项目目录，开始后不可更改 */
export interface Session {
  id: string
  title: string
  projectRoot: string | null
  projectName: string | null
  /** 是否已开始（发出过首条消息）。开始后项目目录锁定 */
  started: boolean
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  totals: { cost: number; saved: number; hitRate: number }
}

/** 恢复会话时回灌给模型的精简历史（文本，不含工具结构） */
export interface PriorMessage {
  role: ChatRole
  content: string
}

/** 持久化的整体 UI 状态：会话列表 + 上次活动会话 */
export interface PersistedState {
  activeId: string | null
  sessions: Session[]
}

/** DeepSeek 账户余额查询结果（/user/balance） */
export interface BalanceResult {
  ok: boolean
  /** 账户是否仍可用（余额充足） */
  isAvailable?: boolean
  /** 货币单位，如 CNY / USD */
  currency?: string
  /** 总可用余额（含赠送 + 充值），字符串保留原始精度 */
  totalBalance?: string
  error?: string
}

/** 本地数据信息（用于设置页展示与清除） */
export interface DataInfo {
  dir: string
  settingsPath: string
  sessionsPath: string
  hasKey: boolean
  sessionCount: number
}

/** 终端流式事件（主 → 渲染） */
export type TerminalEvent =
  | { type: 'data'; execId: string; chunk: string; stream: 'out' | 'err' }
  | { type: 'exit'; execId: string; code: number | null }

/** cd 解析结果 */
export interface CdResult {
  ok: boolean
  cwd: string
  error?: string
}

/** 后台任务 */
export interface BgTask {
  id: string
  goal: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  createdAt: number
  projectName: string | null
  lastAction: string
  result: string
  toolCount: number
}

export type BgTaskEvent = { type: 'update'; task: BgTask }

// ── Agent 事件流（主 → 渲染）──────────────────────────
export type AgentEvent =
  | { type: 'status'; sessionId: string; text: string; mode: ReasoningMode }
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'reasoning'; sessionId: string; text: string }
  | {
      type: 'tool'
      sessionId: string
      callId: string
      name: string
      args: string
      status: 'running' | 'done' | 'error' | 'denied'
      result?: string
      preview?: EditPreview
    }
  | {
      type: 'approval'
      sessionId: string
      approvalId: string
      name: string
      summary: string
      preview?: EditPreview
    }
  | { type: 'usage'; sessionId: string; usage: UsageSnapshot }
  | { type: 'done'; sessionId: string }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'aborted'; sessionId: string }

export interface UsageSnapshot {
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  /** 0..1 */
  cacheHitRate: number
  /** 本轮花费（元） */
  cost: number
  /** 相比无缓存省下（元） */
  saved: number
}

export interface SendOptions {
  reasoning?: ReasoningMode
  permissionMode?: PermissionMode
}

export const DEFAULT_CONFIG: AppConfig = {
  hasKey: false,
  baseURL: 'https://api.deepseek.com',
  flashModel: 'deepseek-v4-flash',
  proModel: 'deepseek-v4-pro',
  fimModel: 'deepseek-v4-flash',
  reasoning: 'balanced',
  permissionMode: 'ask',
  theme: 'abyss',
  egressAllowlist: ['api.deepseek.com'],
  // 价格为估算（元/百万 token），可在设置中调整；以官方计费为准
  pricing: { cacheHitInput: 0.5, cacheMissInput: 2, output: 8 }
}
