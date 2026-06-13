// 编辑与代码理解的纯逻辑模块（无 Electron / 文件系统依赖，便于单测）。
// 针对模型编程的典型短板做工具侧补强：
//  - applyEdit：精确匹配 → 空白容错模糊匹配 → 失败时给出"最相近片段"提示，帮模型自纠
//  - applyEdits：单文件多处原子批量编辑（全部成功才生效，避免半截改动污染文件）
//  - balanceCheck：写入后的轻量语法体检（JSON 解析 / 括号平衡启发式），即时反馈低级错误
//  - globToRegex / fileOutline：glob 找文件、单文件符号大纲（带行号）

// ── 单处编辑 ─────────────────────────────────────────
export interface EditOutcome {
  ok: boolean
  content?: string
  /** 实际替换的处数 */
  count?: number
  /** 是否经空白容错匹配命中（非字节级精确） */
  fuzzy?: boolean
  error?: string
  /** 失败时的自纠提示（最相近片段等） */
  hint?: string
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    n++
    i = haystack.indexOf(needle, i + needle.length)
  }
  return n
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 空白容错正则：逐行 trim 后允许任意行首/行尾水平空白。
 * 解决最常见的「缩进不一致导致 old_string 匹配失败」。
 */
function fuzzyRegex(oldStr: string): RegExp | null {
  const lines = oldStr.split('\n')
  if (lines.every((l) => !l.trim())) return null
  const body = lines
    .map((l) => {
      const t = l.replace(/\r$/, '').trim()
      return t ? `[ \\t]*${escapeRe(t)}[ \\t]*` : '[ \\t]*'
    })
    .join('\\r?\\n')
  try {
    return new RegExp(body, 'g')
  } catch {
    return null
  }
}

/** 字符二元组 Dice 相似度（0..1），用于找最相近行 */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const ga = grams(a)
  const gb = grams(b)
  let inter = 0
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0)
  return (2 * inter) / (a.length - 1 + b.length - 1)
}

/** 在文件中找与 old_string 最相近的位置，返回带行号的片段（供模型自纠） */
export function closestSnippet(content: string, oldStr: string, ctx = 4): string | null {
  // 取 old_string 中最有辨识度的一行（最长的非空 trim 行）
  const probe = oldStr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 4)
    .sort((a, b) => b.length - a.length)[0]
  if (!probe) return null
  const lines = content.split('\n')
  let bestIdx = -1
  let bestScore = 0.45 // 相似度门槛，低于此不给提示（避免误导）
  for (let i = 0; i < lines.length; i++) {
    const s = diceSimilarity(lines[i].trim(), probe)
    if (s > bestScore) {
      bestScore = s
      bestIdx = i
    }
  }
  if (bestIdx < 0) return null
  const from = Math.max(0, bestIdx - ctx)
  const to = Math.min(lines.length - 1, bestIdx + ctx)
  const out: string[] = []
  for (let i = from; i <= to; i++) out.push(`${String(i + 1).padStart(4)}  ${lines[i]}`)
  return out.join('\n')
}

/**
 * 应用一处编辑：
 *  1) 精确匹配唯一 → 直接替换；多处且 replaceAll → 全部替换；多处且非 replaceAll → 报错并给出处数
 *  2) 精确无匹配 → 空白容错模糊匹配（唯一命中才应用，并标记 fuzzy）
 *  3) 仍无 → 返回最相近片段提示
 */
