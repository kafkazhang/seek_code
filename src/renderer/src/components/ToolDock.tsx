import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import { useStore, type Attachment } from '../store'
import { FileNode, ReasoningMode, TerminalEvent } from '@shared/types'
import FileTree from './FileTree'
import MarkdownView from './MarkdownView'
import RichInput from './RichInput'
import { CodeEditor } from './CodeEditor'
import DragHandle from './DragHandle'
import { ansiToSpans } from '../ansi'

marked.setOptions({ breaks: true, gfm: true })

function uid(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  }
}
const base = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p

const TREE_W_KEY = 'seek.explorer.treeW'

export default function ToolDock(): JSX.Element {
  const root = useStore((st) => st.active()?.projectRoot ?? null)
  const dockTab = useStore((st) => st.dockTab)
  const setDock = useStore((st) => st.setDock)
  // 文件树/编辑器 「代码」视图合并为左右布局；文件、预览均归入该视图
  const isExplorer = dockTab === 'files' || dockTab === 'preview'
  const TABS = [
    { key: 'files', label: '文件', active: isExplorer },
    { key: 'terminal', label: '终端', active: dockTab === 'terminal' },
    { key: 'tasks', label: '任务', active: dockTab === 'tasks' }
  ] as const

  return (
    <aside className="dock">
      <div className="dock-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={'dtab' + (t.active ? ' on' : '')}
            onClick={() => setDock(true, t.key)}
          >
            {t.label}
          </button>
        ))}
        <div className="spacer" />
        <button className="dock-x" onClick={() => setDock(false)} title="关闭面板">
          ✕
        </button>
      </div>
      <div className="dock-body">
        {root ? (
          <>
            <div className="dock-pane" style={{ display: isExplorer ? 'flex' : 'none' }}>
              <ExplorerPane root={root} />
            </div>
            {/* 终端常驻挂载（仅隐藏），切换标签不丢失会话 */}
            <div className="dock-pane" style={{ display: dockTab === 'terminal' ? 'flex' : 'none' }}>
              <TerminalTabs root={root} />
            </div>
          </>
        ) : dockTab !== 'tasks' ? (
          <div className="dock-empty">当前会话未绑定项目目录</div>
        ) : null}
        <div className="dock-pane" style={{ display: dockTab === 'tasks' ? 'flex' : 'none' }}>
          <TasksPanel />
        </div>
      </div>
    </aside>
  )
}

// 左：文件树；右：编辑器。中间分隔条可拖动调节文件树宽度。
function ExplorerPane({ root }: { root: string }): JSX.Element {
  const [treeW, setTreeW] = useState<number>(() => {
    const v = parseInt(localStorage.getItem(TREE_W_KEY) || '', 10)
    return Number.isFinite(v) && v >= 140 ? v : 240
  })
  const startW = useRef(treeW)
  return (
    <div className="explorer">
      <div className="explorer-tree" style={{ width: treeW }}>
        <FilesPanel root={root} />
      </div>
      <DragHandle
        className="inflow"
        onStart={() => (startW.current = treeW)}
        onResize={(dx) => {
          const w = Math.max(140, Math.min(560, startW.current + dx))
          setTreeW(w)
          localStorage.setItem(TREE_W_KEY, String(w))
        }}
      />
      <div className="explorer-edit">
        <PreviewPanel />
      </div>
    </div>
  )
}

