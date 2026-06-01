import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { FileNode } from '@shared/types'

function flatten(nodes: FileNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === 'file') out.push(n.path)
    else if (n.children) flatten(n.children, out)
  }
  return out
}
function fuzzy(q: string, s: string): boolean {
  if (!q) return true
  const ql = q.toLowerCase()
  const sl = s.toLowerCase()
  let i = 0
  for (const ch of sl) {
    if (ch === ql[i]) i++
    if (i >= ql.length) return true
  }
  return false
}

export default function Palette(): JSX.Element | null {
  const mode = useStore((s) => s.palette)
  const setPalette = useStore((s) => s.setPalette)
  const openPreview = useStore((s) => s.openPreview)
  const root = useStore((s) => s.active()?.projectRoot ?? null)
  const [q, setQ] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [results, setResults] = useState<{ path: string; line: number; text: string }[]>([])
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mode) {
      setQ('')
      setActive(0)
      setResults([])
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [mode])
  useEffect(() => {
    if (mode === 'files' && root) void window.seek.getTree(root).then((t) => setFiles(flatten(t)))
  }, [mode, root])
  useEffect(() => {
    if (mode !== 'search' || !root) return
    const h = setTimeout(() => {
      void window.seek.searchFiles(root, q).then((r) => {
        setResults(r)
        setActive(0)
      })
    }, 180)
    return () => clearTimeout(h)
  }, [q, mode, root])

  if (!mode) return null

  const fileMatches = mode === 'files' ? files.filter((f) => fuzzy(q, f)).slice(0, 200) : []
  const count = mode === 'files' ? fileMatches.length : results.length

  function choose(i: number): void {
    if (mode === 'files') {
      const p = fileMatches[i]
      if (p) {
        void openPreview(p)
        setPalette(null)
      }
    } else {
      const r = results[i]
      if (r) {
        void openPreview(r.path)
        setPalette(null)
      }
    }
  }
  function onKey(e: {
    key: string
    preventDefault: () => void
  }): void {
    if (e.key === 'Escape') setPalette(null)
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, count - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(active)
    }
  }

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && setPalette(null)}
    >
      <div className="palette">
        <div className="pal-head">
          <span className="pal-icon">{mode === 'files' ? '⌕' : '⚡'}</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder={mode === 'files' ? '快速打开文件…' : '搜索项目内容…'}
          />
          <span className="pal-hint">{mode === 'files' ? 'Ctrl+P' : 'Ctrl+Shift+F'}</span>
        </div>
        <div className="pal-list">
          {mode === 'files'
            ? fileMatches.map((p, i) => (
                <div
                  key={p}
                  className={'pal-item' + (i === active ? ' on' : '')}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(i)}
                >
                  <span className="pal-name">{p.split('/').pop()}</span>
                  <span className="pal-path">{p}</span>
                </div>
              ))
            : results.map((r, i) => (
                <div
                  key={i}
                  className={'pal-item' + (i === active ? ' on' : '')}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(i)}
                >
                  <span className="pal-loc">
                    {r.path}:{r.line}
                  </span>
                  <span className="pal-snippet">{r.text}</span>
                </div>
              ))}
          {count === 0 && (
            <div className="pal-empty">{q ? '无结果' : mode === 'files' ? '输入以筛选文件' : '输入以搜索内容'}</div>
          )}
        </div>
      </div>
    </div>
  )
}
