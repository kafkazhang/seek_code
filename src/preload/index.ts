import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import {
  AgentEvent,
  AppConfig,
  BalanceResult,
  BgTask,
  BgTaskEvent,
  CdResult,
  ConfigPatch,
  DataInfo,
  FileNode,
  CatalogEntry,
  DiscoveredSkill,
  McpStatus,
  MemorySnapshot,
  SkillMeta,
  PersistedState,
  PriorMessage,
  ProjectRef,
  ReasoningMode,
  SendOptions,
  TerminalEvent
} from '@shared/types'

// 安全边界：只通过 contextBridge 暴露白名单方法，渲染进程无法直接访问 Node。
const api = {
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.configGet),
  setConfig: (patch: ConfigPatch): Promise<AppConfig> => ipcRenderer.invoke(IPC.configSet, patch),
  testConnection: (): Promise<{ ok: boolean; models?: string[]; error?: string }> =>
    ipcRenderer.invoke(IPC.configTest),
  getBalance: (): Promise<BalanceResult> => ipcRenderer.invoke(IPC.configBalance),

  // 仅新会话创建时调用：选择项目目录
  openProject: (): Promise<ProjectRef | null> => ipcRenderer.invoke(IPC.projectOpen),

  // 会话持久化（含上次活动会话）
  loadSessions: (): Promise<PersistedState> => ipcRenderer.invoke(IPC.sessionsLoad),
  saveSessions: (data: PersistedState): Promise<boolean> => ipcRenderer.invoke(IPC.sessionsSave, data),

  // 本地数据信息与清除
  getDataInfo: (): Promise<DataInfo> => ipcRenderer.invoke(IPC.dataInfo),
  clearData: (): Promise<boolean> => ipcRenderer.invoke(IPC.dataClear),

  // 文件列表与预览
  getTree: (root: string, refresh = false): Promise<FileNode[]> =>
    ipcRenderer.invoke(IPC.projectTree, { root, refresh }),
  readFile: (root: string, path: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.fileRead, { root, path }),
  pickPath: (mode: 'file' | 'folder'): Promise<string | null> => ipcRenderer.invoke(IPC.pickPath, mode),
  resolveMention: (root: string | null, path: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.mentionResolve, { root, path }),
  readBinary: (root: string, path: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.fileReadBinary, { root, path }),
  openExternal: (root: string, path: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.shellOpen, { root, path }),

  // 编辑器：保存 + FIM
  saveFile: (root: string, path: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.fileWrite, { root, path, content }),
  fim: (prefix: string, suffix: string): Promise<string> =>
    ipcRenderer.invoke(IPC.modelFim, { prefix, suffix }),
  searchFiles: (
    root: string,
    query: string
  ): Promise<{ path: string; line: number; text: string }[]> =>
    ipcRenderer.invoke(IPC.fileSearch, { root, query }),

  // 后台任务
  startTask: (
    goal: string,
    root: string | null,
    opts?: { reasoning?: ReasoningMode; images?: string[] }
  ): Promise<string | null> =>
    ipcRenderer.invoke(IPC.taskStart, { goal, root, reasoning: opts?.reasoning, images: opts?.images }),
  listTasks: (): Promise<BgTask[]> => ipcRenderer.invoke(IPC.taskList),
  cancelTask: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.taskCancel, id),
  onTask: (cb: (e: BgTaskEvent) => void): (() => void) => {
    const listener = (_e: unknown, data: BgTaskEvent): void => cb(data)
    ipcRenderer.on(IPC.taskEvent, listener)
    return () => ipcRenderer.removeListener(IPC.taskEvent, listener)
  },

  // 技能
  listSkills: (root: string | null): Promise<SkillMeta[]> => ipcRenderer.invoke(IPC.skillsList, root),
  readSkill: (id: string, root: string | null): Promise<string | null> =>
    ipcRenderer.invoke(IPC.skillRead, { id, root }),
  saveSkill: (scope: 'global' | 'project', filename: string, content: string, root: string | null): Promise<boolean> =>
    ipcRenderer.invoke(IPC.skillSave, { scope, filename, content, root }),
  installSkill: (
    url: string,
    scope: 'global' | 'project',
    root: string | null
  ): Promise<{ ok: boolean; name?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.skillInstall, { url, scope, root }),
  discoverSkills: (url: string): Promise<{ ok: boolean; skills?: DiscoveredSkill[]; error?: string }> =>
    ipcRenderer.invoke(IPC.skillDiscover, url),
  deleteSkill: (id: string, root: string | null): Promise<boolean> =>
    ipcRenderer.invoke(IPC.skillDelete, { id, root }),

  // MCP
  mcpStatus: (): Promise<McpStatus[]> => ipcRenderer.invoke(IPC.mcpStatus),
  addMcpServer: (name: string, cfg: unknown, root: string | null): Promise<boolean> =>
    ipcRenderer.invoke(IPC.mcpAdd, { name, cfg, root }),
  removeMcpServer: (name: string, root: string | null): Promise<boolean> =>
    ipcRenderer.invoke(IPC.mcpRemove, { name, root }),
  reloadMcp: (root: string | null): Promise<void> => ipcRenderer.invoke(IPC.mcpReload, root),
  openDataDir: (): Promise<boolean> => ipcRenderer.invoke(IPC.dataOpen),

  // 市场（搜索式在线安装）
  marketList: (kind: 'mcp' | 'skill', root: string | null): Promise<CatalogEntry[]> =>
    ipcRenderer.invoke(IPC.marketList, { kind, root }),
  marketSearch: (kind: 'mcp' | 'skill', q: string, root: string | null): Promise<CatalogEntry[]> =>
    ipcRenderer.invoke(IPC.marketSearch, { kind, q, root }),
  marketInstall: (
    kind: 'mcp' | 'skill',
    id: string,
    root: string | null,
    values?: Record<string, string>
  ): Promise<{ ok: boolean; name?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.marketInstall, { kind, id, root, values }),
  updateSkill: (id: string, root: string | null): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.skillUpdate, { id, root }),
  openUrl: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC.shellOpenUrl, url),

  // 记忆
  getMemory: (root: string | null): Promise<MemorySnapshot> => ipcRenderer.invoke(IPC.memoryGet, root),
  addMemory: (scope: 'project' | 'global', text: string, root: string | null): Promise<boolean> =>
    ipcRenderer.invoke(IPC.memoryAdd, { scope, text, root }),

  // 终端
  termExec: (execId: string, cwd: string, command: string, env?: Record<string, string>): Promise<boolean> =>
    ipcRenderer.invoke(IPC.termExec, { execId, cwd, command, env }),
  termInput: (execId: string, data: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.termInput, { execId, data }),
  termKill: (execId: string): Promise<boolean> => ipcRenderer.invoke(IPC.termKill, execId),
  termCd: (cwd: string, arg: string): Promise<CdResult> => ipcRenderer.invoke(IPC.termCd, { cwd, arg }),
  onTerminal: (cb: (e: TerminalEvent) => void): (() => void) => {
    const listener = (_e: unknown, data: TerminalEvent): void => cb(data)
    ipcRenderer.on(IPC.termEvent, listener)
    return () => ipcRenderer.removeListener(IPC.termEvent, listener)
  },

  send: (payload: {
    sessionId: string
    text: string
    options?: SendOptions
    projectRoot?: string | null
    priorMessages?: PriorMessage[]
    images?: string[]
  }): Promise<{ started: boolean }> => ipcRenderer.invoke(IPC.agentSend, payload),
  abort: (sessionId: string): Promise<boolean> => ipcRenderer.invoke(IPC.agentAbort, sessionId),
  resetSession: (sessionId: string): Promise<boolean> => ipcRenderer.invoke(IPC.agentReset, sessionId),
  approve: (approvalId: string, approved: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IPC.toolApprove, { approvalId, approved }),
  onEvent: (cb: (e: AgentEvent) => void): (() => void) => {
    const listener = (_e: unknown, data: AgentEvent): void => cb(data)
    ipcRenderer.on(IPC.agentEvent, listener)
    return () => ipcRenderer.removeListener(IPC.agentEvent, listener)
  }
}

contextBridge.exposeInMainWorld('seek', api)

export type SeekApi = typeof api
