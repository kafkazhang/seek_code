import { describe, it, expect } from 'vitest'
import { chunkText, cosine, rrfFuse, contentHash, CHUNK_LINES, MAX_CHUNKS_PER_FILE } from '../src/main/hybrid'

describe('chunkText', () => {
  it('短文件切成单块，行号正确', () => {
    const text = Array.from({ length: 10 }, (_, i) => `const line${i} = ${i}`).join('\n')
    const chunks = chunkText(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].startLine).toBe(1)
    expect(chunks[0].endLine).toBe(10)
  })

  it('长文件按行数分块且相邻块重叠', () => {
    const text = Array.from({ length: 200 }, (_, i) => `function f${i}() { return ${i} }`).join('\n')
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
    // 第二块起点 = 第一块起点 + (块大小 - 重叠)
    expect(chunks[1].startLine).toBe(chunks[0].startLine + (CHUNK_LINES - 10))
    // 重叠：上一块的结尾行号 >= 下一块的起始行号
    expect(chunks[0].endLine).toBeGreaterThanOrEqual(chunks[1].startLine)
  })

  it('单文件分块数有上限', () => {
    const text = Array.from({ length: 5000 }, (_, i) => `const x${i} = ${i}`).join('\n')
    expect(chunkText(text).length).toBeLessThanOrEqual(MAX_CHUNKS_PER_FILE)
  })

  it('几乎空白的块被跳过', () => {
    expect(chunkText('\n\n  \n\n')).toHaveLength(0)
  })
})

describe('cosine', () => {
  it('同向量相似度为 1', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
  })
  it('正交向量相似度为 0', () => {
    expect(cosine([1, 0], [0, 1])).toBe(0)
  })
  it('反向向量相似度为 -1', () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1)
  })
  it('零向量返回 0（不产生 NaN）', () => {
    expect(cosine([0, 0], [1, 2])).toBe(0)
  })
  it('支持 Float32Array', () => {
    expect(cosine(Float32Array.from([1, 1]), Float32Array.from([1, 1]))).toBeCloseTo(1)
  })
})

describe('rrfFuse', () => {
  it('两路都靠前的文档融合后排第一', () => {
    const fused = rrfFuse(['a', 'b', 'c'], ['a', 'c', 'b'])
    expect(fused[0].key).toBe('a')
    expect(fused[0].sources.sort()).toEqual(['bm25', 'vector'])
  })

  it('仅单路命中的文档也会出现在结果里', () => {
    const fused = rrfFuse(['a'], ['z'])
    const keys = fused.map((f) => f.key)
    expect(keys).toContain('a')
    expect(keys).toContain('z')
  })

  it('双路命中分数高于同名次的单路命中', () => {
    const fused = rrfFuse(['a', 'b'], ['a'])
    const a = fused.find((f) => f.key === 'a')!
    const b = fused.find((f) => f.key === 'b')!
    expect(a.score).toBeGreaterThan(b.score)
  })

  it('权重生效：向量路权重为 0 时退化为 BM25 排序', () => {
    const fused = rrfFuse(['a', 'b'], ['b', 'a'], { vectorWeight: 0 })
    expect(fused[0].key).toBe('a')
  })

  it('空输入返回空数组', () => {
    expect(rrfFuse([], [])).toEqual([])
  })
})

describe('contentHash', () => {
  it('相同内容哈希一致，不同内容哈希不同', () => {
    expect(contentHash('hello world')).toBe(contentHash('hello world'))
    expect(contentHash('hello world')).not.toBe(contentHash('hello world!'))
  })
  it('空串也有稳定哈希', () => {
    expect(contentHash('')).toBe(contentHash(''))
  })
})
