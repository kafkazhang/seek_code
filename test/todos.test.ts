import { describe, it, expect } from 'vitest'
import { normalizeTodos, renderTodos } from '../src/main/todos'

describe('normalizeTodos', () => {
  it('规整合法清单，默认 status=pending', () => {
    const r = normalizeTodos([{ content: '读代码' }, { content: '改代码', status: 'in_progress' }])
    expect(r.ok).toBe(true)
    expect(r.todos).toEqual([
      { content: '读代码', status: 'pending' },
      { content: '改代码', status: 'in_progress' }
    ])
  })
  it('支持纯字符串项', () => {
    const r = normalizeTodos(['任务一', '任务二'])
    expect(r.ok).toBe(true)
    expect(r.todos![0]).toEqual({ content: '任务一', status: 'pending' })
  })
  it('空数组 = 清空清单', () => {
    expect(normalizeTodos([])).toEqual({ ok: true, todos: [] })
  })
  it('非数组 / 空 content / 超长清单拒绝', () => {
    expect(normalizeTodos('x').ok).toBe(false)
    expect(normalizeTodos([{ content: '  ' }]).ok).toBe(false)
    expect(normalizeTodos(Array.from({ length: 21 }, (_, i) => ({ content: 't' + i }))).ok).toBe(false)
  })
  it('多于一项 in_progress 拒绝', () => {
    const r = normalizeTodos([
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'in_progress' }
    ])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('in_progress')
  })
  it('非法 status 回退为 pending', () => {
    const r = normalizeTodos([{ content: 'a', status: 'doing' }])
    expect(r.todos![0].status).toBe('pending')
  })
})

describe('renderTodos', () => {
  it('显示进度与状态标记', () => {
    const text = renderTodos([
      { content: '一', status: 'completed' },
      { content: '二', status: 'in_progress' },
      { content: '三', status: 'pending' }
    ])
    expect(text).toContain('1/3')
    expect(text).toContain('✓ 一')
    expect(text).toContain('→ 二')
    expect(text).toContain('○ 三')
  })
  it('全部完成有结语，空清单有提示', () => {
    expect(renderTodos([{ content: 'x', status: 'completed' }])).toContain('全部完成')
    expect(renderTodos([])).toContain('清空')
  })
})
