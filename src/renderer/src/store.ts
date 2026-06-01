import { create } from 'zustand'
import {
  AgentEvent,
  AppConfig,
  BalanceResult,
  BgTask,
  ChatMessage,
  ConfigPatch,
  EditPreview,
  PermissionMode,
  PriorMessage,
  ReasoningMode,
  Session,
  StoredTool,
  ThemeId
} from '@shared/types'
import { applyTheme } from './themes'

function uid(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }
}

export interface Attachment {
  id: string
  kind: 'image' | 'text'
  name: string
  dataUrl?: string
  text?: string
}

// 展开输入：@引用（项目内相对路径 / 项目外绝对路径，支持 @"含空格路径"）+ 文本附件 → 上下文；
// 图片附件 → base64 列表；并汇总用于消息气泡的文件名 chips。对话与后台任务委派共用。
async function composeContext(
  root: string | null,
  text: string,
  attachments: Attachment[]
): Promise<{ ctx: string; images: string[]; fileChips: string[] }> {
  let ctx = ''
  const mentions: string[] = []
  const re = /@"([^"]+)"|@([^\s@]+)/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(text))) mentions.push(mm[1] ?? mm[2])
  for (const p of mentions) {
    const content = await window.seek.resolveMention(root, p).catch(() => null)
    if (content != null) ctx += `\n\n[引用 ${p}]\n\`\`\`\n${content.slice(0, 20000)}\n\`\`\``
  }
  for (const a of attachments.filter((x) => x.kind === 'text')) {
    ctx += `\n\n[附件 ${a.name}]\n\`\`\`\n${(a.text || '').slice(0, 20000)}\n\`\`\``
  }
  const images = attachments.filter((a) => a.kind === 'image' && a.dataUrl).map((a) => a.dataUrl as string)
  const chipName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p
  const fileChips = [...mentions.map(chipName), ...attachments.filter((a) => a.kind === 'text').map((a) => a.name)]
  return { ctx, images, fileChips }
}

export interface PreviewState {
  path: string
  kind: 'text' | 'image'
  content?: string
  dataUrl?: string
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i

export interface Approval {
  sessionId: string
  approvalId: string
  name: string
  summary: string
  preview?: EditPreview
}

interface State {
  config: AppConfig | null
  sessions: Session[]
  activeId: string | null
  running: Record<string, boolean>
  approvals: Approval[]
  reasoning: ReasoningMode
  permissionMode: PermissionMode
  status: string
  settingsOpen: boolean
  dockOpen: boolean
  dockTab: 'files' | 'preview' | 'terminal' | 'tasks'
  tasks: BgTask[]
  previews: PreviewState[]
  activePreviewPath: string | null
  treeVersion: number
  palette: 'files' | 'search' | null
  balance: BalanceResult | null

