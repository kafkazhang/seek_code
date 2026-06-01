import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, join, resolve, relative, isAbsolute } from 'node:path'
import { IPC } from '@shared/ipc'
import { getConfig, setConfig, clearAll, settingsPath, dataDir, hasApiKey } from './config'
import { getClient, fim, getBalance } from './gateway'
import { runAgent, abortSession, resetSession, ApprovalFn } from './agent'
import { loadSessions, saveSessions, clearSessions, sessionsPath } from './sessions'
import { termExec, termKill, termInput, resolveCd } from './terminal'
import { readMemory, addMemory } from './memory'
import { buildIndex, invalidate, grepContent, watchProject } from './codeindex'
import { startTask, listTasks, cancelTask, loadTasks } from './tasks'
import { listSkills, readSkill, saveSkill, deleteSkill, seedSkills, installSkillFromUrl, updateSkill, discoverRepoSkills } from './skills'
import { mcpStatus, addMcpServer, removeMcpServer, initMcp } from './mcp'
import { marketList, marketSearch, marketInstall } from './marketplace'
import {
  AgentEvent,
  BgTaskEvent,
  ConfigPatch,
  DataInfo,
  FileNode,
  PersistedState,
  PriorMessage,
  ProjectInfo,
  ProjectRef,
  ReasoningMode,
  SendOptions,
  TerminalEvent
} from '@shared/types'

