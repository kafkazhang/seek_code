// 混合召回的纯逻辑模块（无 Electron / 网络依赖，便于单测）：
//  - 代码分块：按行切块供 embedding（块过小语义稀薄，过大稀释相似度）
//  - 余弦相似度：向量检索打分
//  - RRF（Reciprocal Rank Fusion）：把 BM25 与向量两路排名融合成一路
// RRF 只看名次不看分值，天然规避了 BM25 与余弦分数纲量不可比的问题。

export interface Chunk {
  /** 起始行（1 起） */
  startLine: number
  /** 结束行（含） */
  endLine: number
  text: string
}

export const CHUNK_LINES = 60 // 每块行数
export const CHUNK_OVERLAP = 10 // 相邻块重叠行数（避免语义边界被硬切）
export const MAX_CHUNKS_PER_FILE = 8

/** 把文件正文切成带行号的块；空白块跳过 */
export function chunkText(text: string, chunkLines = CHUNK_LINES, overlap = CHUNK_OVERLAP): Chunk[] {
  const lines = text.split('\n')
  const out: Chunk[] = []
  const step = Math.max(1, chunkLines - overlap)
  for (let i = 0; i < lines.length && out.length < MAX_CHUNKS_PER_FILE; i += step) {
    const slice = lines.slice(i, i + chunkLines)
    const body = slice.join('\n')
    if (body.trim().length < 20) continue // 几乎空白的块没有检索价值
    out.push({ startLine: i + 1, endLine: i + slice.length, text: body })
    if (i + chunkLines >= lines.length) break
  }
  return out
}

/** 余弦相似度；任一为零向量返回 0 */
export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface FusedHit {
  key: string
  score: number
  /** 来源：出现在哪几路排名里 */
  sources: ('bm25' | 'vector')[]
}

/**
 * RRF 融合：score(d) = Σ weight_i / (k + rank_i(d))，rank 从 1 起。
 * k 取经典值 60；weights 可对某一路加权（如向量路稍低，词法匹配在代码场景更稳）。
 */
export function rrfFuse(
  bm25Ranked: string[],
  vectorRanked: string[],
  opts: { k?: number; bm25Weight?: number; vectorWeight?: number } = {}
): FusedHit[] {
  const k = opts.k ?? 60
  const wb = opts.bm25Weight ?? 1
  const wv = opts.vectorWeight ?? 1
  const acc = new Map<string, FusedHit>()
  const add = (key: string, inc: number, source: 'bm25' | 'vector'): void => {
    const cur = acc.get(key)
    if (cur) {
      cur.score += inc
      if (!cur.sources.includes(source)) cur.sources.push(source)
    } else {
      acc.set(key, { key, score: inc, sources: [source] })
    }
  }
  bm25Ranked.forEach((key, i) => add(key, wb / (k + i + 1), 'bm25'))
  vectorRanked.forEach((key, i) => add(key, wv / (k + i + 1), 'vector'))
  return [...acc.values()].sort((a, b) => b.score - a.score)
}

/** 简单字符串哈希（FNV-1a 32 位）→ 用作分块内容指纹，内容不变即复用既有向量 */
export function contentHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}