export function applyEdit(content: string, oldStr: string, newStr: string, replaceAll = false): EditOutcome {
  if (!oldStr) return { ok: false, error: 'old_string 不能为空。新建/覆盖整文件请用 write_file。' }
  if (oldStr === newStr) return { ok: false, error: 'old_string 与 new_string 相同，无需编辑。' }

  const occ = countOccurrences(content, oldStr)
  if (occ === 1) {
    const i = content.indexOf(oldStr)
    return { ok: true, content: content.slice(0, i) + newStr + content.slice(i + oldStr.length), count: 1 }
  }
  if (occ > 1) {
    if (replaceAll) return { ok: true, content: content.split(oldStr).join(newStr), count: occ }
    return {
      ok: false,
      count: occ,
      error: `old_string 匹配到 ${occ} 处。请提供更长的唯一片段（带上下文行），或确需全部替换时传 replace_all: true。`
    }
  }

  // 空白容错
  const re = fuzzyRegex(oldStr)
  if (re) {
    const matches = [...content.matchAll(re)]
    if (matches.length === 1) {
      const m = matches[0]
      const i = m.index ?? 0
      return { ok: true, content: content.slice(0, i) + newStr + content.slice(i + m[0].length), count: 1, fuzzy: true }
    }
    if (matches.length > 1 && replaceAll) {
      let out = ''
      let last = 0
      for (const m of matches) {
        const i = m.index ?? 0
        out += content.slice(last, i) + newStr
        last = i + m[0].length
      }
      return { ok: true, content: out + content.slice(last), count: matches.length, fuzzy: true }
    }
    if (matches.length > 1) {
      return {
        ok: false,
        count: matches.length,
        error: `old_string 忽略缩进后匹配到 ${matches.length} 处。请提供更长的唯一片段，或传 replace_all: true。`
      }
    }
  }

  const hint = closestSnippet(content, oldStr)
  return {
    ok: false,
    count: 0,
    error: '未找到 old_string（已尝试忽略缩进的容错匹配），文件未改动。',
    hint: hint
      ? `文件中最相近的位置如下（注意与你提供内容的差异，按实际内容修正 old_string）：\n${hint}`
      : '请先 read_file 查看该文件的最新内容再编辑。'
  }
}

// ── 批量编辑（原子）──────────────────────────────────
export interface BatchEdit {
  old_string: string
  new_string: string
  replace_all?: boolean
}

export interface BatchOutcome {
  ok: boolean
  content?: string
  /** 成功时各编辑的替换处数 */
  counts?: number[]
  /** 失败时第几个编辑出错（0 起） */
  failedIndex?: number
  error?: string
  hint?: string
}

/** 顺序应用多处编辑；任何一处失败则整体不生效（原子性） */
export function applyEdits(content: string, edits: BatchEdit[]): BatchOutcome {
  if (!edits.length) return { ok: false, error: 'edits 不能为空' }
  let cur = content
  const counts: number[] = []
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]
    const r = applyEdit(cur, e.old_string ?? '', e.new_string ?? '', e.replace_all === true)
    if (!r.ok) {
      return { ok: false, failedIndex: i, error: `第 ${i + 1}/${edits.length} 处编辑失败：${r.error}`, hint: r.hint }
    }
    cur = r.content!
    counts.push(r.count ?? 0)
  }
  return { ok: true, content: cur, counts }
}

// ── 写入后语法体检（轻量启发式，只警告不拦截）──────────
const BRACKET_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs',
  'go', 'rs', 'swift', 'scala', 'css', 'scss', 'less', 'php', 'dart'
])
const HASH_COMMENT_EXTS = new Set(['py', 'sh', 'rb', 'yaml', 'yml', 'toml'])

/**
 * 语法体检：JSON 做真实解析；常见代码做忽略字符串/注释的括号平衡扫描。
 * 返回 null 表示未发现问题或文件类型不支持；返回字符串为警告信息（不阻断写入）。
 */