// 项目按根路径缓存（含为模型构建的代码地图）。
// 每个会话绑定一个 projectRoot；发送时按需解析/重建。
const projectCache = new Map<string, ProjectInfo>()
const pendingApprovals = new Map<string, (ok: boolean) => void>()
const IGNORE = new Set(['node_modules', '.git', 'out', 'dist', '.next', '.cache', 'build'])

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const emit = (e: AgentEvent): void => {
    getWindow()?.webContents.send(IPC.agentEvent, e)
  }

  // 启动时：写入示例技能 + 连接全局 MCP 服务器（若已配置）+ 恢复历史后台任务
  seedSkills()
  void initMcp(null)
  loadTasks()

  ipcMain.handle(IPC.configGet, () => getConfig())
  ipcMain.handle(IPC.configSet, (_e, patch: ConfigPatch) => setConfig(patch))

  ipcMain.handle(IPC.configTest, async () => {
    try {
      const client = getClient()
      const r = await client.models.list()
      return { ok: true, models: (r.data ?? []).map((m) => m.id).slice(0, 20) }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  })

  // 账户余额查询（DeepSeek /user/balance）
  ipcMain.handle(IPC.configBalance, () => getBalance())

  // 选择项目目录（仅新会话创建时调用）；构建并缓存代码地图，返回轻量引用
  ipcMain.handle(IPC.projectOpen, async (): Promise<ProjectRef | null> => {
    const win = getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths[0]) return null
    const root = res.filePaths[0]
    const info = await buildProject(root)
    projectCache.set(root, info)
    void buildIndex(root) // 后台预热代码索引
    watchProject(root) // 监听文件变化，增量更新索引
    return { root: info.root, name: info.name }
  })

  // 会话持久化（含上次活动会话）
  ipcMain.handle(IPC.sessionsLoad, (): PersistedState => loadSessions())
  ipcMain.handle(IPC.sessionsSave, (_e, data: PersistedState) => {
    saveSessions(data)
    return true
  })

  // 本地数据信息与清除
  ipcMain.handle(
    IPC.dataInfo,
    (): DataInfo => ({
      dir: dataDir(),
      settingsPath: settingsPath(),
      sessionsPath: sessionsPath(),
      hasKey: hasApiKey(),
      sessionCount: loadSessions().sessions.length
    })
  )
  ipcMain.handle(IPC.dataClear, () => {
    clearAll()
    clearSessions()
    projectCache.clear()
    return true
  })

  ipcMain.handle(
    IPC.agentSend,
    async (
      _e,
      payload: {
        sessionId: string
        text: string
        options?: SendOptions
        projectRoot?: string | null
        priorMessages?: PriorMessage[]
        images?: string[]
      }
    ) => {
      const project = await resolveProject(payload.projectRoot ?? null)
      const approve: ApprovalFn = (sessionId, name, summary, preview) =>
        new Promise<boolean>((res) => {
          const approvalId = `${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`
          pendingApprovals.set(approvalId, res)
          emit({ type: 'approval', sessionId, approvalId, name, summary, preview })
        })
      void runAgent(
        payload.sessionId,
        payload.text,
        payload.options ?? {},
        project,
        emit,
        approve,
        payload.priorMessages ?? [],
        payload.images ?? []
      )
      return { started: true }
    }
  )

  ipcMain.handle(IPC.agentAbort, (_e, sessionId: string) => {
    abortSession(sessionId)
    return true
  })

  ipcMain.handle(IPC.agentReset, (_e, sessionId: string) => {
    abortSession(sessionId)
    resetSession(sessionId)
    return true
  })

  ipcMain.handle(IPC.toolApprove, (_e, payload: { approvalId: string; approved: boolean }) => {
    const r = pendingApprovals.get(payload.approvalId)
    if (r) {
      r(payload.approved)
      pendingApprovals.delete(payload.approvalId)
    }
    return true
  })

  // ── 文件列表 ──
  ipcMain.handle(
    IPC.projectTree,
    async (_e, payload: { root: string; refresh?: boolean }): Promise<FileNode[]> => {
      if (!payload?.root) return []
      if (payload.refresh) {
        projectCache.delete(payload.root)
        invalidate(payload.root)
      }
      const info = await resolveProject(payload.root)
      return info?.tree ?? []
    }
  )

  // ── 选择项目外的文件 / 文件夹 ──
  ipcMain.handle(IPC.pickPath, async (_e, mode: 'file' | 'folder') => {
    const win = getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      properties: [mode === 'folder' ? 'openDirectory' : 'openFile']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  // ── 解析 @ 引用（项目内相对路径 或 项目外绝对路径；文件→内容，目录→列表）──
  ipcMain.handle(IPC.mentionResolve, async (_e, p: { root: string | null; path: string }): Promise<string | null> => {
    let abs: string
    if (isAbsolute(p.path)) {
      abs = p.path // 用户显式引用的项目外路径
    } else {
      if (!p.root) return null
      abs = resolve(p.root, p.path)
      if (relative(p.root, abs).startsWith('..')) return null
    }
    try {
      const st = await fs.stat(abs)
      if (st.isDirectory()) {
        const entries = await fs.readdir(abs, { withFileTypes: true })
        const lines = entries
          .slice(0, 300)
          .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        return `目录（${entries.length} 项）:\n` + lines.join('\n')
      }
      if (st.size > 400_000) return `（文件过大 ${st.size} 字节，已跳过）`
      return await fs.readFile(abs, 'utf-8')
    } catch {
      return null
    }
  })

  // ── 文件预览（只读，限定项目目录内）──
  ipcMain.handle(
    IPC.fileRead,
    async (_e, payload: { root: string; path: string }): Promise<string | null> => {
      const abs = resolve(payload.root, payload.path)
      if (relative(payload.root, abs).startsWith('..')) return null
      try {
        const buf = await fs.readFile(abs, 'utf-8')
        return buf.length > 400_000 ? buf.slice(0, 400_000) + '\n…（已截断）' : buf
      } catch {
        return null
      }
    }
  )

  // ── 二进制文件（图片）读为 data URL ──
  ipcMain.handle(
    IPC.fileReadBinary,
    async (_e, payload: { root: string; path: string }): Promise<string | null> => {
      const abs = resolve(payload.root, payload.path)
      if (relative(payload.root, abs).startsWith('..')) return null
      try {
        const buf = await fs.readFile(abs)
        if (buf.length > 12_000_000) return null // 12MB 上限
        return `data:${mimeOf(payload.path)};base64,${buf.toString('base64')}`
      } catch {
        return null
      }
    }
  )

  // ── 用系统默认程序打开文件（如 .html 用浏览器）──
  ipcMain.handle(IPC.shellOpen, async (_e, payload: { root: string; path: string }): Promise<boolean> => {
    const abs = resolve(payload.root, payload.path)
    if (relative(payload.root, abs).startsWith('..')) return false
    await shell.openPath(abs)
    return true
  })

  // ── 编辑器：保存文件（限定项目目录内）──
  ipcMain.handle(IPC.fileWrite, async (_e, payload: { root: string; path: string; content: string }) => {
    const abs = resolve(payload.root, payload.path)
    if (relative(payload.root, abs).startsWith('..')) return false
    try {
      await fs.writeFile(abs, payload.content, 'utf-8')
      return true
    } catch {
      return false
    }
  })

  // ── 全局内容搜索 ──
  ipcMain.handle(IPC.fileSearch, (_e, payload: { root: string; query: string }) =>
    grepContent(payload.root, payload.query)
  )

  // ── FIM 代码补全 ──
  ipcMain.handle(IPC.modelFim, async (_e, payload: { prefix: string; suffix: string }) => {
    try {
      return await fim(payload.prefix, payload.suffix)
    } catch {
      return ''
    }
  })

  // ── 技能（Skills）──
  ipcMain.handle(IPC.skillsList, (_e, root: string | null) => listSkills(root))
  ipcMain.handle(IPC.skillRead, (_e, p: { id: string; root: string | null }) => readSkill(p.root, p.id))
  ipcMain.handle(IPC.skillInstall, (_e, p: { url: string; scope: 'global' | 'project'; root: string | null }) =>
    installSkillFromUrl(p.url, p.scope, p.root)
  )
  ipcMain.handle(IPC.skillDiscover, (_e, url: string) => discoverRepoSkills(url))
  ipcMain.handle(
    IPC.skillSave,
    (_e, p: { scope: 'global' | 'project'; filename: string; content: string; root: string | null }) =>
      saveSkill(p.scope, p.filename, p.content, p.root)
  )
  ipcMain.handle(IPC.skillDelete, (_e, p: { id: string; root: string | null }) => deleteSkill(p.id, p.root))

  // ── MCP ──
  ipcMain.handle(IPC.mcpStatus, () => mcpStatus())
  ipcMain.handle(IPC.mcpAdd, (_e, p: { name: string; cfg: unknown; root: string | null }) =>
    addMcpServer(p.name, p.cfg as any, p.root)
  )
  ipcMain.handle(IPC.mcpRemove, (_e, p: { name: string; root: string | null }) => removeMcpServer(p.name, p.root))
  ipcMain.handle(IPC.mcpReload, (_e, root: string | null) => initMcp(root))

  // ── 市场（搜索式在线安装）──
  ipcMain.handle(IPC.marketList, (_e, p: { kind: 'mcp' | 'skill'; root: string | null }) =>
    marketList(p.kind, p.root)
  )
  ipcMain.handle(IPC.marketSearch, (_e, p: { kind: 'mcp' | 'skill'; q: string; root: string | null }) =>
    marketSearch(p.kind, p.q, p.root)
  )
  ipcMain.handle(IPC.skillUpdate, (_e, p: { id: string; root: string | null }) => updateSkill(p.id, p.root))
  ipcMain.handle(IPC.shellOpenUrl, async (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      await shell.openExternal(url)
      return true
    }
    return false
  })
  ipcMain.handle(
    IPC.marketInstall,
    (_e, p: { kind: 'mcp' | 'skill'; id: string; root: string | null; values?: Record<string, string> }) =>
      marketInstall(p.kind, p.id, p.root, p.values)
  )

  // ── 打开数据目录 ──
  ipcMain.handle(IPC.dataOpen, async () => {
    await shell.openPath(dataDir())
    return true
  })

  // ── 记忆（SEEK.md / 全局）──
  ipcMain.handle(IPC.memoryGet, (_e, root: string | null) => readMemory(root))
  ipcMain.handle(
    IPC.memoryAdd,
    (_e, payload: { scope: 'project' | 'global'; text: string; root: string | null }) =>
      addMemory(payload.scope, payload.text, payload.root)
  )

  // ── 终端 ──
  const emitTerm = (e: TerminalEvent): void => {
    getWindow()?.webContents.send(IPC.termEvent, e)
  }
  ipcMain.handle(
    IPC.termExec,
    (_e, payload: { execId: string; cwd: string; command: string; env?: Record<string, string> }) => {
      termExec(
        payload.execId,
        payload.cwd,
        payload.command,
        payload.env ?? {},
        (chunk, stream) => emitTerm({ type: 'data', execId: payload.execId, chunk, stream }),
        (code) => emitTerm({ type: 'exit', execId: payload.execId, code })
      )
      return true
    }
  )
  ipcMain.handle(IPC.termInput, (_e, payload: { execId: string; data: string }) => {
    termInput(payload.execId, payload.data)
    return true
  })
  ipcMain.handle(IPC.termKill, (_e, execId: string) => {
    termKill(execId)
    return true
  })
  ipcMain.handle(IPC.termCd, (_e, payload: { cwd: string; arg: string }) =>
    resolveCd(payload.cwd, payload.arg)
  )

  // ── 后台任务 ──
  const emitTask = (e: BgTaskEvent): void => {
    getWindow()?.webContents.send(IPC.taskEvent, e)
  }
  ipcMain.handle(
    IPC.taskStart,
    async (
      _e,
      payload: { goal: string; root: string | null; reasoning?: ReasoningMode; images?: string[] }
    ) => {
      const proj = await resolveProject(payload.root ?? null)
      if (!proj) return null
      return startTask(payload.goal, proj, emitTask, {
        reasoning: payload.reasoning,
        images: payload.images
      })
    }
  )
  ipcMain.handle(IPC.taskList, () => listTasks())
  ipcMain.handle(IPC.taskCancel, (_e, id: string) => {
    cancelTask(id)
    return true
  })
}

function mimeOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    svg: 'image/svg+xml'
  }
  return map[ext] ?? 'application/octet-stream'
}

async function resolveProject(root: string | null): Promise<ProjectInfo | null> {
  if (!root) return null
  const cached = projectCache.get(root)
  if (cached) return cached
  // 应用重启后恢复会话：按根路径重建代码地图
  try {
    const info = await buildProject(root)
    projectCache.set(root, info)
    return info
  } catch {
    return null
  }
}

async function buildProject(root: string): Promise<ProjectInfo> {
  return { root, name: basename(root) || root, tree: await buildTree(root, '', 0) }
}

async function buildTree(absDir: string, rel: string, depth: number): Promise<FileNode[]> {
  if (depth > 6) return []
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = (await fs.readdir(absDir, { withFileTypes: true })) as any
  } catch {
    return []
  }
  entries.sort(
    (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
  )
  const nodes: FileNode[] = []
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue
    const childRel = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      nodes.push({
        name: e.name,
        path: childRel,
        type: 'dir',
        children: await buildTree(join(absDir, e.name), childRel, depth + 1)
      })
    } else {
      nodes.push({ name: e.name, path: childRel, type: 'file' })
    }
    if (nodes.length > 2000) break
  }
  return nodes
}
