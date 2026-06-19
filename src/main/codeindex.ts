import { promises as fs, watch, FSWatcher, existsSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { scanFile, SymbolHit } from './symbols'
import { dataRoot } from './dataroot'

// 纯本地代码库索引：
//  - 符号大纲（AST-lite，正则提取 function/class/type 等）→ 注入"代码地图"
//  - BM25 词法倒排索引 → search_code 工具做检索式 RAG（无需 embedding）
// 对代码场景，标识符的词法匹配召回质量很高，且零额外依赖、可离线。
//
// 持久化与增量（本版新增）：
//  - 索引（不含整文件正文）落盘 userData/index/<hash>.json；重启后按 mtime 增量加载，
//    未变化的文件直接复用词频/符号，跳过最重的"读取 + 分词"。
//  - 写文件 / 文件监听到变化时，只增量更新对应单个文件条目，不再整库失效。
//  - 命中行所需的文件正文（lines）按需懒加载，避免把整个项目源码复制进 userData。

const IGNORE = new Set(['node_modules', '.git', 'out', 'dist', '.next', '.cache', 'build', 'target', '.turbo', 'coverage'])
const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp',
  'cc', 'cs', 'rb', 'php', 'swift', 'vue', 'svelte', 'scala', 'sh', 'sql', 'json', 'yaml', 'yml',
  'toml', 'md', 'css', 'scss', 'html'
])
const MAX_FILES = 4000
const MAX_FILE_BYTES = 250_000
const PERSIST_VERSION = 1

interface FileEntry {
  path: string
  tf: Map<string, number>
  len: number
  chars: number
  mtimeMs: number
  outline: string[]
  /** 文件正文按行切分；懒加载（从磁盘恢复的索引初始为 undefined） */
  lines?: string[]
}

export interface CodeIndex {
  root: string
  files: FileEntry[]
  df: Map<string, number>
  avgLen: number
  symbols: { path: string; outline: string[] }[]
  approxTokens: number
}

export interface SearchHit {
  path: string
  score: number
  lines: { n: number; text: string }[]
}

const cache = new Map<string, CodeIndex>()
const watchers = new Map<string, FSWatcher>()
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()

