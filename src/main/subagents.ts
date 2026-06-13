import { runAgent, abortSession, resetSession, Emit, ApprovalFn } from './agent'
import { AgentEvent, PermissionMode, ProjectInfo, ReasoningMode, SubagentUpdate } from '@shared/types'

// 子代理 / 多代理协作编排：
//  - 编排者（主对话 Agent）调用 spawn_subagents 工具，把互相独立的子任务并发委派出去
//  - 每个子代理是一次独立的 Agent 循环：继承父会话的权限模式与项目目录，
//    写入/命令的审批经由父会话的审批通道上浮（摘要带「子代理」标识）
//  - 进度以 subagent 事件实时推给渲染层，内嵌在 spawn_subagents 工具卡里展示
//  - 子代理不可再派生子代理（防递归爆炸）；父会话被中断时所有子代理一并中止

export const MAX_SUBAGENT_TASKS = 6 // 单次委派的子任务上限
const MAX_PARALLEL = 3 // 同时运行的子代理数
const RESULT_CLIP = 1600 // 单个子代理结果回灌编排者的字符上限

function shortArg(args: string): string {
  try {
    const o = JSON.parse(args)
    return o.path || o.command || o.query || ''
  } catch {
    return ''
  }
}

function clipTail(s: string, n: number): string {
  const t = s.trim()
  return t.length > n ? '…' + t.slice(-n) : t
}

/** 解析 spawn_subagents 的 tasks 参数 → goal 列表（非法/越界返回空） */
export function parseSubagentGoals(args: Record<string, unknown>): string[] {
  const tasks = args.tasks
  if (!Array.isArray(tasks)) return []
  const goals: string[] = []
  for (const t of tasks) {
    const goal = typeof t === 'string' ? t : typeof (t as any)?.goal === 'string' ? (t as any).goal : ''
    if (goal.trim()) goals.push(goal.trim())
    if (goals.length >= MAX_SUBAGENT_TASKS) break
  }
  return goals
}

const SUB_PREAMBLE = `【子代理任务】你是一个被并行委派的子代理，请独立完成以下任务。注意：
- 你看不到主对话的历史，任务描述即全部上下文；
- 按需使用工具，直接动手，不要等待确认（需要审批的操作会自动上浮给用户）；
- 完成后输出一份简明结果报告：关键发现 / 创建或修改的文件 / 结论，供主代理汇总。

任务：`

interface SubRun {
  state: SubagentUpdate
  text: string
  failed: boolean
}

/**
 * 并发运行一组子代理（受 MAX_PARALLEL 限制），返回汇总报告（作为工具结果回灌编排者）。
 * 进度经 emit 以 subagent 事件推送；审批经父会话 approve 上浮；parentSignal 中断时全体中止。
 */
export async function runSubagents(
  parentSessionId: string,
  callId: string,
  goals: string[],
  project: ProjectInfo,
  mode: ReasoningMode,
  perm: PermissionMode,
  emit: Emit,
  approve: ApprovalFn,
  parentSignal: AbortSignal
): Promise<string> {
  const runs: SubRun[] = goals.map((goal, i) => ({
    state: {
      id: `${parentSessionId}.sub${i + 1}`,
      goal,
      status: 'queued',
      lastAction: '排队中…',
      toolCount: 0
    },
    text: '',
    failed: false
  }))

  const push = (r: SubRun): void =>
    emit({ type: 'subagent', sessionId: parentSessionId, callId, sub: { ...r.state } })
  runs.forEach(push)

  // 父会话中断 → 中止所有子代理
  const onAbort = (): void => runs.forEach((r) => abortSession(r.state.id))
  parentSignal.addEventListener('abort', onAbort, { once: true })

  const runOne = async (r: SubRun): Promise<void> => {
    if (parentSignal.aborted) {
      r.state.status = 'error'
      r.state.lastAction = '已随主会话中止'
      push(r)
      return
    }
    r.state.status = 'running'
    r.state.lastAction = '启动…'
    push(r)

    const adapter: Emit = (e: AgentEvent): void => {
      if (e.type === 'delta') {
        r.text += e.text
      } else if (e.type === 'tool' && e.status === 'running') {
        r.state.toolCount++
        r.state.lastAction = `${e.name} ${shortArg(e.args)}`.trim()
        push(r)
      } else if (e.type === 'usage') {
        // 子代理花费计入父会话（成本透明）
        emit({ type: 'usage', sessionId: parentSessionId, usage: e.usage })
      } else if (e.type === 'error') {
        r.failed = true
        r.state.lastAction = '出错：' + e.message
      } else if (e.type === 'aborted') {
        r.failed = true
        r.state.lastAction = '已中止'
      }
    }
    // 审批上浮：用父会话身份请求，摘要带子代理标识
    const subApprove: ApprovalFn = (_sid, name, summary, preview) =>
      approve(parentSessionId, name, `【子代理】${summary}`, preview)

    resetSession(r.state.id) // 确保无残留历史
    try {
      await runAgent(
        r.state.id,
        SUB_PREAMBLE + r.state.goal,
        { reasoning: mode, permissionMode: perm, isSubagent: true },
        project,
        adapter,
        subApprove
      )
    } catch (e: any) {
      r.failed = true
      r.state.lastAction = '出错：' + (e?.message ?? String(e))
    }
    resetSession(r.state.id) // 用完即弃，不占会话 LRU
    r.state.status = r.failed ? 'error' : 'done'
    if (!r.failed) r.state.lastAction = `已完成 · ${r.state.toolCount} 次工具调用`
    r.state.result = clipTail(r.text, 280)
    push(r)
  }

  // 简单工作池：MAX_PARALLEL 个 worker 共享队列
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < runs.length) {
      const r = runs[next++]
      await runOne(r)
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, runs.length) }, worker))
  parentSignal.removeEventListener('abort', onAbort)

  // 汇总报告（回灌给编排者）
  const parts = runs.map((r, i) => {
    const head = `### 子代理 ${i + 1}（${r.state.status === 'done' ? '完成' : '失败/中止'} · ${r.state.toolCount} 次工具调用）\n任务：${r.state.goal.slice(0, 120)}`
    const body = clipTail(r.text, RESULT_CLIP) || '（无文字输出）'
    return `${head}\n${body}`
  })
  return `已并行执行 ${runs.length} 个子代理，结果汇总如下。请基于这些结果继续完成总体任务（必要时收尾整合），并向用户给出整体总结：\n\n${parts.join('\n\n')}`
}
