import { describe, it, expect } from 'vitest'
import {
  parseStatusZ,
  parseBranchHeader,
  parseLog,
  isStaged,
  isUnstaged,
  isUntracked
} from '../src/main/gitparse'

const NUL = '\0'

describe('parseStatusZ', () => {
  it('解析分支头 + 普通变更', () => {
    const out = ['## main...origin/main [ahead 2, behind 1]', ' M src/a.ts', 'M  src/b.ts', '?? new.txt'].join(NUL) + NUL
    const r = parseStatusZ(out)
    expect(r.branch).toBe('main')
    expect(r.ahead).toBe(2)
    expect(r.behind).toBe(1)
    expect(r.files).toHaveLength(3)
    expect(r.files[0]).toMatchObject({ path: 'src/a.ts', x: ' ', y: 'M' })
    expect(r.files[1]).toMatchObject({ path: 'src/b.ts', x: 'M', y: ' ' })
    expect(r.files[2]).toMatchObject({ path: 'new.txt', x: '?', y: '?' })
  })

  it('解析重命名（-z 下一段为原路径）', () => {
    const out = ['## main', 'R  new-name.ts', 'old-name.ts'].join(NUL) + NUL
    const r = parseStatusZ(out)
    expect(r.files).toHaveLength(1)
    expect(r.files[0]).toMatchObject({ path: 'new-name.ts', origPath: 'old-name.ts', x: 'R' })
  })

  it('含空格与中文的路径不被破坏', () => {
    const out = ['## main', ' M src/我的 文件.ts'].join(NUL) + NUL
    expect(parseStatusZ(out).files[0].path).toBe('src/我的 文件.ts')
  })

  it('干净工作区只有分支头', () => {
    const r = parseStatusZ('## main...origin/main' + NUL)
    expect(r.branch).toBe('main')
    expect(r.files).toHaveLength(0)
  })
})

describe('parseBranchHeader', () => {
  it('无上游分支', () => {
    expect(parseBranchHeader('feature/x')).toMatchObject({ branch: 'feature/x', ahead: 0, behind: 0 })
  })
  it('新仓库（尚无提交）', () => {
    expect(parseBranchHeader('No commits yet on main').branch).toBe('main')
  })
  it('游离 HEAD', () => {
    expect(parseBranchHeader('HEAD (no branch)').branch).toContain('HEAD')
  })
})

describe('staged / unstaged / untracked 分组', () => {
  it('暂存区有内容即 staged', () => {
    expect(isStaged({ path: 'a', x: 'M', y: ' ' })).toBe(true)
    expect(isStaged({ path: 'a', x: ' ', y: 'M' })).toBe(false)
    expect(isStaged({ path: 'a', x: '?', y: '?' })).toBe(false)
  })
  it('工作区有改动或未跟踪即 unstaged', () => {
    expect(isUnstaged({ path: 'a', x: ' ', y: 'M' })).toBe(true)
    expect(isUnstaged({ path: 'a', x: '?', y: '?' })).toBe(true)
    expect(isUnstaged({ path: 'a', x: 'M', y: ' ' })).toBe(false)
  })
  it('部分暂存的文件同时出现在两组', () => {
    const f = { path: 'a', x: 'M', y: 'M' }
    expect(isStaged(f)).toBe(true)
    expect(isUnstaged(f)).toBe(true)
  })
  it('未跟踪识别', () => {
    expect(isUntracked({ path: 'a', x: '?', y: '?' })).toBe(true)
    expect(isUntracked({ path: 'a', x: 'A', y: ' ' })).toBe(false)
  })
})

describe('parseLog', () => {
  it('按 tab 切分各字段，subject 内的 tab 不丢', () => {
    const out = 'abc1234\t张三\t2026-06-12 10:00\tfeat: 新功能\twith tab\nddd5678\t李四\t2026-06-11 09:30\tfix: 修复'
    const log = parseLog(out)
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ hash: 'abc1234', author: '张三', subject: 'feat: 新功能\twith tab' })
    expect(log[1].date).toBe('2026-06-11 09:30')
  })
  it('空输出返回空数组', () => {
    expect(parseLog('')).toEqual([])
  })
})