// ── 持久化 ───────────────────────────────────────────
export function indexDir(): string {
  return join(dataRoot(), 'index')
}
export function hashRoot(root: string): string {
  let h = 5381
  for (let i = 0; i < root.length; i++) h = ((h << 5) + h + root.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
function persistPath(root: string): string {
  return join(indexDir(), hashRoot(root) + '.json')
}

interface PersistedEntry {
  path: string
  tf: [string, number][]
  len: number
  chars: number
  mtimeMs: number
  outline: string[]
}
interface PersistedIndex {
  version: number
  root: string
  files: PersistedEntry[]
}

function persistSoon(root: string): void {
  const t = persistTimers.get(root)
  if (t) clearTimeout(t)
  persistTimers.set(
    root,
    setTimeout(() => {
      persistTimers.delete(root)
      void persistNow(root)
    }, 1500)
  )
}

async function persistNow(root: string): Promise<void> {
  const idx = cache.get(root)
  if (!idx) return
  try {
    await fs.mkdir(indexDir(), { recursive: true })
    const data: PersistedIndex = {
      version: PERSIST_VERSION,
      root,
      files: idx.files.map((f) => ({
        path: f.path,
        tf: [...f.tf.entries()],
        len: f.len,
        chars: f.chars,
        mtimeMs: f.mtimeMs,
        outline: f.outline
      }))
    }
    const p = persistPath(root)
    const tmp = `${p}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data), 'utf-8')
    await fs.rename(tmp, p)
  } catch {
    /* 落盘失败不影响功能 */
  }
}

async function loadPersisted(root: string): Promise<Map<string, PersistedEntry> | null> {
  try {
    const p = persistPath(root)
    if (!existsSync(p)) return null
    const data = JSON.parse(await fs.readFile(p, 'utf-8')) as PersistedIndex
    if (data.version !== PERSIST_VERSION || data.root !== root) return null
    return new Map(data.files.map((f) => [f.path, f]))
  } catch {
    return null
  }
}

export function invalidate(root: string): void {
  cache.delete(root)
}

// ── 文件变更钩子 ─────────────────────────────────────
// 供其它索引（如语义向量索引）订阅增量更新；用回调注册而非直接 import，避免循环依赖。
type FileChangeListener = (root: string, relPath: string, kind: 'update' | 'remove') => void
const changeListeners: FileChangeListener[] = []
export function onFileChange(l: FileChangeListener): void {
  changeListeners.push(l)
}
function notifyChange(root: string, relPath: string, kind: 'update' | 'remove'): void {
  for (const l of changeListeners) {
    try {
      l(root, relPath, kind)
    } catch {
      /* 监听者异常不影响索引本身 */
    }
  }
}

function tokenize(text: string): string[] {
  // 标识符 + 驼峰/下划线切分，便于匹配 getUserName ↔ user name
  const out: string[] = []
  const raw = text.toLowerCase().split(/[^a-z0-9_一-龥]+/)
  for (const w of raw) {
    if (w.length < 2 || w.length > 40) continue
    out.push(w)
    for (const part of w.split('_')) if (part.length >= 2) out.push(part)
  }
  // 驼峰切分（针对原文）
  for (const m of text.matchAll(/[A-Z]?[a-z]{2,}|[A-Z]{2,}/g)) {
    const w = m[0].toLowerCase()
    if (w.length >= 2) out.push(w)
  }
  return out
}

const SYMBOL_RE: { ext: string[]; re: RegExp }[] = [
  {
    ext: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
    re: /(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let)\s+([A-Za-z0-9_$]+)/g
  },
  { ext: ['py'], re: /^[ \t]*(class|def)\s+([A-Za-z0-9_]+)/gm },
  { ext: ['go'], re: /(func|type)\s+([A-Za-z0-9_]+)/g },
  { ext: ['rs'], re: /(fn|struct|enum|trait|impl)\s+([A-Za-z0-9_]+)/g },
  { ext: ['java', 'kt', 'cs', 'scala'], re: /(class|interface|enum|void|public|private)\s+([A-Za-z0-9_]+)/g }
]

function outlineOf(ext: string, text: string): string[] {
  const def = SYMBOL_RE.find((s) => s.ext.includes(ext))
  if (!def) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(def.re)) {
    const kind = m[1]
    const name = m[2]
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(`${kind} ${name}`)
    if (out.length >= 40) break
  }
  return out
}

/** 由文件正文构建一个完整条目（含 lines，供运行期直接使用） */
function makeEntry(rel: string, text: string, mtimeMs: number): FileEntry {
  const toks = tokenize(text)
  const tf = new Map<string, number>()
  for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
  const ext = extname(rel).slice(1).toLowerCase()
  return { path: rel, tf, len: toks.length, chars: text.length, mtimeMs, outline: outlineOf(ext, text), lines: text.split('\n') }
}

async function walk(dir: string, root: string, acc: string[]): Promise<void> {
  if (acc.length >= MAX_FILES) return
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as any
  } catch {
    return
  }
  for (const e of entries) {
    if (IGNORE.has(e.name) || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await walk(full, root, acc)
    else if (CODE_EXT.has(extname(e.name).slice(1).toLowerCase())) acc.push(full)
    if (acc.length >= MAX_FILES) return
  }
}

/** 由 files 重新派生 df / avgLen / symbols / approxTokens */
function rederive(idx: CodeIndex): void {
  const df = new Map<string, number>()
  let totalLen = 0
  let approxChars = 0
  const symbols: { path: string; outline: string[] }[] = []
  for (const f of idx.files) {
    for (const k of f.tf.keys()) df.set(k, (df.get(k) ?? 0) + 1)
    totalLen += f.len
    approxChars += f.chars
    if (f.outline.length) symbols.push({ path: f.path, outline: f.outline })
  }
  idx.df = df
  idx.avgLen = idx.files.length ? totalLen / idx.files.length : 0
  idx.symbols = symbols
  idx.approxTokens = Math.round(approxChars / 3.5)
}

export async function buildIndex(root: string): Promise<CodeIndex> {
  const cached = cache.get(root)
  if (cached) return cached

  const persisted = await loadPersisted(root)
  const absFiles: string[] = []
  await walk(root, root, absFiles)

  const files: FileEntry[] = []
  for (const abs of absFiles) {
    let stat: { size: number; mtimeMs: number }
    try {
      stat = await fs.stat(abs)
    } catch {
      continue
    }
    if (stat.size > MAX_FILE_BYTES) continue
    const rel = relative(root, abs).replace(/\\/g, '/')
    const prev = persisted?.get(rel)
    if (prev && prev.mtimeMs === stat.mtimeMs) {
      // 未变化：复用词频/符号，正文懒加载，省去最重的读取+分词
      files.push({
        path: rel,
        tf: new Map(prev.tf),
        len: prev.len,
        chars: prev.chars,
        mtimeMs: prev.mtimeMs,
        outline: prev.outline
      })
    } else {
      try {
        files.push(makeEntry(rel, await fs.readFile(abs, 'utf-8'), stat.mtimeMs))
      } catch {
        continue
      }
    }
  }

  const idx: CodeIndex = { root, files, df: new Map(), avgLen: 0, symbols: [], approxTokens: 0 }
  rederive(idx)
  cache.set(root, idx)
  persistSoon(root)
  return idx
}

/** 确保某条目的正文已加载（懒加载命中行用） */
async function ensureLines(root: string, f: FileEntry): Promise<void> {
  if (f.lines) return
  try {
    f.lines = (await fs.readFile(join(root, f.path), 'utf-8')).split('\n')
  } catch {
    f.lines = []
  }
}

// ── 增量更新（写文件 / 文件监听）────────────────────────
/** 单个文件新增或变更：只更新该条目，不重建全库 */
export async function updateFile(root: string, relPath: string): Promise<void> {
  const idx = cache.get(root)
  if (!idx) return
  const rel = relPath.replace(/\\/g, '/')
  const ext = extname(rel).slice(1).toLowerCase()
  if (!CODE_EXT.has(ext)) return
  const abs = join(root, rel)
  let stat: { size: number; mtimeMs: number }
  try {
    stat = await fs.stat(abs)
  } catch {
    // 文件已不存在 → 当作删除
    removeFile(root, rel)
    return
  }
  if (stat.size > MAX_FILE_BYTES) return
  let entry: FileEntry
  try {
    entry = makeEntry(rel, await fs.readFile(abs, 'utf-8'), stat.mtimeMs)
  } catch {
    return
  }
  const i = idx.files.findIndex((f) => f.path === rel)
  if (i >= 0) idx.files[i] = entry
  else idx.files.push(entry)
  rederive(idx)
  persistSoon(root)
  notifyChange(root, rel, 'update')
}

/** 删除单个文件条目 */
export function removeFile(root: string, relPath: string): void {
  const idx = cache.get(root)
  if (!idx) return
  const rel = relPath.replace(/\\/g, '/')
  const i = idx.files.findIndex((f) => f.path === rel)
  if (i < 0) return
  idx.files.splice(i, 1)
  rederive(idx)
  persistSoon(root)
  notifyChange(root, rel, 'remove')
}

// ── 文件监听 ─────────────────────────────────────────
/** 监听项目根，变化文件增量更新索引。recursive 在部分平台不支持时静默退化。 */
export function watchProject(root: string): void {
  if (watchers.has(root)) return
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    timer = null
    const batch = [...pending]
    pending.clear()
    for (const rel of batch) {
      if (existsSync(join(root, rel))) void updateFile(root, rel)
      else removeFile(root, rel)
    }
  }
  try {
    const w = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const rel = filename.toString().replace(/\\/g, '/')
      // 跳过被忽略目录与非代码文件
      if (rel.split('/').some((seg) => IGNORE.has(seg))) return
      if (!CODE_EXT.has(extname(rel).slice(1).toLowerCase())) return
      pending.add(rel)
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, 400)
    })
    w.on('error', () => {
      /* 忽略监听错误（写文件后的 updateFile 仍是兜底） */
    })
    watchers.set(root, w)
  } catch {
    /* recursive 不受支持等：放弃监听，依赖写文件后的增量兜底 */
  }
}

export function unwatchProject(root: string): void {
  const w = watchers.get(root)
  if (w) {
    try {
      w.close()
    } catch {
      /* ignore */
    }
    watchers.delete(root)
  }
}

// ── 符号导航（find_definition / find_references 用）────
/**
 * 在代码库中收集符号出现处：用倒排索引词法预过滤候选文件（免全库扫描），
 * 再逐文件按行精确判定（定义行识别见 symbols.ts）。
 */
export async function findSymbolHits(root: string, symbol: string, maxHits = 50): Promise<SymbolHit[]> {
  const idx = await buildIndex(root)
  const tok = symbol.toLowerCase().replace(/\$/g, '')
  if (tok.length < 2) return []
  const candidates = idx.files.filter((f) => f.tf.has(tok)).slice(0, 200)
  const hits: SymbolHit[] = []
  for (const f of candidates) {
    if (hits.length >= maxHits) break
    await ensureLines(root, f)
    hits.push(...scanFile(f.path, (f.lines ?? []).join('\n'), symbol, maxHits - hits.length))
  }
  return hits
}

/** BM25 检索，返回相关文件与命中行 */
export async function searchCode(root: string, query: string, k = 8): Promise<SearchHit[]> {
  const idx = await buildIndex(root)
  const qTerms = Array.from(new Set(tokenize(query))).filter((t) => idx.df.has(t))
  if (!qTerms.length || !idx.files.length) return []
  const N = idx.files.length
  const k1 = 1.5
  const b = 0.75
  const scored: { f: FileEntry; score: number }[] = []
  for (const f of idx.files) {
    let score = 0
    for (const t of qTerms) {
      const tf = f.tf.get(t)
      if (!tf) continue
      const idf = Math.log(1 + (N - (idx.df.get(t) ?? 0) + 0.5) / ((idx.df.get(t) ?? 0) + 0.5))
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * f.len) / (idx.avgLen || 1))))
    }
    if (score > 0) scored.push({ f, score })
  }
  scored.sort((a, b2) => b2.score - a.score)
  const top = scored.slice(0, k)
  const hits: SearchHit[] = []
  for (const { f, score } of top) {
    await ensureLines(root, f) // 仅对 top-k 命中文件读取正文
    const lines: { n: number; text: string }[] = []
    const ls = f.lines ?? []
    for (let i = 0; i < ls.length && lines.length < 4; i++) {
      const lower = ls[i].toLowerCase()
      if (qTerms.some((t) => lower.includes(t))) lines.push({ n: i + 1, text: ls[i].trim().slice(0, 160) })
    }
    hits.push({ path: f.path, score, lines })
  }
  return hits
}

/** 全局内容搜索（子串，大小写不敏感）→ 用于 Ctrl+Shift+F */
export async function grepContent(
  root: string,
  query: string,
  max = 80
): Promise<{ path: string; line: number; text: string }[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const idx = await buildIndex(root)
  const out: { path: string; line: number; text: string }[] = []
  for (const f of idx.files) {
    await ensureLines(root, f)
    const ls = f.lines ?? []
    for (let i = 0; i < ls.length; i++) {
      if (ls[i].toLowerCase().includes(q)) {
        out.push({ path: f.path, line: i + 1, text: ls[i].trim().slice(0, 200) })
        if (out.length >= max) return out
      }
    }
  }
  return out
}

/** 符号大纲（代码地图），注入提示词半稳定层 */
export async function symbolMap(root: string): Promise<{ map: string; stats: { files: number; symbols: number; approxTokens: number } }> {
  const idx = await buildIndex(root)
  const lines: string[] = []
  let symCount = 0
  for (const s of idx.symbols.slice(0, 200)) {
    symCount += s.outline.length
    lines.push(`${s.path}: ${s.outline.slice(0, 12).join(', ')}`)
  }
  const big = idx.approxTokens > 200_000
  const head = big
    ? `项目较大（约 ${Math.round(idx.approxTokens / 1000)}K tokens）。优先用 search_code 检索相关文件，不要逐个 read。\n`
    : `项目规模适中（约 ${Math.round(idx.approxTokens / 1000)}K tokens），可按需 read_file 直接阅读。\n`
  return {
    map: head + '符号大纲：\n' + lines.join('\n'),
    stats: { files: idx.files.length, symbols: symCount, approxTokens: idx.approxTokens }
  }
}
