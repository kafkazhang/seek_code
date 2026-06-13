import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildIndex, hashRoot, indexDir, onFileChange, searchCode, SearchHit } from './codeindex'
import { chunkText, contentHash, cosine, rrfFuse } from './hybrid'
import { embedBatch } from './gateway'
import { withRetry } from './retry'
import { getConfig } from './config'

// 语义向量索引（与 BM25 混合召回）：
//  - 文件按行分块 → 外部 OpenAI 兼容 /embeddings 批量向量化（独立 embedBaseURL + Key，
//    DeepSeek 无向量模型；默认用阿里 DashScope 的 text-embedding-v3）
//  - 向量按「内容哈希」落盘缓存 userData/index/<hash>.vec.json，重启/重建只 embed 变化块
//  - 检索时 query 向量化 → 余弦相似度按文件聚合 → 与 BM25 排名做 RRF 融合
//  - 关闭开关 / 未配置向量 Key / 接口不可用 / 索引未就绪时一律静默回退纯 BM25，不阻塞、不报错
//
// 成本边界：默认关闭（设置中开启）；全库分块上限 MAX_TOTAL_CHUNKS，单块送 embed 截断；
// 文件变更只增量重嵌变化块（哈希不变直接复用）。

const VEC_VERSION = 1
const MAX_TOTAL_CHUNKS = 1500 // 全库分块上限（控制构建成本与内存）
const EMBED_BATCH = 10 // 每次 /embeddings 请求的块数（DashScope text-embedding-v3 批量上限为 10）
const EMBED_CLIP = 6000 // 单块送 embed 的字符上限（防超模型 token 限制）

interface VecChunk {
  path: string
  startLine: number
  endLine: number
  hash: string
  vec: Float32Array
}

interface VecIndex {
  root: string
  model: string
  chunks: VecChunk[]
}

export type VecState = 'disabled' | 'nokey' | 'unavailable' | 'building' | 'ready' | 'off'

const vecCache = new Map<string, VecIndex>()
const building = new Map<string, Promise<void>>()
// embedding 接口不可用标记（按 embedBaseURL+model 记忆；换模型/接口后自动重试）
let unavailable: { key: string; reason: string } | null = null

function availKey(): string {
  const cfg = getConfig()
  return cfg.embedBaseURL + '|' + cfg.embedModel
}
function markUnavailable(e: unknown): void {
  unavailable = { key: availKey(), reason: (e as Error)?.message ?? String(e) }
}
function isUnavailable(): boolean {
  return unavailable?.key === availKey()
}
function enabled(): boolean {
  const cfg = getConfig()
  // 需开启开关 + 已配置向量服务（baseURL / 模型 / Key 三者齐全）
  return cfg.semanticIndex && !!cfg.embedModel && !!cfg.embedBaseURL && cfg.hasEmbedKey
}

