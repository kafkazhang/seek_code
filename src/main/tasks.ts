import { app, Notification } from 'electron'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { runAgent, abortSession } from './agent'
import { AgentEvent, BgTask, BgTaskEvent, ProjectInfo, ReasoningMode } from '@shared/types'

interface TaskOpts {
  reasoning?: ReasoningMode
  images?: string[]
}

// 后台任务：主进程内并发运行自主 Agent（auto 权限），与前台对话并行。
// Agent 任务是 I/O 密集（等 LLM / 文件），并发即可获得真实并行度。
//
// 相比早期实现，本版补齐两点：
//   1) 持久化：任务落盘 userData/tasks.json，重启后恢复列表（运行中的任务会被标记为中断）。
//   2) 队列化：限制最大并发数，超出的任务进入队列，待空位释放后自动出队执行。

const MAX_CONCURRENT = 2 // 最大并行任务数（其余排队）
const MAX_PERSIST = 100 // 落盘任务上限

const tasks = new Map<string, BgTask>()
const queue: string[] = [] // 等待执行的任务 id（FIFO）
const projects = new Map<string, ProjectInfo>() // 任务 id → 项目（出队时需要）
const taskOpts = new Map<string, TaskOpts>() // 任务 id → 推理档位/图片（启动时使用）
let emitFn: Emit | null = null
let running = 0

type Emit = (e: BgTaskEvent) => void

// ── 持久化 ───────────────────────────────────────────
function tasksPath(): string {
  return join(app.getPath('userData'), 'tasks.json')
}
function atomicWrite(p: string, content: string): void {
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, p)
}
function persist(): void {
  try {
    const list = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_PERSIST)
    atomicWrite(tasksPath(), JSON.stringify(list, null, 2))
  } catch {
    /* 忽略写入失败 */
  }
}

/** 启动时加载历史任务：运行中/排队的任务在重启后无法续跑，标记为「已中断」 */
export function loadTasks(): void {
  try {
    const p = tasksPath()
    if (!existsSync(p)) return
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as BgTask[]
    for (const t of raw) {
      const status = t.status === 'running' || t.status === 'queued' ? 'cancelled' : t.status
      tasks.set(t.id, {
        ...t,
        status,
        lastAction: status === 'cancelled' && t.status !== 'cancelled' ? '应用重启，已中断' : t.lastAction
      })
    }
  } catch {
    /* 损坏则忽略 */
  }
}

function shortArg(args: string): string {
  try {
    const o = JSON.parse(args)
    return o.path || o.command || o.query || ''
  } catch {
    return ''
  }
}

export function startTask(goal: string, project: ProjectInfo, emit: Emit, opts: TaskOpts = {}): string {
  emitFn = emit
  const id = 'bg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const queued = running >= MAX_CONCURRENT
  const t: BgTask = {
    id,
    goal,
    status: queued ? 'queued' : 'running',
    createdAt: Date.now(),
    projectName: project.name,
    lastAction: queued ? '排队中…' : '启动…',
    result: '',
    toolCount: 0
  }
  tasks.set(id, t)
  projects.set(id, project)
  taskOpts.set(id, opts)
  emit({ type: 'update', task: { ...t } })
  persist()

  if (queued) queue.push(id)
  else launch(id)
  return id
}

function launch(id: string): void {
  const t = tasks.get(id)
  const project = projects.get(id)
  if (!t || !project) return
  running++
  t.status = 'running'
  t.lastAction = '启动…'
  emitFn?.({ type: 'update', task: { ...t } })
  persist()

  const adapter = (e: AgentEvent): void => {
    if (e.type === 'delta') {
      t.result = (t.result + e.text).slice(-4000)
    } else if (e.type === 'tool' && e.status === 'running') {
      t.lastAction = `${e.name} ${shortArg(e.args)}`.trim()
      t.toolCount++
    } else if (e.type === 'done') {
      t.status = 'done'
      t.lastAction = `已完成 · ${t.toolCount} 次工具调用`
      finish(id)
      notify(t)
    } else if (e.type === 'error') {
      t.status = 'error'
      t.lastAction = '出错：' + e.message
      finish(id)
      notify(t)
    } else if (e.type === 'aborted') {
      t.status = 'cancelled'
      t.lastAction = '已取消'
      finish(id)
    }
    emitFn?.({ type: 'update', task: { ...t } })
    persist()
  }

  const opts = taskOpts.get(id) ?? {}
  void runAgent(
    id,
    t.goal,
    { reasoning: opts.reasoning ?? 'balanced', permissionMode: 'auto' },
    project,
    adapter,
    async () => true,
    [],
    opts.images ?? []
  )
}

/** 一个任务结束后：释放并发名额、清理项目引用、出队下一个 */
function finish(id: string): void {
  running = Math.max(0, running - 1)
  projects.delete(id)
  taskOpts.delete(id)
  while (running < MAX_CONCURRENT && queue.length) {
    const next = queue.shift()!
    if (tasks.get(next)?.status === 'queued') launch(next)
  }
}

export function listTasks(): BgTask[] {
  return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).map((t) => ({ ...t }))
}

export function cancelTask(id: string): void {
  const t = tasks.get(id)
  if (!t) return
  // 仍在队列中（未启动）：直接出队并标记取消，无需触达 Agent
  if (t.status === 'queued') {
    const i = queue.indexOf(id)
    if (i >= 0) queue.splice(i, 1)
    t.status = 'cancelled'
    t.lastAction = '已取消（未开始）'
    projects.delete(id)
    taskOpts.delete(id)
    emitFn?.({ type: 'update', task: { ...t } })
    persist()
    return
  }
  abortSession(id)
}

function notify(t: BgTask): void {
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: t.status === 'done' ? 'SeekCode · 后台任务完成' : 'SeekCode · 后台任务出错',
        body: t.goal.slice(0, 90)
      }).show()
    }
  } catch {
    /* ignore */
  }
}
