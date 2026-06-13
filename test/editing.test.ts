import { describe, it, expect } from 'vitest'
import {
  applyEdit,
  applyEdits,
  balanceCheck,
  closestSnippet,
  diceSimilarity,
  fileOutline,
  globToRegex
} from '../src/main/editing'

describe('applyEdit · 精确匹配', () => {
  it('唯一匹配直接替换', () => {
    const r = applyEdit('const a = 1\nconst b = 2', 'const b = 2', 'const b = 3')
    expect(r.ok).toBe(true)
    expect(r.content).toBe('const a = 1\nconst b = 3')
    expect(r.count).toBe(1)
    expect(r.fuzzy).toBeUndefined()
  })

  it('多处匹配且未传 replace_all 时报错并给出处数', () => {
    const r = applyEdit('x\nfoo\nx\nfoo', 'foo', 'bar')
    expect(r.ok).toBe(false)
    expect(r.count).toBe(2)
    expect(r.error).toContain('replace_all')
  })

  it('replace_all 全部替换', () => {
    const r = applyEdit('foo a foo b foo', 'foo', 'bar', true)
    expect(r.ok).toBe(true)
    expect(r.content).toBe('bar a bar b bar')
    expect(r.count).toBe(3)
  })

  it('old_string 为空 / 与 new_string 相同时拒绝', () => {
    expect(applyEdit('abc', '', 'x').ok).toBe(false)
    expect(applyEdit('abc', 'a', 'a').ok).toBe(false)
  })
})

describe('applyEdit · 缩进容错', () => {
  it('缩进不一致时模糊命中并标记 fuzzy', () => {
    const content = 'function f() {\n        return 1\n}'
    // 模型给的 old_string 用了 2 空格缩进，文件实际是 8 空格
    const r = applyEdit(content, 'function f() {\n  return 1\n}', 'function f() {\n  return 2\n}')
    expect(r.ok).toBe(true)
    expect(r.fuzzy).toBe(true)
    expect(r.content).toContain('return 2')
  })

  it('模糊匹配多处且未传 replace_all 时不应用', () => {
    const content = '  foo()\n\n    foo()'
    const r = applyEdit(content, 'foo()', 'bar()')
    expect(r.ok).toBe(false)
    expect(r.count).toBe(2)
  })

  it('彻底无匹配时返回最相近片段提示', () => {
    const content = 'line one\nconst userName = getUser()\nline three'
    const r = applyEdit(content, 'const username = getUsers()', 'x')
    expect(r.ok).toBe(false)
    expect(r.count).toBe(0)
    expect(r.hint).toContain('userName')
  })
})

describe('applyEdits · 原子批量', () => {
  it('全部成功才生效，按顺序应用', () => {
    const r = applyEdits('a b c', [
      { old_string: 'a', new_string: 'x' },
      { old_string: 'x b', new_string: 'y' } // 作用在前一步结果上
    ])
    expect(r.ok).toBe(true)
    expect(r.content).toBe('y c')
    expect(r.counts).toEqual([1, 1])
  })

  it('任意一处失败则整体失败并指出第几处', () => {
    const r = applyEdits('a b c', [
      { old_string: 'a', new_string: 'x' },
      { old_string: 'not-exist-token', new_string: 'y' }
    ])
    expect(r.ok).toBe(false)
    expect(r.failedIndex).toBe(1)
    expect(r.content).toBeUndefined()
  })

  it('空编辑列表拒绝', () => {
    expect(applyEdits('a', []).ok).toBe(false)
  })
})

describe('balanceCheck · 语法体检', () => {
  it('JSON 解析失败给出行号提示', () => {
    expect(balanceCheck('{"a": 1}', 'json')).toBeNull()
    const warn = balanceCheck('{"a": 1,\n"b": }', 'json')
    expect(warn).toContain('JSON 解析失败')
  })

  it('平衡代码无警告', () => {
    expect(balanceCheck('function f(a: number[]) { return { x: [a] } }', 'ts')).toBeNull()
  })

  it('多余右括号给出行号', () => {
    const warn = balanceCheck('const a = 1\nconst b = (2))\n', 'ts')
    expect(warn).toContain('第 2 行')
  })

  it('未闭合左括号有警告', () => {
    expect(balanceCheck('function f() {\n  return 1\n', 'js')).toContain('未闭合')
  })

  it('字符串与注释中的括号被忽略', () => {
    expect(balanceCheck('const s = "(((" // )))\n/* } */ const t = `)`', 'ts')).toBeNull()
  })

  it('python # 注释与三引号字符串被忽略', () => {
    expect(balanceCheck('s = """((("""\n# )))\nx = (1)', 'py')).toBeNull()
  })

  it('不支持的类型不报告', () => {
    expect(balanceCheck('((((', 'md')).toBeNull()
  })
})

describe('globToRegex', () => {
  const match = (glob: string, path: string): boolean => {
    const { re, baseNameOnly } = globToRegex(glob)
    const target = baseNameOnly ? (path.split('/').pop() ?? path) : path
    return re.test(target)
  }
  it('* 不跨目录，** 跨目录', () => {
    expect(match('src/*.ts', 'src/a.ts')).toBe(true)
    expect(match('src/*.ts', 'src/sub/a.ts')).toBe(false)
    expect(match('src/**/*.ts', 'src/sub/deep/a.ts')).toBe(true)
    expect(match('**/*.ts', 'a.ts')).toBe(true) // **/ 可匹配零层
  })
  it('无 / 的模式匹配任意目录下的文件名', () => {
    expect(match('*.test.ts', 'test/deep/foo.test.ts')).toBe(true)
    expect(match('*.test.ts', 'src/foo.ts')).toBe(false)
  })
  it('? 与 {a,b} 选择', () => {
    expect(match('a?.ts', 'ab.ts')).toBe(true)
    expect(match('*.{ts,tsx}', 'x/y/App.tsx')).toBe(true)
    expect(match('*.{ts,tsx}', 'x/y/App.css')).toBe(false)
  })
})

describe('fileOutline', () => {
  it('TS 提取带行号的符号', () => {
    const code = 'import x from "y"\nexport function hello() {}\nclass World {}\nexport const VERSION = 1'
    const out = fileOutline(code, 'ts')
    expect(out).toContain('L2  function hello')
    expect(out).toContain('L3  class World')
    expect(out).toContain('L4  const VERSION')
  })
  it('python 提取 class/def', () => {
    const out = fileOutline('class A:\n    def run(self):\n        pass', 'py')
    expect(out[0]).toBe('L1  class A')
    expect(out[1]).toBe('L2  def run')
  })
  it('不支持的扩展返回空', () => {
    expect(fileOutline('# title', 'md')).toEqual([])
  })
})

describe('diceSimilarity / closestSnippet', () => {
  it('相似度有序：相同 > 相近 > 无关', () => {
    const same = diceSimilarity('const a = 1', 'const a = 1')
    const near = diceSimilarity('const a = 1', 'const a = 2')
    const far = diceSimilarity('const a = 1', 'def totally_different():')
    expect(same).toBe(1)
    expect(near).toBeGreaterThan(far)
  })
  it('closestSnippet 带行号且包含命中行', () => {
    const content = 'aaa\nbbb\nfunction getUserName() {\nccc'
    const snip = closestSnippet(content, 'function getUsername() {')
    expect(snip).toContain('3')
    expect(snip).toContain('getUserName')
  })
  it('完全无关时不给误导性提示', () => {
    expect(closestSnippet('aaa\nbbb', 'zzzzzz_qqqqq_wwwww()')).toBeNull()
  })
})