// ── 持久化（向量用 base64 Float32，避免 JSON 数字数组体积爆炸）──
function vecPath(root: string): string {
  return join(indexDir(), hashRoot(root) + '.vec.json')
}
function encodeVec(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
}
function decodeVec(s: string): Float32Array {
  const b = Buffer.from(s, 'base64')
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

interface PersistedVec {
  version: number
  root: string
  model: string
  chunks: { path: string; startLine: number; endLine: number; hash: string; vec: string }[]
}

async function persistVec(root: string): Promise<void> {
  const idx = vecCache.get(root)
  if (!idx) return
  try {
    await fs.mkdir(indexDir(), { recursive: true })
    const data: PersistedVec = {
      version: VEC_VERSION,
      root,
      model: idx.model,
      chunks: idx.chunks.map((c) => ({
        path: c.path,
        startLine: c.startLine,
        endLine: c.endLine,
        hash: c.hash,
        vec: encodeVec(c.vec)
      }))
    }
    const p = vecPath(root)
    const tmp = `${p}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data), 'utf-8')
    await fs.rename(tmp, p)
  } catch {
    /* 落盘失败不影响功能 */
  }
}

/** 读取持久化向量 → Map<`path#hash`, Float32Array>（模型不一致则作废） */
async function loadPersistedVecs(root: string, model: string): Promise<Map<string, Float32Array> | null> {
  try {
    const p = vecPath(root)
    if (!existsSync(p)) return null
    const data = JSON.parse(await fs.readFile(p, 'utf-8')) as PersistedVec
    if (data.version !== VEC_VERSION || data.root !== root || data.model !== model) return null
    return new Map(data.chunks.map((c) => [c.path + '#' + c.hash, decodeVec(c.vec)]))
  } catch {
    return null
  }
}

// ── 构建 ─────────────────────────────────────────────
/** 后台构建（幂等：构建中复用同一 Promise）。失败标记不可用并静默回退。 */
export function ensureVecIndex(root: string): Promise<void> {
  if (!enabled() || isUnavailable()) return Promise.resolve()
  const cur = vecCache.get(root)
  if (cur && cur.model === getConfig().embedModel) return Promise.resolve()
  let p = building.get(root)
  if (p) return p
  p = build(root)
    .catch((e) => {
      markUnavailable(e)
    })
    .finally(() => {
      building.delete(root)
    })
  building.set(root, p)
  return p
}

async function build(root: string): Promise<void> {
  const model = getConfig().embedModel
  const persisted = await loadPersistedVecs(root, model)
  const idx = await buildIndex(root) // 复用 BM25 索引的文件清单（已过滤大文件/忽略目录）
  const chunks: VecChunk[] = []
  const pending: { meta: Omit<VecChunk, 'vec'>; text: string }[] = []

  for (const f of idx.files) {
    if (chunks.length + pending.length >= MAX_TOTAL_CHUNKS) break
    let text: string
    try {
      text = await fs.readFile(join(root, f.path), 'utf-8')
    } catch {
      continue
    }
    for (const ch of chunkText(text)) {
      const hash = contentHash(ch.text)
      const prev = persisted?.get(f.path + '#' + hash)
      const meta = { path: f.path, startLine: ch.startLine, endLine: ch.endLine, hash }
      if (prev) chunks.push({ ...meta, vec: prev })
      else pending.push({ meta, text: ch.text })
      if (chunks.length + pending.length >= MAX_TOTAL_CHUNKS) break
    }
  }

  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const batch = pending.slice(i, i + EMBED_BATCH)
    const vecs = await withRetry(() => embedBatch(batch.map((b) => b.text.slice(0, EMBED_CLIP))))
    batch.forEach((b, j) => chunks.push({ ...b.meta, vec: Float32Array.from(vecs[j]) }))
  }

  vecCache.set(root, { root, model, chunks })
  void persistVec(root)
}

// ── 增量更新（订阅 codeindex 的文件变更钩子）────────────
const pendingChanges = new Map<string, Map<string, 'update' | 'remove'>>()
const changeTimers = new Map<string, ReturnType<typeof setTimeout>>()

onFileChange((root, rel, kind) => {
  if (!enabled() || isUnavailable() || !vecCache.has(root)) return
  let m = pendingChanges.get(root)
  if (!m) {
    m = new Map()
    pendingChanges.set(root, m)
  }
  m.set(rel, kind)
  const t = changeTimers.get(root)
  if (t) clearTimeout(t)
  changeTimers.set(
    root,
    setTimeout(() => {
      changeTimers.delete(root)
      void flushChanges(root)
    }, 3000)
  )
})

async function flushChanges(root: string): Promise<void> {
  const idx = vecCache.get(root)
  const batch = pendingChanges.get(root)
  pendingChanges.delete(root)
  if (!idx || !batch?.size) return
  for (const [rel, kind] of batch) {
    // 旧块按哈希留作复用池，内容未变的块免重新 embed
    const reuse = new Map<string, Float32Array>()
    idx.chunks = idx.chunks.filter((c) => {
      if (c.path !== rel) return true
      reuse.set(c.hash, c.vec)
      return false
    })
    if (kind === 'remove') continue
    let text: string
    try {
      text = await fs.readFile(join(root, rel), 'utf-8')
    } catch {
      continue
    }
    const fresh: { meta: Omit<VecChunk, 'vec'>; text: string }[] = []
    for (const ch of chunkText(text)) {
      const hash = contentHash(ch.text)
      const meta = { path: rel, startLine: ch.startLine, endLine: ch.endLine, hash }
      const prev = reuse.get(hash)
      if (prev) idx.chunks.push({ ...meta, vec: prev })
      else fresh.push({ meta, text: ch.text })
    }
    if (fresh.length && idx.chunks.length + fresh.length <= MAX_TOTAL_CHUNKS + 200) {
      try {
        const vecs = await embedBatch(fresh.map((f) => f.text.slice(0, EMBED_CLIP)))
        fresh.forEach((f, j) => idx.chunks.push({ ...f.meta, vec: Float32Array.from(vecs[j]) }))
      } catch (e) {
        markUnavailable(e)
        return
      }
    }
  }
  void persistVec(root)
}

// ── 检索 ─────────────────────────────────────────────
interface VecHit {
  path: string
  score: number
  startLine: number
  endLine: number
}

/** 向量召回（按文件聚合取最佳块）；索引未就绪时触发后台构建并返回 null（本次回退 BM25） */
async function vectorRank(root: string, query: string, k: number): Promise<VecHit[] | null> {
  if (!enabled() || isUnavailable()) return null
  const idx = vecCache.get(root)
  if (!idx || idx.model !== getConfig().embedModel) {
    void ensureVecIndex(root)
    return null
  }
  if (!idx.chunks.length) return null
  let qv: Float32Array
  try {
    qv = Float32Array.from((await embedBatch([query.slice(0, EMBED_CLIP)]))[0])
  } catch (e) {
    markUnavailable(e)
    return null
  }
  const best = new Map<string, VecHit>()
  for (const c of idx.chunks) {
    const s = cosine(qv, c.vec)
    const cur = best.get(c.path)
    if (!cur || s > cur.score) best.set(c.path, { path: c.path, score: s, startLine: c.startLine, endLine: c.endLine })
  }
  return [...best.values()]
    .filter((h) => h.score > 0.15) // 过低相似度只是噪声
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}

export interface HybridResult {
  hits: SearchHit[]
  mode: 'hybrid' | 'bm25'
}

/**
 * 混合检索：BM25 与向量两路各自排名 → RRF 融合。
 * 向量路不可用/为空时退化为纯 BM25（与旧行为一致）。
 */
export async function hybridSearch(root: string, query: string, k = 8): Promise<HybridResult> {
  const [bm25, vec] = await Promise.all([searchCode(root, query, k * 2), vectorRank(root, query, k * 2)])
  if (!vec || !vec.length) return { hits: bm25.slice(0, k), mode: 'bm25' }

  // 代码场景词法匹配更稳，向量路权重略低
  const fused = rrfFuse(
    bm25.map((h) => h.path),
    vec.map((v) => v.path),
    { vectorWeight: 0.8 }
  ).slice(0, k)

  const bm25ByPath = new Map(bm25.map((h) => [h.path, h]))
  const vecByPath = new Map(vec.map((v) => [v.path, v]))
  const hits: SearchHit[] = []
  for (const f of fused) {
    const lex = bm25ByPath.get(f.key)
    if (lex) {
      hits.push({ ...lex, score: f.score * 1000 })
      continue
    }
    // 纯向量命中：给出语义最佳块的前几行作为预览
    const v = vecByPath.get(f.key)!
    hits.push({ path: f.key, score: f.score * 1000, lines: await previewChunk(root, v) })
  }
  return { hits, mode: 'hybrid' }
}

async function previewChunk(root: string, v: VecHit): Promise<{ n: number; text: string }[]> {
  try {
    const lines = (await fs.readFile(join(root, v.path), 'utf-8')).split('\n')
    const out: { n: number; text: string }[] = []
    for (let i = v.startLine - 1; i < Math.min(v.endLine, lines.length) && out.length < 3; i++) {
      const t = lines[i].trim()
      if (t) out.push({ n: i + 1, text: t.slice(0, 160) })
    }
    return out
  } catch {
    return [{ n: v.startLine, text: `（语义相关块 第 ${v.startLine}-${v.endLine} 行）` }]
  }
}

/** 索引状态（设置页展示用） */
export function vecStatus(root: string | null): { state: VecState; chunks: number; model: string; reason?: string } {
  const cfg = getConfig()
  if (!cfg.semanticIndex || !cfg.embedModel || !cfg.embedBaseURL) return { state: 'disabled', chunks: 0, model: cfg.embedModel }
  if (!cfg.hasEmbedKey) return { state: 'nokey', chunks: 0, model: cfg.embedModel }
  if (isUnavailable()) return { state: 'unavailable', chunks: 0, model: cfg.embedModel, reason: unavailable!.reason }
  if (!root) return { state: 'off', chunks: 0, model: cfg.embedModel }
  if (building.has(root)) return { state: 'building', chunks: vecCache.get(root)?.chunks.length ?? 0, model: cfg.embedModel }
  const idx = vecCache.get(root)
  if (idx && idx.model === cfg.embedModel) return { state: 'ready', chunks: idx.chunks.length, model: cfg.embedModel }
  return { state: 'off', chunks: 0, model: cfg.embedModel }
}