export function balanceCheck(text: string, ext: string): string | null {
  const e = ext.toLowerCase()
  if (e === 'json') {
    try {
      JSON.parse(text)
      return null
    } catch (err: any) {
      const m = /position (\d+)/.exec(err?.message ?? '')
      const line = m ? text.slice(0, parseInt(m[1], 10)).split('\n').length : undefined
      return `JSON 解析失败${line ? `（约第 ${line} 行）` : ''}：${err?.message ?? err}`
    }
  }
  const hashComment = HASH_COMMENT_EXTS.has(e)
  if (!BRACKET_EXTS.has(e) && !hashComment) return null

  const OPEN: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  const stack: { ch: string; line: number }[] = []
  let line = 1
  let str: string | null = null // 当前字符串引号
  let blockComment = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '\n') {
      line++
      if (str && str !== '`' && str !== "'''" && str !== '"""') str = null // 普通字符串不跨行，容错复位
      continue
    }
    if (blockComment) {
      if (c === '*' && next === '/') {
        blockComment = false
        i++
      }
      continue
    }
    if (str) {
      if (c === '\\') {
        i++
        continue
      }
      if (str.length === 3) {
        if (c === str[0] && text.slice(i, i + 3) === str) {
          str = null
          i += 2
        }
        continue
      }
      if (c === str) str = null
      continue
    }
    // 非字符串、非注释状态
    if (c === '/' && next === '/' && !hashComment) {
      while (i < text.length && text[i] !== '\n') i++
      i-- // 让 \n 走正常计行
      continue
    }
    if (c === '#' && hashComment) {
      while (i < text.length && text[i] !== '\n') i++
      i--
      continue
    }
    if (c === '/' && next === '*' && !hashComment) {
      blockComment = true
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      // python 三引号
      if (hashComment && (c === '"' || c === "'") && text.slice(i, i + 3) === c.repeat(3)) {
        str = c.repeat(3)
        i += 2
      } else {
        str = c
      }
      continue
    }
    if (c === '(' || c === '[' || c === '{') {
      stack.push({ ch: c, line })
    } else if (c === ')' || c === ']' || c === '}') {
      const top = stack.pop()
      if (!top || top.ch !== OPEN[c]) {
        return `括号疑似不平衡：第 ${line} 行出现多余的 \`${c}\`${top ? `（与第 ${top.line} 行的 \`${top.ch}\` 不匹配）` : ''}。请复查改动。`
      }
    }
  }
  if (stack.length) {
    const top = stack[stack.length - 1]
    return `括号疑似不平衡：第 ${top.line} 行的 \`${top.ch}\` 未闭合（共 ${stack.length} 个未闭合）。请复查改动。`
  }
  return null
}

// ── glob → 正则（find_files 用）─────────────────────
/** 支持 ** / * / ? / {a,b}；无路径分隔符的模式匹配文件名（任意目录深度） */
export function globToRegex(glob: string): { re: RegExp; baseNameOnly: boolean } {
  const baseNameOnly = !glob.includes('/')
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // ** 或 **/
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end > i) {
        const alts = glob
          .slice(i + 1, end)
          .split(',')
          .map((s) => escapeRe(s))
        out += '(?:' + alts.join('|') + ')'
        i = end
      } else {
        out += escapeRe(c)
      }
    } else {
      out += escapeRe(c)
    }
  }
  return { re: new RegExp('^' + out + '$', 'i'), baseNameOnly }
}

// ── 单文件符号大纲（带行号）──────────────────────────
const OUTLINE_RES: { exts: string[]; re: RegExp }[] = [
  {
    exts: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
    re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let)\s+([A-Za-z0-9_$]+)/
  },
  { exts: ['py'], re: /^[ \t]*(class|def)\s+([A-Za-z0-9_]+)/ },
  { exts: ['go'], re: /^[ \t]*(func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/ },
  { exts: ['rs'], re: /^[ \t]*(?:pub\s+)?(fn|struct|enum|trait|impl|mod)\s+([A-Za-z0-9_]+)/ },
  { exts: ['java', 'kt', 'cs', 'scala'], re: /^[ \t]*(?:public|private|protected|internal|static|final|abstract|sealed|\s)*(class|interface|enum|record|fun|void)\s+([A-Za-z0-9_]+)/ }
]

/** 提取「行号 + 种类 + 名字」的大纲，让模型不读全文即可了解文件结构 */
export function fileOutline(text: string, ext: string, max = 100): string[] {
  const def = OUTLINE_RES.find((d) => d.exts.includes(ext.toLowerCase()))
  if (!def) return []
  const out: string[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const m = def.re.exec(lines[i])
    if (m) out.push(`L${i + 1}  ${m[1]} ${m[2]}`)
  }
  return out
}
