// 符号导航纯逻辑（无 Electron / 文件系统依赖，便于单测）。
// 对标 Cursor 的「转到定义 / 查找引用」：不引入 LSP（重依赖、按语言装服务），
// 用 AST-lite 正则按扩展名判定「定义行」，配合代码索引的词法预过滤，零依赖可离线。

/** 各语言家族的「定义行」模板：{S} 会被替换为转义后的符号名 */
const DEF_TEMPLATES: { exts: string[]; patterns: string[] }[] = [
  {
    exts: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
    patterns: [
      '\\b(?:function|class|interface|type|enum)\\s+{S}\\b',
      '\\b(?:const|let|var)\\s+{S}\\s*[=:(]',
      // 对象方法 / class 方法：foo(args) { 或 foo = (args) =>
      '^\\s*(?:public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+|readonly\\s+)*{S}\\s*(?:=\\s*(?:async\\s*)?\\(|\\([^)]*\\)\\s*(?::[^={]+)?\\{)',
      "\\b{S}\\s*:\\s*(?:async\\s*)?(?:function\\b|\\()"
    ]
  },
  {
    exts: ['py'],
    patterns: ['^\\s*(?:class|def)\\s+{S}\\b', '^{S}\\s*=']
  },
  {
    exts: ['go'],
    patterns: ['^\\s*func\\s+(?:\\([^)]*\\)\\s*)?{S}\\b', '^\\s*type\\s+{S}\\b', '^\\s*(?:var|const)\\s+{S}\\b']
  },
  {
    exts: ['rs'],
    patterns: ['^\\s*(?:pub\\s+)?(?:fn|struct|enum|trait|mod|type|const|static)\\s+{S}\\b', '^\\s*(?:pub\\s+)?let\\s+(?:mut\\s+)?{S}\\b']
  },
  {
    exts: ['java', 'kt', 'cs', 'scala'],
    patterns: [
      '\\b(?:class|interface|enum|record|object|fun)\\s+{S}\\b',
      // 方法定义：返回类型 + 名字 + (
      '\\b(?:public|private|protected|internal|static|final|override|abstract)[\\w<>,\\s\\[\\]]*\\s{S}\\s*\\('
    ]
  },
  {
    exts: ['vue', 'svelte'],
    patterns: ['\\b(?:function|class)\\s+{S}\\b', '\\b(?:const|let|var)\\s+{S}\\s*[=:(]']
  }
]

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 取某扩展名下、针对该符号的定义行正则组（不支持的扩展返回空数组） */
export function definitionRegexes(symbol: string, ext: string): RegExp[] {
  const sym = escapeRe(symbol)
  const def = DEF_TEMPLATES.find((d) => d.exts.includes(ext.toLowerCase()))
  if (!def) return []
  const out: RegExp[] = []
  for (const t of def.patterns) {
    try {
      out.push(new RegExp(t.replace(/\{S\}/g, sym)))
    } catch {
      /* 非法符号字符导致的正则错误：跳过该模板 */
    }
  }
  return out
}

/** 判断某行是否是该符号的定义行 */
export function isDefinitionLine(line: string, symbol: string, ext: string): boolean {
  return definitionRegexes(symbol, ext).some((re) => re.test(line))
}

let refCache: { symbol: string; re: RegExp } | null = null
/** 词边界引用匹配（区分大小写；符号通常大小写敏感） */
export function referenceRegex(symbol: string): RegExp {
  if (refCache?.symbol === symbol) return refCache.re
  // \b 对 $ 开头/结尾的标识符失效，用显式边界
  const re = new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(symbol)}(?![A-Za-z0-9_$])`)
  refCache = { symbol, re }
  return re
}

export interface SymbolHit {
  path: string
  line: number
  text: string
  /** 是否疑似定义行 */
  def: boolean
}

/**
 * 在单个文件的内容里收集符号出现处。
 * @returns 命中行（截断到 200 字符），定义行标记 def
 */
export function scanFile(path: string, content: string, symbol: string, max = 50): SymbolHit[] {
  const ext = path.split('.').pop() ?? ''
  const refRe = referenceRegex(symbol)
  const out: SymbolHit[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length && out.length < max; i++) {
    if (!refRe.test(lines[i])) continue
    out.push({
      path,
      line: i + 1,
      text: lines[i].trim().slice(0, 200),
      def: isDefinitionLine(lines[i], symbol, ext)
    })
  }
  return out
}

/** 校验符号名是否可检索（标识符形态，防把整段代码当符号传进来） */
export function isValidSymbol(symbol: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]{0,80}$/.test(symbol)
}