function FilesPanel({ root }: { root: string }): JSX.Element {
  const openPreview = useStore((s) => s.openPreview)
  const treeVersion = useStore((s) => s.treeVersion)
  const [nodes, setNodes] = useState<FileNode[]>([])
  const [loading, setLoading] = useState(false)
  const load = (refresh = false): void => {
    setLoading(true)
    void window.seek.getTree(root, refresh).then((n) => {
      setNodes(n)
      setLoading(false)
    })
  }
  useEffect(() => {
    load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])
  useEffect(() => {
    if (treeVersion > 0) load(true) // Agent 改动文件后自动刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeVersion])

  return (
    <div className="files-panel">
      <div className="panel-bar">
        <span className="pb-path">{base(root)}/</span>
        <button className="pb-btn" onClick={() => load(true)} title="刷新文件列表">
          ⟳
        </button>
      </div>
      <div className="tree scroll">
        {loading ? (
          <div className="dock-empty">加载中…</div>
        ) : nodes.length ? (
          <FileTree nodes={nodes} onOpen={openPreview} />
        ) : (
          <div className="dock-empty">空目录</div>
        )}
      </div>
    </div>
  )
}

function PreviewPanel(): JSX.Element {
  const root = useStore((s) => s.active()?.projectRoot ?? null)
  const previews = useStore((s) => s.previews)
  const activePreviewPath = useStore((s) => s.activePreviewPath)
  const setActivePreview = useStore((s) => s.setActivePreview)
  const closePreview = useStore((s) => s.closePreview)
  const preview = previews.find((p) => p.path === activePreviewPath) ?? null
  const [mode, setMode] = useState<'view' | 'source'>('view')
  // 各文件未保存草稿：key=path。Monaco 受控 value 用已保存内容，草稿仅用于脏标记与保存。
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setMode('view')
  }, [preview?.path])

  if (!preview) return <div className="dock-empty">点击「文件」中的文件查看内容</div>

  const ext = preview.path.split('.').pop()?.toLowerCase() ?? ''
  const isMd = ext === 'md' || ext === 'markdown'
  const isHtml = ext === 'html' || ext === 'htm'
  const rich = isMd || isHtml
  const saved = preview.content ?? ''
  const path = preview.path
  const draft = drafts[path]
  const dirtyOf = (p: string): boolean => {
    const d = drafts[p]
    const sv = previews.find((x) => x.path === p)?.content ?? ''
    return d !== undefined && d !== sv
  }
  const dirty = dirtyOf(path)
  // 富文本（md/html）默认渲染预览；非富文本始终用编辑器（可改可保存）
  const showEditor = preview.kind === 'text' && (!rich || mode === 'source')

  function onEdit(v: string): void {
    setDrafts((d) => ({ ...d, [path]: v }))
  }
  async function save(): Promise<void> {
    if (!root || draft === undefined || saving) return
    setSaving(true)
    const ok = await window.seek.saveFile(root, path, draft)
    setSaving(false)
    if (ok) {
      useStore.setState((st) => ({
        previews: st.previews.map((p) => (p.path === path ? { ...p, content: draft } : p))
      }))
      setDrafts((d) => {
        const next = { ...d }
        delete next[path]
        return next
      })
    }
  }

  return (
    <div className="preview-panel">
      <div className="file-tabbar">
        {previews.map((p) => (
          <div
            key={p.path}
            className={'file-tab' + (p.path === activePreviewPath ? ' on' : '')}
            onClick={() => {
              if (p.path === activePreviewPath) return
              setActivePreview(p.path)
            }}
            title={p.path}
          >
            {dirtyOf(p.path) && <span className="ft-dot" title="未保存" />}
            <span className="ft-name">{base(p.path)}</span>
            <button
              className="ft-x"
              onClick={(e) => {
                e.stopPropagation()
                if (dirtyOf(p.path) && !window.confirm('有未保存的修改，确定关闭并放弃？')) return
                setDrafts((d) => {
                  const next = { ...d }
                  delete next[p.path]
                  return next
                })
                closePreview(p.path)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="panel-bar">
        <span className="pb-path">{preview.path}</span>
        {showEditor && <span className="pb-tip">Tab 接受 AI 补全 · Ctrl+S 保存</span>}
        {dirty && (
          <button className="pb-btn-t on" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        )}
        {rich && (
          <button className="pb-btn-t" onClick={() => setMode(mode === 'view' ? 'source' : 'view')}>
            {mode === 'view' ? '源码' : '预览'}
          </button>
        )}
        {isHtml && root && (
          <button className="pb-btn-t" onClick={() => void window.seek.openExternal(root, preview.path)}>
            浏览器打开
          </button>
        )}
      </div>
      <div className="preview-body">
        {preview.kind === 'image' ? (
          <div className="img-wrap scroll">
            <img src={preview.dataUrl} alt={preview.path} />
          </div>
        ) : isMd && mode === 'view' ? (
          <MarkdownView source={saved} className="md-body scroll" />
        ) : isHtml && mode === 'view' ? (
          <iframe className="html-frame" sandbox="allow-scripts" srcDoc={saved} title="预览" />
        ) : (
          <CodeEditor path={path} value={draft ?? saved} onChange={onEdit} onSave={() => void save()} />
        )}
      </div>
    </div>
  )
}

function statusText(s: string): string {
  return s === 'queued'
    ? '排队中'
    : s === 'running'
      ? '运行中'
      : s === 'done'
        ? '已完成'
        : s === 'error'
          ? '出错'
          : '已取消'
}

const TASK_DEPTH: Record<ReasoningMode, string> = { fast: 'FAST', balanced: 'BALANCED', deep: 'DEEP' }

function TasksPanel(): JSX.Element {
  const tasks = useStore((s) => s.tasks)
  const startBgTask = useStore((s) => s.startBgTask)
  const command = useStore((s) => s.command)
  const cur = useStore((s) => s.active())
  const hasProject = !!cur?.projectRoot
  const root = cur?.projectRoot ?? null
  // 任务自带推理档位（与对话区相互独立：后台任务一次性运行，需单独定深浅）
  const [depth, setDepth] = useState<ReasoningMode>('balanced')

  async function submitTask(text: string, atts: Attachment[]): Promise<void> {
    const t = text.trim()
    if (!t && atts.length === 0) return
    // 纯 /命令 走会话命令；档位类命令优先作用于本面板推理档位
    if (t.startsWith('/')) {
      const cmd = t.slice(1).trim().split(/\s+/)[0]?.toLowerCase()
      if (cmd === 'fast' || cmd === 'balanced' || cmd === 'deep') {
        setDepth(cmd as ReasoningMode)
        return
      }
      await command(t)
      return
    }
    await startBgTask(t, atts, depth)
  }

  return (
    <div className="tasks-panel">
      <div className="task-list scroll">
        {tasks.length === 0 ? (
          <div className="dock-empty">
            暂无后台任务。
            <br />
            用下方输入或 <code>/bg &lt;任务&gt;</code> 委派。
          </div>
        ) : (
          tasks.map((t) => (
            <div key={t.id} className={'task-card ' + t.status}>
              <div className="tc-h">
                <span className={'tc-dot ' + t.status} />
                <span className="tc-goal">{t.goal}</span>
                {(t.status === 'running' || t.status === 'queued') && (
                  <button className="tc-cancel" onClick={() => void window.seek.cancelTask(t.id)}>
                    取消
                  </button>
                )}
              </div>
              <div className="tc-meta">
                {t.projectName || ''} · {statusText(t.status)} · {t.toolCount} 次工具
              </div>
              <div className="tc-action">{t.lastAction}</div>
              {t.result && <div className="tc-result">{t.result.slice(-280)}</div>}
            </div>
          ))
        )}
      </div>
      {/* 与对话 Composer 一致：任务列表在上、输入区固定在面板底部 */}
      <div className="composer task-composer">
        <div className="seg-row">
          <span className={'proj-chip mini' + (hasProject ? '' : ' need')} title="后台任务运行于当前会话的项目目录">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 7l2-3h6l2 3h6v12H3z" />
            </svg>
            {cur?.projectName ?? '需先选项目'}
          </span>
          <span className="task-auto" title="后台任务自主运行，写入与命令自动放行">
            <span className="dot" />全自动
          </span>
          <div className="spacer" />
          <div className={'mini-seg' + (depth === 'deep' ? ' deep' : '')}>
            {(['fast', 'balanced', 'deep'] as ReasoningMode[]).map((m) => (
              <button key={m} className={depth === m ? 'on' : ''} onClick={() => setDepth(m)}>
                {TASK_DEPTH[m]}
              </button>
            ))}
          </div>
        </div>
        <RichInput
          root={root}
          sendLabel="委派"
          sendTitle="委派后台任务 · 回车"
          placeholder={
            hasProject
              ? '委派一个后台任务并行执行 · / 命令 · @ 文件 · 可粘贴/拖入图片…'
              : '先为会话选择项目目录'
          }
          onSubmit={(t, a) => void submitTask(t, a)}
        />
      </div>
    </div>
  )
}

interface Seg {
  kind: 'cmd' | 'out' | 'err' | 'sys'
  text: string
}

function TerminalTabs({ root }: { root: string }): JSX.Element {
  const [tabs, setTabs] = useState<number[]>([1])
  const [active, setActive] = useState(1)
  const nextId = useRef(2)
  function add(): void {
    const id = nextId.current++
    setTabs((t) => [...t, id])
    setActive(id)
  }
  function close(id: number): void {
    setTabs((t) => {
      if (t.length <= 1) return t
      const nt = t.filter((x) => x !== id)
      if (active === id) setActive(nt[nt.length - 1])
      return nt
    })
  }
  return (
    <div className="term-tabs">
      <div className="term-tabbar">
        {tabs.map((id, i) => (
          <div key={id} className={'tt-tab' + (active === id ? ' on' : '')} onClick={() => setActive(id)}>
            <span>终端 {i + 1}</span>
            {tabs.length > 1 && (
              <button
                className="ft-x"
                onClick={(e) => {
                  e.stopPropagation()
                  close(id)
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button className="tt-add" onClick={add} title="新建终端">
          ＋
        </button>
      </div>
      <div className="term-stack">
        {tabs.map((id) => (
          <div key={id} className="term-slot" style={{ display: active === id ? 'flex' : 'none' }}>
            <TerminalPanel root={root} />
          </div>
        ))}
      </div>
    </div>
  )
}

const TERM_HISTORY_KEY = 'seek.term.history'

function TerminalPanel({ root }: { root: string }): JSX.Element {
  const welcome: Seg = {
    kind: 'sys',
    text: 'SeekCode 终端 · 命令执行 + 交互输入(stdin) + 彩色输出。支持 cd / clear / set|export 环境变量 / ↑↓ 历史 / Ctrl+C 中断。\n'
  }
  const [cwd, setCwd] = useState(root)
  const [segs, setSegs] = useState<Seg[]>([welcome])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [envCount, setEnvCount] = useState(0)
  const envRef = useRef<Record<string, string>>({})
  const execRef = useRef<string | null>(null)
  const startRef = useRef<number>(0)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const history = useRef<string[]>([])
  const histIdx = useRef<number>(-1)

  useEffect(() => {
    setCwd(root)
  }, [root])

  useEffect(() => {
    try {
      history.current = JSON.parse(localStorage.getItem(TERM_HISTORY_KEY) || '[]')
    } catch {
      /* ignore */
    }
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const off = window.seek.onTerminal((e: TerminalEvent) => {
      if (e.execId !== execRef.current) return
      if (e.type === 'data') {
        setSegs((s) => [...s, { kind: e.stream === 'err' ? 'err' : 'out', text: e.chunk }])
      } else {
        const dur = startRef.current ? ((Date.now() - startRef.current) / 1000).toFixed(1) : '?'
        execRef.current = null
        setRunning(false)
        const tag = e.code && e.code !== 0 ? `退出码 ${e.code}` : '完成'
        setSegs((s) => [...s, { kind: 'sys', text: `\n[${tag} · 耗时 ${dur}s]\n` }])
        inputRef.current?.focus()
      }
    })
    return off
  }, [])

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight })
  }, [segs])

  function pushHistory(cmd: string): void {
    history.current = [...history.current.filter((h) => h !== cmd), cmd].slice(-200)
    histIdx.current = -1
    try {
      localStorage.setItem(TERM_HISTORY_KEY, JSON.stringify(history.current))
    } catch {
      /* ignore */
    }
  }

  async function run(): Promise<void> {
    const cmd = input.trim()
    if (!cmd) return
    setInput('')
    pushHistory(cmd)
    setSegs((s) => [...s, { kind: 'cmd', text: `\n${base(cwd)} $ ${cmd}\n` }])
    if (cmd === 'clear' || cmd === 'cls') {
      setSegs([])
      return
    }
    if (cmd === 'cd' || cmd.startsWith('cd ')) {
      const arg = cmd === 'cd' ? '' : cmd.slice(3).trim()
      const r = await window.seek.termCd(cwd, arg || '.')
      if (r.ok) setCwd(r.cwd)
      else setSegs((s) => [...s, { kind: 'err', text: `${r.error || 'cd 失败'}\n` }])
      return
    }
    // 环境变量内建：set NAME=VALUE / export NAME=VALUE / NAME=VALUE（本会话内持久）
    const setM = cmd.match(/^(?:set|export)\s+([A-Za-z_]\w*)=(.*)$/) || cmd.match(/^([A-Za-z_]\w*)=(.+)$/)
    if (setM) {
      envRef.current = { ...envRef.current, [setM[1]]: setM[2].replace(/^["']|["']$/g, '') }
      setEnvCount(Object.keys(envRef.current).length)
      setSegs((s) => [...s, { kind: 'sys', text: `已设置环境变量 ${setM[1]}（本终端会话内有效）\n` }])
      return
    }
    const id = uid()
    execRef.current = id
    startRef.current = Date.now()
    setRunning(true)
    await window.seek.termExec(id, cwd, cmd, envRef.current)
  }

  function sendStdin(): void {
    const line = input
    setInput('')
    setSegs((s) => [...s, { kind: 'cmd', text: line + '\n' }])
    if (execRef.current) void window.seek.termInput(execRef.current, line + '\n')
  }

  function stop(): void {
    if (execRef.current) {
      void window.seek.termKill(execRef.current)
      execRef.current = null
      setRunning(false)
      setSegs((s) => [...s, { kind: 'sys', text: '\n^C [已中断]\n' }])
    }
  }

  function onKey(e: { key: string; ctrlKey?: boolean; preventDefault: () => void }): void {
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
      if (running) {
        e.preventDefault()
        stop()
      }
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (running) sendStdin()
      else void run()
      return
    }
    if (running) return // 运行中：输入发往程序，不走历史导航
    const h = history.current
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!h.length) return
      histIdx.current = histIdx.current < 0 ? h.length - 1 : Math.max(0, histIdx.current - 1)
      setInput(h[histIdx.current] ?? '')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (histIdx.current < 0) return
      histIdx.current += 1
      if (histIdx.current >= h.length) {
        histIdx.current = -1
        setInput('')
      } else setInput(h[histIdx.current])
    }
  }

  return (
    <div className="term-panel">
      <div className="panel-bar">
        <span className="pb-path" title={cwd}>
          {cwd}
        </span>
        {envCount > 0 && (
          <span className="term-envtag" title={Object.keys(envRef.current).join(', ')}>
            {envCount} env
          </span>
        )}
        <button
          className="pb-btn"
          onClick={() => {
            envRef.current = {}
            setEnvCount(0)
            setSegs([welcome])
          }}
          title="清空输出与会话环境变量"
        >
          清空
        </button>
      </div>
      <div className="term-body scroll" ref={bodyRef} onClick={() => inputRef.current?.focus()}>
        <pre>
          {segs.map((s, i) =>
            s.kind === 'out' || s.kind === 'err' ? (
              ansiToSpans(s.text).map((sp, j) => (
                <span key={i + '-' + j} className={(s.kind === 'err' ? 'aerr' : 'aout') + (sp.cls ? ' ' + sp.cls : '')}>
                  {sp.text}
                </span>
              ))
            ) : (
              <span key={i} className={'seg ' + s.kind}>
                {s.text}
              </span>
            )
          )}
          {running && <span className="term-cursor">▍</span>}
        </pre>
      </div>
      <div className="term-input">
        <span className={'tp-prompt' + (running ? ' stdin' : '')}>{running ? 'stdin »' : base(cwd) + ' $'}</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={running ? '回车发送到运行中的程序 · Ctrl+C 中断' : '输入命令，回车执行（↑↓ 历史）'}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        {running ? (
          <button className="tp-btn stop" onClick={stop} title="Ctrl+C 中断">
            停止
          </button>
        ) : (
          <button className="tp-btn" onClick={() => void run()} title="执行">
            ▶
          </button>
        )}
      </div>
    </div>
  )
}
