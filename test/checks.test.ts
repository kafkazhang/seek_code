import { describe, it, expect } from 'vitest'
import { detectChecks, clipCheckOutput } from '../src/main/checks'

const pkg = (scripts: Record<string, string>): string => JSON.stringify({ name: 'x', scripts })

describe('detectChecks', () => {
  it('按优先级探测 npm scripts：typecheck → lint → test', () => {
    const out = detectChecks(pkg({ test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' }), [])
    expect(out.map((c) => c.label)).toEqual(['typecheck', 'lint', 'test'])
    expect(out[0].command).toBe('npm run typecheck')
    expect(out[2].command).toBe('npm test')
  })

  it('watch / dev / serve 类脚本被跳过（会挂起）', () => {
    const out = detectChecks(
      pkg({ typecheck: 'tsc --noEmit --watch', test: 'vitest run', lint: 'vite dev' }),
      []
    )
    expect(out.map((c) => c.label)).toEqual(['test'])
  })

  it('无 package.json 时回退生态探测：Cargo / Go', () => {
    const out = detectChecks(null, ['Cargo.toml', 'go.mod', 'src'])
    expect(out.map((c) => c.label)).toEqual(['cargo check', 'go vet'])
  })

  it('损坏的 package.json 不抛错', () => {
    expect(detectChecks('{not json', ['go.mod'])).toEqual([{ label: 'go vet', command: 'go vet ./...' }])
  })

  it('什么都没有时返回空', () => {
    expect(detectChecks(null, ['README.md'])).toEqual([])
  })

  it('结果数量有上限', () => {
    const out = detectChecks(
      pkg({ typecheck: 'a', tsc: 'b', check: 'c', lint: 'd', test: 'e' }),
      ['Cargo.toml', 'go.mod']
    )
    expect(out.length).toBeLessThanOrEqual(4)
  })
})

describe('clipCheckOutput', () => {
  it('短输出原样返回', () => {
    expect(clipCheckOutput('  ok  ')).toBe('ok')
  })
  it('长输出保留头尾、标注省略', () => {
    const long = 'HEAD'.padEnd(3000, 'x') + 'TAIL'
    const out = clipCheckOutput(long, 100, 100)
    expect(out).toContain('HEAD')
    expect(out).toContain('TAIL')
    expect(out).toContain('省略')
    expect(out.length).toBeLessThan(400)
  })
})