  init: () => Promise<void>
  loadBalance: () => Promise<void>
  setPalette: (p: 'files' | 'search' | null) => void
  setDock: (open: boolean, tab?: 'files' | 'preview' | 'terminal' | 'tasks') => void
  startBgTask: (goal: string, attachments?: Attachment[], reasoning?: ReasoningMode) => Promise<void>
  openPreview: (path: string) => Promise<void>
  closePreview: (path: string) => void
  setActivePreview: (path: string) => void
  newSession: () => void
  selectSession: (id: string) => void
  deleteSession: (id: string) => void
  pickProject: () => Promise<void>
  skillsRev: number
  bumpSkills: () => void
  setReasoning: (m: ReasoningMode) => void
  setMode: (m: PermissionMode) => void
  setTheme: (t: ThemeId) => void
  command: (text: string) => Promise<void>
  retryMessage: (assistantId: string) => Promise<void>
  editMessage: (userId: string, newText: string) => Promise<void>
  regenerateFrom: (userMessageId: string) => Promise<void>
  setSettingsOpen: (v: boolean) => void
  clearAllData: () => Promise<void>
  saveConfig: (patch: ConfigPatch) => Promise<void>
  send: (text: string, attachments?: Attachment[]) => Promise<void>
  abort: () => void
  approve: (approvalId: string, approved: boolean) => void
  handleEvent: (e: AgentEvent) => void
  active: () => Session | null
}

let cleanup: (() => void) | null = null
let cleanupTask: (() => void) | null = null

function blankSession(): Session {
  const now = Date.now()
  return {
    id: uid(),
    title: '新会话',
    projectRoot: null,
    projectName: null,
    started: false,
    createdAt: now,
    updatedAt: now,
    messages: [],
    totals: { cost: 0, saved: 0, hitRate: 0 }
  }
}

export const useStore = create<State>((set, get) => {
  const persist = (): void => {
    void window.seek.saveSessions({ activeId: get().activeId, sessions: get().sessions })
  }
  // 流式过程中防抖保存，避免逐 token 写盘，又能在中途关闭时保住内容
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const persistSoon = (): void => {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      persist()
    }, 1500)
  }
  const patch = (id: string, fn: (s: Session) => Session): void =>
    set((st) => ({ sessions: st.sessions.map((s) => (s.id === id ? fn(s) : s)) }))
  const patchLastBot = (id: string, fn: (m: ChatMessage) => ChatMessage): void =>
    patch(id, (s) => {
      const msgs = [...s.messages]
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') {
          msgs[i] = fn(msgs[i])
          break
        }
      }
      return { ...s, messages: msgs, updatedAt: Date.now() }
    })

  return {
    config: null,
    sessions: [],
    activeId: null,
    running: {},
    approvals: [],
    reasoning: 'balanced',
    permissionMode: 'ask',
    status: '',
    settingsOpen: false,
    dockOpen: false,
    dockTab: 'files',
    tasks: [],
    previews: [],
    activePreviewPath: null,
    treeVersion: 0,
    palette: null,
    balance: null,

    active: () => get().sessions.find((s) => s.id === get().activeId) ?? null,
    loadBalance: async () => {
      if (!get().config?.hasKey) {
        set({ balance: null })
        return
      }
      const balance = await window.seek.getBalance().catch((e) => ({ ok: false, error: String(e) }))
      set({ balance })
    },
    setPalette: (p) => set({ palette: p }),

    setDock: (open, tab) => set((st) => ({ dockOpen: open, dockTab: tab ?? st.dockTab })),
    openPreview: async (path) => {
      const root = get().active()?.projectRoot
      if (!root) return
      let ps: PreviewState | null = null
      if (IMAGE_EXT.test(path)) {
        const dataUrl = await window.seek.readBinary(root, path)
        if (dataUrl) ps = { path, kind: 'image', dataUrl }
      } else {
        const content = await window.seek.readFile(root, path)
        if (content !== null) ps = { path, kind: 'text', content }
      }
      if (!ps) return
      set((st) => {
        const idx = st.previews.findIndex((p) => p.path === path)
        const previews = idx >= 0 ? st.previews.map((p, i) => (i === idx ? ps! : p)) : [...st.previews, ps!]
        return { previews, activePreviewPath: path, dockOpen: true, dockTab: 'preview' }
      })
    },
    closePreview: (path) =>
      set((st) => {
        const previews = st.previews.filter((p) => p.path !== path)
        const activePreviewPath =
          st.activePreviewPath === path ? (previews[previews.length - 1]?.path ?? null) : st.activePreviewPath
        return { previews, activePreviewPath }
      }),
    setActivePreview: (path) => set({ activePreviewPath: path }),

    init: async () => {
      const config = await window.seek.getConfig()
      applyTheme(config.theme) // 尽早应用主题，避免闪烁
      const persisted = await window.seek.loadSessions()
      const sessions = [...persisted.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
      const activeId = sessions.find((s) => s.id === persisted.activeId)?.id ?? sessions[0]?.id ?? null
      set({
        config,
        sessions,
        activeId,
        reasoning: config.reasoning,
        permissionMode: config.permissionMode,
        settingsOpen: !config.hasKey
      })
      if (sessions.length === 0) get().newSession()
      void get().loadBalance() // 启动后异步拉取账户余额
      cleanup?.()
      cleanup = window.seek.onEvent((e) => get().handleEvent(e))

      set({ tasks: await window.seek.listTasks() })
      cleanupTask?.()
      cleanupTask = window.seek.onTask((e) =>
        set((st) => {
          const exists = st.tasks.some((x) => x.id === e.task.id)
          return {
            tasks: exists ? st.tasks.map((x) => (x.id === e.task.id ? e.task : x)) : [e.task, ...st.tasks]
          }
        })
      )
    },

    startBgTask: async (goal, attachments = [], reasoning) => {
      const g = goal.trim()
      if (!g && attachments.length === 0) return
      const cur = get().active()
      const root = cur?.projectRoot ?? null
      // 与对话发送一致：展开 @引用与文本附件并入任务目标，图片随任务一起下发
      const { ctx, images } = await composeContext(root, g, attachments)
      await window.seek.startTask((g || '（见附件图片）') + ctx, root, {
        reasoning: reasoning ?? get().reasoning,
        images: images.length ? images : undefined
      })
      set({ dockOpen: true, dockTab: 'tasks' })
    },

    newSession: () => {
      const s = blankSession()
      set((st) => ({ sessions: [s, ...st.sessions], activeId: s.id, status: '' }))
      persist()
    },

    selectSession: (id) => {
      set({ activeId: id })
      persist() // 记住上次活动会话
    },

    deleteSession: (id) => {
      void window.seek.resetSession(id)
      set((st) => {
        const sessions = st.sessions.filter((s) => s.id !== id)
        const activeId = st.activeId === id ? (sessions[0]?.id ?? null) : st.activeId
        return { sessions, activeId }
      })
      if (get().sessions.length === 0) get().newSession()
      persist()
    },

    pickProject: async () => {
      const cur = get().active()
      if (!cur || cur.started) return // 已开始：项目锁定
      const ref = await window.seek.openProject()
      if (!ref) return
      patch(cur.id, (s) => ({ ...s, projectRoot: ref.root, projectName: ref.name, updatedAt: Date.now() }))
      persist()
    },

    skillsRev: 0,
    bumpSkills: () => set((s) => ({ skillsRev: s.skillsRev + 1 })),
    setReasoning: (m) => {
      set({ reasoning: m })
      void window.seek.setConfig({ reasoning: m }) // 持久化推理档位偏好
    },
    setMode: (m) => {
      set({ permissionMode: m })
      void window.seek.setConfig({ permissionMode: m }) // 持久化权限模式
    },
    setTheme: (t) => {
      applyTheme(t) // 立即生效
      set((s) => ({ config: s.config ? { ...s.config, theme: t } : s.config }))
      void window.seek.setConfig({ theme: t }) // 持久化
    },
    setSettingsOpen: (v) => set({ settingsOpen: v }),

    clearAllData: async () => {
      await window.seek.clearData()
      const config = await window.seek.getConfig()
      applyTheme(config.theme)
      set({
        config,
        sessions: [],
        activeId: null,
        approvals: [],
        running: {},
        status: '已清除全部本地数据',
        settingsOpen: !config.hasKey
      })
      get().newSession()
    },

    saveConfig: async (patchCfg) => {
      const config = await window.seek.setConfig(patchCfg)
      applyTheme(config.theme)
      set({ config, reasoning: config.reasoning, permissionMode: config.permissionMode })
      void get().loadBalance() // Key / baseURL 变更后刷新余额
    },

    send: async (text, attachments = []) => {
      const t = text.trim()
      const cur = get().active()
      if ((!t && attachments.length === 0) || !cur) return
      if (t.startsWith('/')) {
        await get().command(t)
        return
      }
      if (get().running[cur.id]) return
      if (!get().config?.hasKey) {
        set({ settingsOpen: true })
        return
      }
      if (!cur.projectRoot) {
        await get().pickProject()
        return // 选完目录后再次发送
      }
      const root = cur.projectRoot

      const { ctx, images, fileChips } = await composeContext(root, t, attachments)

      const prior: PriorMessage[] = cur.messages
        .filter((m) => m.content && !m.note && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => ({ role: m.role, content: m.content }))

      const userMsg: ChatMessage = {
        id: uid(),
        role: 'user',
        content: t,
        reasoning: '',
        tools: [],
        images: images.length ? images : undefined,
        files: fileChips.length ? fileChips : undefined
      }
      const botMsg: ChatMessage = {
        id: uid(),
        role: 'assistant',
        content: '',
        reasoning: '',
        tools: [],
        streaming: true,
        mode: get().reasoning
      }
      patch(cur.id, (s) => ({
        ...s,
        started: true,
        title: s.messages.length === 0 ? (t || '图片消息').slice(0, 40) : s.title,
        messages: [...s.messages, userMsg, botMsg],
        updatedAt: Date.now()
      }))
      set((st) => ({ running: { ...st.running, [cur.id]: true }, status: '已发送…' }))
      persist()

      await window.seek.send({
        sessionId: cur.id,
        text: (t || '（见附件图片）') + ctx,
        options: { reasoning: get().reasoning, permissionMode: get().permissionMode },
        projectRoot: root,
        priorMessages: prior,
        images
      })
    },

    abort: () => {
      const id = get().activeId
      if (id) window.seek.abort(id)
    },

    regenerateFrom: async (userMessageId) => {
      const cur = get().active()
      if (!cur || !cur.projectRoot) return
      if (get().running[cur.id]) return
      const idx = cur.messages.findIndex((m) => m.id === userMessageId)
      if (idx < 0 || cur.messages[idx].role !== 'user') return
      const userText = cur.messages[idx].content
      const prior: PriorMessage[] = cur.messages
        .slice(0, idx)
        .filter((m) => m.content && !m.note && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => ({ role: m.role, content: m.content }))
      const botMsg: ChatMessage = {
        id: uid(),
        role: 'assistant',
        content: '',
        reasoning: '',
        tools: [],
        streaming: true,
        mode: get().reasoning
      }
      // 截断该用户消息之后的所有内容，追加新的回复占位
      patch(cur.id, (s) => ({
        ...s,
        messages: [...s.messages.slice(0, idx + 1), botMsg],
        updatedAt: Date.now()
      }))
      set((st) => ({ running: { ...st.running, [cur.id]: true }, status: '重新生成…' }))
      persist()
      await window.seek.resetSession(cur.id) // 清空主进程旧历史，用截断后的上下文重跑
      await window.seek.send({
        sessionId: cur.id,
        text: userText,
        options: { reasoning: get().reasoning, permissionMode: get().permissionMode },
        projectRoot: cur.projectRoot,
        priorMessages: prior
      })
    },

    retryMessage: async (assistantId) => {
      const cur = get().active()
      if (!cur) return
      const idx = cur.messages.findIndex((m) => m.id === assistantId)
      let ui = -1
      for (let i = idx - 1; i >= 0; i--) {
        if (cur.messages[i].role === 'user' && !cur.messages[i].note) {
          ui = i
          break
        }
      }
      if (ui < 0) return
      await get().regenerateFrom(cur.messages[ui].id)
    },

    editMessage: async (userId, newText) => {
      const cur = get().active()
      if (!cur || !newText.trim()) return
      patch(cur.id, (s) => ({
        ...s,
        messages: s.messages.map((m) => (m.id === userId ? { ...m, content: newText.trim() } : m))
      }))
      await get().regenerateFrom(userId)
    },

    command: async (raw) => {
      const cur = get().active()
      if (!cur) return
      const note = (text: string): void => {
        patch(cur.id, (s) => ({
          ...s,
          messages: [
            ...s.messages,
            { id: uid(), role: 'assistant', content: text, reasoning: '', tools: [], note: true }
          ],
          updatedAt: Date.now()
        }))
        persist()
      }
      const parts = raw.slice(1).trim().split(/\s+/)
      const cmd = (parts.shift() || '').toLowerCase()
      const arg = parts.join(' ')

      switch (cmd) {
        case 'help':
          note(
            '可用命令：\n/fast /balanced /deep（推理档位）· /think=深度\n/ask /accept /plan /auto（权限模式）\n/bg <任务> 委派后台并行执行\n/cost 本会话花费 · /clear 新建会话\n/memory 查看记忆 · /remember <内容> 写入 SEEK.md'
          )
          break
        case 'fast':
        case 'balanced':
        case 'deep':
          get().setReasoning(cmd as ReasoningMode)
          note(`已切换推理档位：${cmd.toUpperCase()}`)
          break
        case 'think':
          get().setReasoning('deep')
          note('已切换推理档位：DEEP')
          break
        case 'ask':
          get().setMode('ask')
          note('权限模式：询问授权')
          break
        case 'accept':
          get().setMode('acceptEdits')
          note('权限模式：接受编辑')
          break
        case 'plan':
          get().setMode('plan')
          note('权限模式：计划模式（只读，先出方案）')
          break
        case 'auto':
          get().setMode('auto')
          note('权限模式：全自动')
          break
        case 'cost': {
          const tt = cur.totals
          note(
            `本会话：缓存命中 ${Math.round(tt.hitRate * 100)}% · 花费 ¥${tt.cost.toFixed(4)} · 相比无缓存省下 ¥${tt.saved.toFixed(4)}`
          )
          break
        }
        case 'clear':
        case 'new':
          get().newSession()
          break
        case 'bg': {
          if (!arg) {
            note('用法：/bg <要委派到后台并行执行的任务>')
            break
          }
          if (!cur.projectRoot) {
            note('请先为该会话选择项目目录。')
            break
          }
          await get().startBgTask(arg)
          note(`已委派后台任务：${arg}\n（右侧「任务」面板查看进度，完成后系统通知）`)
          break
        }
        case 'memory': {
          const mem = await window.seek.getMemory(cur.projectRoot)
          const txt = [
            mem.global ? '【全局记忆】\n' + mem.global : '',
            mem.project ? '【项目记忆 SEEK.md】\n' + mem.project : ''
          ]
            .filter(Boolean)
            .join('\n\n')
          note(txt || '暂无记忆。用 /remember <内容> 写入项目记忆。')
          break
        }
        case 'remember': {
          if (!arg) {
            note('用法：/remember <要记住的内容>')
            break
          }
          if (!cur.projectRoot) {
            note('请先为该会话选择项目目录，再写入项目记忆。')
            break
          }
          const ok = await window.seek.addMemory('project', arg, cur.projectRoot)
          note(ok ? `已写入项目记忆 SEEK.md：${arg}` : '写入失败。')
          break
        }
        default:
          note(`未知命令 /${cmd}。输入 /help 查看可用命令。`)
      }
    },

    approve: (approvalId, approved) => {
      window.seek.approve(approvalId, approved)
      set((st) => ({ approvals: st.approvals.filter((a) => a.approvalId !== approvalId) }))
    },

    handleEvent: (e) => {
      const id = e.sessionId
      switch (e.type) {
        case 'status':
          set({ status: e.text })
          break
        case 'delta':
          patchLastBot(id, (m) => ({ ...m, content: m.content + e.text }))
          persistSoon()
          break
        case 'reasoning':
          patchLastBot(id, (m) => ({ ...m, reasoning: m.reasoning + e.text }))
          persistSoon()
          break
        case 'tool':
          patchLastBot(id, (m) => {
            const tools = [...m.tools]
            const i = tools.findIndex((x) => x.callId === e.callId)
            const item: StoredTool = {
              callId: e.callId,
              name: e.name,
              args: e.args,
              status: e.status,
              result: e.result,
              preview: e.preview
            }
            if (i >= 0) tools[i] = item
            else tools.push(item)
            return { ...m, tools }
          })
          // Agent 改动文件后，递增版本号触发文件树自动刷新
          if (e.status === 'done' && (e.name === 'write_file' || e.name === 'edit_file')) {
            set((st) => ({ treeVersion: st.treeVersion + 1 }))
          }
          persistSoon()
          break
        case 'approval':
          set((st) => ({
            approvals: [
              ...st.approvals,
              { sessionId: id, approvalId: e.approvalId, name: e.name, summary: e.summary, preview: e.preview }
            ]
          }))
          break
        case 'usage':
          patch(id, (s) => ({
            ...s,
            totals: {
              cost: s.totals.cost + e.usage.cost,
              saved: s.totals.saved + e.usage.saved,
              hitRate: e.usage.cacheHitRate
            }
          }))
          break
        case 'done':
        case 'aborted':
          patchLastBot(id, (m) => ({ ...m, streaming: false }))
          set((st) => ({
            running: { ...st.running, [id]: false },
            status: e.type === 'done' ? '完成' : '已中断'
          }))
          persist()
          break
        case 'error':
          patchLastBot(id, (m) => ({ ...m, streaming: false, error: e.message }))
          set((st) => ({ running: { ...st.running, [id]: false }, status: '出错' }))
          persist()
          break
      }
    }
  }
})
