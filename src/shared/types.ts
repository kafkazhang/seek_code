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
  /** 是否已配置向量服务 API Key（不回传明文） */
  hasEmbedKey: boolean
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
  /** 语义向量检索（embedding）开关：开启后 search_code 走 BM25+向量混合召回 */
  semanticIndex: boolean
  /** 向量服务接口地址（OpenAI 兼容 /embeddings）。DeepSeek 无向量模型，需用外部服务（如阿里 DashScope） */
  embedBaseURL: string
  /** 向量化模型 id（如 text-embedding-v3） */
  embedModel: string
  /** 网络出口白名单（仅允许这些 host） */
  egressAllowlist: string[]
  /** 价格（人民币元 / 百万 token），用于成本估算 */
  pricing: Pricing
}

/** 界面主题标识（对应 styles.css 中 [data-theme] 配色） */
export type ThemeId =
  | 'abyss'
  | 'midnight'
  | 'ember'
  | 'forest'
  | 'daylight'
  | 'particle'
  | 'sakura'
  | 'ink'
  | 'lavender'
  | 'peach'

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
  semanticIndex?: boolean
  embedBaseURL?: string
  embedModel?: string
  /** 向量服务 API Key（独立于 DeepSeek Key，safeStorage 加密存储） */
  embedApiKey?: string
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
  /** spawn_subagents 工具：各子代理的实时进度卡 */
  subs?: SubagentUpdate[]
}

/** 任务清单项（todo_write 工具维护，聊天区清单卡展示） */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** 子代理进度（spawn_subagents 编排时随事件流推送、内嵌于工具卡展示） */
export interface SubagentUpdate {
  id: string
  goal: string
  status: 'queued' | 'running' | 'done' | 'error'
  lastAction: string
  toolCount: number
  /** 完成后的结果预览（截断） */
  result?: string
}

/**
 * 助手消息时间线的一个片段：推理 / 文本 / 工具调用，按发生顺序排列。
 * 用于「边思考边行动」的交错展示——把同一回合里跨多轮产生的推理与工具调用按真实先后顺序穿插渲染，
 * 而不是把推理全堆在上、工具全堆在下。tool 片段只存 callId，具体数据仍取自 message.tools。
 */
export type TimelinePart =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; callId: string }

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  reasoning: string
  tools: StoredTool[]
  /** 推理/文本/工具按时间顺序交错的时间线（新版渲染）。旧消息无此字段时回退到 reasoning/tools/content 分段渲染。 */
  timeline?: TimelinePart[]
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
  /** 本会话权限模式；新建时继承配置中的默认值 */
  permissionMode: PermissionMode
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

/** 本地数据信息（用于设置页只读展示） */
export interface DataInfo {
  dir: string
  settingsPath: string
  sessionsPath: string
  hasKey: boolean
  sessionCount: number
}

/** 自动更新状态（主 → 渲染推送，设置页/底栏展示） */
export interface UpdateStatus {
  /**
   * idle 初始；checking 检查中；available 发现新版（开始下载）；downloading 下载中；
   * downloaded 已下载待安装；up-to-date 已是最新；error 出错；dev 开发环境（未打包，不检查）
   */
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error' | 'dev'
  /** 新版本号（available/downloaded 时） */
  version?: string
  /** 下载进度百分比 0..100（downloading 时） */
  percent?: number
  /** 错误信息（error 时） */
  error?: string
}

/** 更改数据目录的结果（迁移成功后需重启生效） */
export interface DataDirChangeResult {
  ok: boolean
  /** 是否实际搬迁了数据（旧目录原本有数据才为 true） */
  moved?: boolean
  from?: string
  to?: string
  error?: string
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
  | { type: 'subagent'; sessionId: string; callId: string; sub: SubagentUpdate }
  | { type: 'todos'; sessionId: string; todos: TodoItem[] }
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
  /** 内部标记：当前会话是子代理（禁用再派生子代理，步数上限更小） */
  isSubagent?: boolean
}

// ── Git 面板 ─────────────────────────────────────────
/** 一条文件变更（git status --porcelain=v1 -z 解析结果） */
export interface GitFileChange {
  path: string
  /** 重命名前的原路径 */
  origPath?: string
  /** 暂存区状态码 X（' ' 表示无） */
  x: string
  /** 工作区状态码 Y（' ' 表示无） */
  y: string
}

export interface GitStatusResult {
  isRepo: boolean
  branch?: string
  /** 相对上游领先/落后提交数 */
  ahead?: number
  behind?: number
  files: GitFileChange[]
  error?: string
}

export interface GitLogEntry {
  hash: string
  author: string
  date: string
  subject: string
}

/** 单文件 diff 的两侧文本（供 Monaco DiffEditor） */
export interface GitDiffPayload {
  path: string
  oldText: string
  newText: string
}

export interface GitOpResult {
  ok: boolean
  output?: string
  error?: string
}

/** AI 生成提交信息 / 变更评审的结果 */
export interface GitAiResult {
  ok: boolean
  text?: string
  error?: string
}

export const DEFAULT_CONFIG: AppConfig = {
  hasKey: false,
  hasEmbedKey: false,
  baseURL: 'https://api.deepseek.com',
  flashModel: 'deepseek-v4-flash',
  proModel: 'deepseek-v4-pro',
  fimModel: 'deepseek-v4-flash',
  reasoning: 'balanced',
  permissionMode: 'ask',
  theme: 'abyss',
  semanticIndex: false,
  // DeepSeek 无向量模型，默认用阿里 DashScope 的 text-embedding-v3（OpenAI 兼容接口）
  embedBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  embedModel: 'text-embedding-v3',
  egressAllowlist: ['api.deepseek.com'],
  // 价格为估算（元/百万 token），可在设置中调整；以官方计费为准
  pricing: { cacheHitInput: 0.5, cacheMissInput: 2, output: 8 }
}
