import { GitFileChange } from '@shared/types'

// git 输出解析（纯逻辑，无 Electron / 子进程依赖，便于单测）。

export interface ParsedStatus {
  branch?: string
  ahead: number
  behind: number
  files: GitFileChange[]
}

/**
 * 解析 `git status --porcelain=v1 -z -b` 输出。
 * -z：条目以 NUL 分隔、路径不转义不加引号；重命名条目后跟一个「原路径」NUL 段。
 * -b：首段为分支头 `## main...origin/main [ahead 1, behind 2]`。
 */
export function parseStatusZ(out: string): ParsedStatus {
  const res: ParsedStatus = { ahead: 0, behind: 0, files: [] }
  const segs = out.split('\0')
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (!seg) continue
    if (seg.startsWith('## ')) {
      Object.assign(res, parseBranchHeader(seg.slice(3)))
      continue
    }
    if (seg.length < 4) continue
    const x = seg[0]
    const y = seg[1]
    const path = seg.slice(3)
    const f: GitFileChange = { path, x, y }
    // 重命名/复制：下一个 NUL 段是原路径
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      f.origPath = segs[++i]
    }
    res.files.push(f)
  }
  return res
}

/** 解析分支头：`main...origin/main [ahead 1, behind 2]` / `HEAD (no branch)` / `No commits yet on main` */
export function parseBranchHeader(s: string): { branch?: string; ahead: number; behind: number } {
  let branch: string | undefined
  let ahead = 0
  let behind = 0
  const noCommits = s.match(/^No commits yet on (\S+)/)
  if (noCommits) {
    branch = noCommits[1]
  } else if (s.startsWith('HEAD')) {
    branch = 'HEAD（游离）'
  } else {
    branch = s.split('...')[0].trim()
  }
  const a = s.match(/ahead (\d+)/)
  const b = s.match(/behind (\d+)/)
  if (a) ahead = parseInt(a[1], 10)
  if (b) behind = parseInt(b[1], 10)
  return { branch, ahead, behind }
}

/** 已暂存：X 位有内容（不含未跟踪） */
export function isStaged(f: GitFileChange): boolean {
  return f.x !== ' ' && f.x !== '?'
}
/** 工作区有改动（含未跟踪） */
export function isUnstaged(f: GitFileChange): boolean {
  return f.y !== ' ' || f.x === '?'
}
export function isUntracked(f: GitFileChange): boolean {
  return f.x === '?'
}

/** 状态码 → 单字中文标签（列表展示用） */
export function changeLabel(code: string): string {
  switch (code) {
    case 'M':
      return '改'
    case 'A':
      return '增'
    case 'D':
      return '删'
    case 'R':
      return '名'
    case 'C':
      return '复'
    case 'U':
      return '冲'
    case '?':
      return '新'
    default:
      return code
  }
}

/** 解析 `git log --pretty=format:%h%x09%an%x09%ad%x09%s` 输出 */
export function parseLog(out: string): { hash: string; author: string; date: string; subject: string }[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', author = '', date = '', ...rest] = line.split('\t')
      return { hash, author, date, subject: rest.join('\t') }
    })
    .filter((e) => e.hash)
}
