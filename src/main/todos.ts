import { TodoItem } from '@shared/types'

// 任务清单纯逻辑（对标 Claude Code 的 TodoWrite，整表替换语义）。
// 让模型把多步任务显式列成清单并随进度更新——防跑偏、防漏步骤，用户实时可见。

const MAX_ITEMS = 20
const MAX_CONTENT = 200

export interface NormalizeResult {
  ok: boolean
  todos?: TodoItem[]
  error?: string
}

/** 校验并规整 todo_write 的参数（整表替换；最多一项 in_progress） */
export function normalizeTodos(raw: unknown): NormalizeResult {
  if (!Array.isArray(raw)) return { ok: false, error: 'todos 需为数组：[{ content, status }]' }
  if (raw.length === 0) return { ok: true, todos: [] } // 清空清单
  if (raw.length > MAX_ITEMS) return { ok: false, error: `清单过长（最多 ${MAX_ITEMS} 项），请合并粒度。` }
  const todos: TodoItem[] = []
  let inProgress = 0
  for (const it of raw) {
    const content = typeof it === 'string' ? it : typeof (it as any)?.content === 'string' ? (it as any).content : ''
    const trimmed = content.trim().slice(0, MAX_CONTENT)
    if (!trimmed) return { ok: false, error: '存在空的任务项（content 不能为空）' }
    const s = (it as any)?.status
    const status: TodoItem['status'] = s === 'in_progress' || s === 'completed' ? s : 'pending'
    if (status === 'in_progress') inProgress++
    todos.push({ content: trimmed, status })
  }
  if (inProgress > 1) return { ok: false, error: '同一时间只能有一项 in_progress，请先把其它项标为 pending 或 completed。' }
  return { ok: true, todos }
}

/** 渲染为工具结果文本（回灌模型，让其确认当前进度） */
export function renderTodos(todos: TodoItem[]): string {
  if (!todos.length) return '任务清单已清空。'
  const done = todos.filter((t) => t.status === 'completed').length
  const mark = (t: TodoItem): string => (t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○')
  return (
    `任务清单已更新（${done}/${todos.length} 完成）：\n` +
    todos.map((t) => `${mark(t)} ${t.content}`).join('\n') +
    (done === todos.length ? '\n全部完成 ✓' : '')
  )
}
