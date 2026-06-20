import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useStore } from './store'
import { ChatMessage, EditPreview, ReasoningMode, StoredTool } from '@shared/types'
import { lineDiff, diffStat } from './diff'
import MarkdownView from './components/MarkdownView'
import Settings from './components/Settings'
import ToolDock from './components/ToolDock'
import RichInput from './components/RichInput'
import Palette from './components/Palette'
import { CodeDiff } from './components/CodeEditor'
import DragHandle from './components/DragHandle'
import { MODES, modeLabel, nextMode } from './modes'

const MODE_LABEL: Record<ReasoningMode, string> = { fast: 'FAST', balanced: 'BALANCED', deep: 'DEEP' }

// 品牌标识：优先使用工程内的 logo（src/renderer/public/brand.png，建议透明背景、仅图标），
// 若文件缺失则回退到内置标识（默认声呐脉冲动画，可由 fallback 覆盖），保证界面在任何情况下都不破损。
function BrandMark({
  className = 'brand-logo',
  fallback
}: {
  className?: string
  fallback?: JSX.Element
}): JSX.Element {
  const [ok, setOk] = useState(true)
  if (ok) {
    return (
      <img className={className} src="./brand.png" alt="SeekCode" draggable={false} onError={() => setOk(false)} />
    )
  }
  return (
    fallback ?? (
      <div className="sonar-mark">
        <div className="core" />
        <div className="ring" />
        <div className="ring" />
      </div>
    )
  )
}

// 粒子流主题：Canvas 星座网络——粒子漂移、临近自动连线、跟随光标高亮，按窗口面积自适应密度。
// 仅在该主题挂载；页面隐藏时暂停 rAF，devicePixelRatio 上限 2，additive(lighter) 合成产生发光感。
function ParticleCanvas(): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '124, 196, 255'
    const LINK = 132
    const MOUSE_LINK = 188
    let w = 0
    let h = 0
    let pts: { x: number; y: number; vx: number; vy: number; r: number }[] = []
    const mouse = { x: -9999, y: -9999 }
    let raf = 0

    const build = (): void => {
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const n = Math.min(130, Math.max(54, Math.round((w * h) / 13000)))
      pts = Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() * 2 - 1) * 0.45,
        vy: (Math.random() * 2 - 1) * 0.45,
        r: 1 + Math.random() * 1.8
      }))
    }

    const draw = (): void => {
      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'lighter'
      for (const p of pts) {
        p.x += p.vx
        p.y += p.vy
        if (p.x < 0 || p.x > w) p.vx *= -1
        if (p.y < 0 || p.y > h) p.vy *= -1
      }
      ctx.lineWidth = 0.7
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const d2 = dx * dx + dy * dy
          if (d2 < LINK * LINK) {
            const al = (1 - Math.sqrt(d2) / LINK) * 0.5
            ctx.strokeStyle = `rgba(${accent}, ${al.toFixed(3)})`
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
        const mdx = a.x - mouse.x
        const mdy = a.y - mouse.y
        const md2 = mdx * mdx + mdy * mdy
        if (md2 < MOUSE_LINK * MOUSE_LINK) {
          const al = (1 - Math.sqrt(md2) / MOUSE_LINK) * 0.85
          ctx.strokeStyle = `rgba(${accent}, ${al.toFixed(3)})`
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(mouse.x, mouse.y)
          ctx.stroke()
        }
      }
      for (const p of pts) {
        ctx.fillStyle = `rgba(${accent}, 0.1)`
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r * 3, 0, 6.283)
        ctx.fill()
        ctx.fillStyle = `rgba(${accent}, 0.95)`
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, 6.283)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
      raf = requestAnimationFrame(draw)
    }

    const onMove = (e: MouseEvent): void => {
      mouse.x = e.clientX
      mouse.y = e.clientY
    }
    const onLeave = (): void => {
      mouse.x = -9999
      mouse.y = -9999
    }
    const onResize = (): void => build()
    const onVis = (): void => {
      cancelAnimationFrame(raf)
      if (!document.hidden) raf = requestAnimationFrame(draw)
    }

    build()
    raf = requestAnimationFrame(draw)
    window.addEventListener('resize', onResize)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseout', onLeave)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseout', onLeave)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])
  return <canvas ref={ref} className="fx fx-canvas" aria-hidden="true" />
}

// 主题氛围层：粒子流 → Canvas 星座网络；樱花/薰衣草/蜜桃 → 飘落花瓣（颜色随主题 --petal）；
// 水墨 → 缓缓游移的墨晕。全部纯 CSS/Canvas、无图片资源，仅对应主题挂载。
const PETAL_THEMES = new Set<string>(['sakura', 'lavender', 'peach'])

function ThemeFx(): JSX.Element | null {
  const theme = useStore((s) => s.config?.theme)
  const petals = useMemo(
    () =>
      Array.from({ length: 22 }, () => ({
        left: Math.random() * 100,
        size: 9 + Math.random() * 14,
        dur: 8 + Math.random() * 9,
        delay: -Math.random() * 16,
        drift: Math.round((Math.random() * 2 - 1) * 140),
        rot: Math.round(Math.random() * 360)
      })),
    []
  )
  const inks = useMemo(
    () =>
      Array.from({ length: 6 }, () => ({
        left: Math.random() * 100,
        top: Math.random() * 100,
        size: Math.round(180 + Math.random() * 220),
        dur: 18 + Math.random() * 16,
        delay: -Math.random() * 20,
        dx: Math.round((Math.random() * 2 - 1) * 60),
        dy: Math.round((Math.random() * 2 - 1) * 40)
      })),
    []
  )

  if (theme === 'particle') return <ParticleCanvas />
  if (theme === 'ink') {
    return (
      <div className="fx fx-ink" aria-hidden="true">
        {inks.map((b, i) => (
          <i
            key={i}
            style={
              {
                left: `${b.left}%`,
                top: `${b.top}%`,
                width: b.size,
                height: b.size,
                animationDuration: `${b.dur}s`,
                animationDelay: `${b.delay}s`,
                '--dx': `${b.dx}px`,
                '--dy': `${b.dy}px`
              } as CSSProperties
            }
          />
        ))}
      </div>
    )
  }
  if (theme && PETAL_THEMES.has(theme)) {
    return (
      <div className="fx fx-petals" aria-hidden="true">
        {petals.map((p, i) => (
          <i
            key={i}
            style={
              {
                left: `${p.left}%`,
                width: p.size,
                height: p.size,
                animationDuration: `${p.dur}s`,
                animationDelay: `${p.delay}s`,
                '--drift': `${p.drift}px`,
                '--rot': `${p.rot}deg`
              } as CSSProperties
            }
          />
        ))}
      </div>
    )
  }
  return null
}

function renderText(text: string): JSX.Element[] {
  return text.split(/(`[^`]+`)/g).map((p, i) =>
    p.startsWith('`') && p.endsWith('`') && p.length > 1 ? (
      <code key={i}>{p.slice(1, -1)}</code>
    ) : (
      <span key={i}>{p}</span>
    )
  )
}

const lsNum = (k: string, d: number): number => {
  const v = parseInt(localStorage.getItem(k) || '', 10)
  return Number.isFinite(v) ? v : d
}
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

export default function App(): JSX.Element {
  const s = useStore()
  const cur = s.active()

  // 三栏（侧栏 | 中央 | 工具面板）宽度，可拖拽并持久化
  const [sideW, setSideW] = useState(() => lsNum('seek.ws.sideW', 266))
  const [dockW, setDockW] = useState(() => lsNum('seek.ws.dockW', 360))
  const startSide = useRef(sideW)
  const startDock = useRef(dockW)

  // 窗口变窄时收敛 dock 宽度，保证对话栏不被挤没
  useEffect(() => {
    const fit = (): void =>
      setDockW((w) => Math.min(w, Math.max(360, window.innerWidth - sideW - 280)))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [sideW])

  useEffect(() => {
    s.init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 全局快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (e.shiftKey && mod && (e.key === 'M' || e.key === 'm')) {
        e.preventDefault()
        const st = useStore.getState()
        const cur = st.active()
        if (!cur) return
        const mode = cur.permissionMode ?? st.config?.permissionMode ?? 'ask'
        st.setMode(nextMode(mode)) // 循环当前会话权限模式
      } else if (mod && !e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        useStore.getState().setPalette('files') // 快速打开
      } else if (mod && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        useStore.getState().setPalette('search') // 全局搜索
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <div className="bg bg-glow" />
      <div className="bg bg-grid" />
      <ThemeFx />

      <div className="app">
        {/* title bar */}
        <header className="titlebar">
          <button className="new-session tb-new" onClick={() => s.newSession()}>
            <span className="plus">+</span> 新建会话
          </button>

          <div className="spacer" />

          <div className="privacy" title="纯本地运行 · 代码不出本机 · 仅 LLM 推理走网络">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            纯本地
          </div>

          <div
            className={'model-sel' + (s.config?.hasKey ? '' : ' off')}
            onClick={() => s.setSettingsOpen(true)}
            title="点击配置 API Key 与模型"
          >
            <span className="m-icon" />
            <b>DeepSeek-V4</b>
            <span className="v">{s.reasoning === 'fast' ? s.config?.flashModel : s.config?.proModel}</span>
            <span className={'key' + (s.config?.hasKey ? '' : ' no')}>{s.config?.hasKey ? '· key ✓' : '· 未配置'}</span>
          </div>
        </header>

        <div
          className="workspace"
          data-dock={s.dockOpen ? 'true' : 'false'}
          style={{ '--side-w': `${sideW}px`, '--dock-w': `${dockW}px` } as CSSProperties}
        >
          <Sidebar />
          <main className="center">
            <ConvHeader />
            <Chat />
            <TodoBar />
            <Composer />
          </main>
          {s.dockOpen && <ToolDock />}
          <DragHandle
            className="ws-h ws-h-left"
            onStart={() => (startSide.current = sideW)}
            onResize={(dx) => {
              const w = clamp(startSide.current + dx, 190, 520)
              setSideW(w)
              localStorage.setItem('seek.ws.sideW', String(w))
            }}
          />
          {s.dockOpen && (
            <DragHandle
              className="ws-h ws-h-right"
              onStart={() => (startDock.current = dockW)}
              onResize={(dx) => {
                // 上限随窗口动态：文件栏可一直拉宽，仅给对话栏保留最小可用宽度
                const max = Math.max(360, window.innerWidth - sideW - 280)
                const w = clamp(startDock.current - dx, 300, max)
                setDockW(w)
                localStorage.setItem('seek.ws.dockW', String(w))
              }}
            />
          )}
        </div>

        {/* status bar */}
        <footer className="statusbar">
          <div className="st-item">
            <span className="d" />
            纯本地 · <span className="cy">仅推理联网</span>
          </div>
          <div className="st-item">{cur?.projectName ? `项目 ${cur.projectName}` : '未绑定项目'}</div>
          <div className="st-item">
            缓存 <span className="cy">{cur && cur.totals.hitRate ? Math.round(cur.totals.hitRate * 100) + '%' : '—'}</span>
          </div>
          <div className="st-item">
            本会话 <span className="sv">¥{(cur?.totals.cost ?? 0).toFixed(4)}</span> · 省{' '}
            <span className="sv">¥{(cur?.totals.saved ?? 0).toFixed(4)}</span>
          </div>
          <div className="st-item grow" />
          <BalanceItem />
          <div className="st-item">{s.status || '就绪'}</div>
          <div className="st-item">DeepSeek-V4 · {s.config?.hasKey ? <span className="cy">key ✓</span> : '未配置'}</div>
        </footer>
      </div>

      {s.settingsOpen && <Settings />}
      <Palette />
    </>
  )
}

// ── 状态栏：账户余额（DeepSeek /user/balance）────────────
function BalanceItem(): JSX.Element | null {
  const balance = useStore((st) => st.balance)
  const hasKey = useStore((st) => st.config?.hasKey ?? false)
  const loadBalance = useStore((st) => st.loadBalance)
  if (!hasKey) return null

  // 货币符号映射，未知币种回退为币种码
  const symbol = (cur?: string): string => (cur === 'CNY' ? '¥' : cur === 'USD' ? '$' : (cur ? cur + ' ' : '¥'))
  let inner: JSX.Element
  if (!balance) {
    inner = <span className="balance-load">查询中…</span>
  } else if (balance.ok && balance.totalBalance != null) {
    inner = (
      <span className={balance.isAvailable === false ? 'sv low' : 'sv'}>
        {symbol(balance.currency)}
        {balance.totalBalance}
      </span>
    )
  } else {
    inner = <span className="balance-err">查询失败</span>
  }

  return (
    <div className="st-item balance" title="DeepSeek 账户余额 · 点击刷新" onClick={() => void loadBalance()}>
      余额 {inner}
    </div>
  )
}

// ── Sidebar: 会话列表 ─────────────────────────────────
function Sidebar(): JSX.Element {
  const { sessions, activeId, selectSession, deleteSession, running, setSettingsOpen, update, installUpdate } =
    useStore()
  const updateLine =
    update?.state === 'available'
      ? '发现新版本，下载中…'
      : update?.state === 'downloading'
        ? `下载更新 ${update.percent ?? 0}%`
        : update?.state === 'downloaded'
          ? `新版本 v${update.version ?? ''} 待安装`
          : null
  return (
    <aside className="sidebar">
      <div className="side-label">最近会话</div>
      <div className="sess-list scroll">
        {sessions.length === 0 && <div className="empty-side">暂无会话</div>}
        {sessions.map((sess) => (
          <div
            key={sess.id}
            className={'sess' + (sess.id === activeId ? ' on' : '')}
            onClick={() => selectSession(sess.id)}
          >
            <span className={'dot' + (running[sess.id] ? ' run' : '')} />
            <div className="sess-main">
              <div className="sess-title">{sess.title}</div>
              <div className="sess-sub">{sess.projectName ?? '未选择项目'}</div>
            </div>
            <button
              className="sess-del"
              title="删除会话"
              onClick={(e) => {
                e.stopPropagation()
                deleteSession(sess.id)
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="side-foot" onClick={() => setSettingsOpen(true)} title="设置">
        <div className="av">
          <BrandMark className="av-logo" fallback={<span>求</span>} />
        </div>
        <div className="sf-main">
          <div className="sf-name">
            SeekCode <small className="sf-ver">v{__APP_VERSION__}</small>
          </div>
          {updateLine && <div className="sf-sub upd">{updateLine}</div>}
        </div>
        {update?.state === 'downloaded' ? (
          <button
            className="sf-update"
            title={`重启并安装 v${update.version ?? ''}`}
            onClick={(e) => {
              e.stopPropagation()
              void installUpdate()
            }}
          >
            ↑ 更新
          </button>
        ) : (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
          </svg>
        )}
      </div>
    </aside>
  )
}

// ── 会话头部：标题 + 项目（只读，状态指示） ──────────────
function ConvHeader(): JSX.Element | null {
  const cur = useStore((st) => st.active())
  const dockOpen = useStore((st) => st.dockOpen)
  const dockTab = useStore((st) => st.dockTab)
  const setDock = useStore((st) => st.setDock)
  if (!cur) return null
  const toggle = (tab: 'files' | 'terminal' | 'tasks' | 'git'): void =>
    dockOpen && dockTab === tab ? setDock(false) : setDock(true, tab)
  const activeTool = (tab: string): boolean => dockOpen && dockTab === tab
  return (
    <div className="conv-h">
      <div className="conv-title">{cur.messages.length ? cur.title : '新会话'}</div>
      {cur.projectName && (
        <>
          <div className="conv-tools">
            <button className={'ctool' + (activeTool('files') || activeTool('preview') ? ' on' : '')} onClick={() => toggle('files')} title="文件列表 / 预览">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M3 7l2-3h6l2 3h6v12H3z" />
              </svg>
              文件
            </button>
            <button className={'ctool' + (activeTool('git') ? ' on' : '')} onClick={() => toggle('git')} title="Git 面板 / 变更评审">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <circle cx="6" cy="6" r="2.4" />
                <circle cx="6" cy="18" r="2.4" />
                <circle cx="18" cy="8" r="2.4" />
                <path d="M6 8.4v7.2M18 10.4c0 3-3 4-6 4" />
              </svg>
              Git
            </button>
            <button className={'ctool' + (activeTool('terminal') ? ' on' : '')} onClick={() => toggle('terminal')} title="终端">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M4 5h16v14H4z" />
                <path d="M7 9l3 3-3 3M13 15h4" />
              </svg>
              终端
            </button>
            <button className={'ctool' + (activeTool('tasks') ? ' on' : '')} onClick={() => toggle('tasks')} title="后台任务 / 委派">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M9 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
                <rect x="9" y="3" width="6" height="4" rx="1" />
                <path d="M9 12h6M9 16h4" />
              </svg>
              任务
            </button>
          </div>
          <div className={'conv-proj' + (cur.started ? ' locked' : '')}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M3 7l2-3h6l2 3h6v12H3z" />
            </svg>
            {cur.projectName}
            {cur.started && (
              <svg className="lk" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="5" y="11" width="14" height="9" rx="2" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Chat ─────────────────────────────────────────────
function Chat(): JSX.Element {
  const { approvals, approve } = useStore()
  const cur = useStore((st) => st.active())
  const ref = useRef<HTMLDivElement>(null)
  const msgs = cur?.messages ?? []
  const myApprovals = approvals.filter((a) => a.sessionId === cur?.id)

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' })
  }, [msgs, myApprovals.length])

  if (msgs.length === 0) {
    return (
      <div className="chat" ref={ref}>
        <div className="welcome">
          <div className="big-mark">求</div>
          <h1>
            在代码的海洋里 <span>深度求索</span>
          </h1>
          <p>纯本地 AI 结对程序员，由 DeepSeek-V4 驱动。</p>
          <p>
            {cur?.projectName
              ? `已绑定项目「${cur.projectName}」，直接提问吧。`
              : '可直接提问（解答 / 查资料 / 列清单）；需要我读写代码时，在下方绑定项目目录即可。'}
          </p>
          <div className="hints">
            <div className="hint">“梳理这个项目的整体结构”</div>
            <div className="hint">“给 src/utils 加一个防抖函数并写注释”</div>
            <div className="hint">“找出所有 TODO 并列个清单”</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="chat" ref={ref}>
      {msgs.map((m) => (
        <Message key={m.id} m={m} />
      ))}
      {myApprovals.map((a) => (
        <div className="approval" key={a.approvalId}>
          <div className="at">
            Agent 请求执行：<b>{a.summary}</b>
          </div>
          {a.preview && <DiffView preview={a.preview} />}
          <div className="acts">
            <button className="ok" onClick={() => approve(a.approvalId, true)}>
              {a.preview ? '接受改动' : '批准'}
            </button>
            <button className="no" onClick={() => approve(a.approvalId, false)}>
              拒绝
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function DiffView({ preview }: { preview: EditPreview }): JSX.Element {
  const lines = useMemo(() => lineDiff(preview.oldText, preview.newText), [preview])
  const stat = diffStat(lines)
  // 行内 diff 高度自适应并钳制，避免聊天里多个 Monaco 实例占满视口
  const rows = Math.max(preview.oldText.split('\n').length, preview.newText.split('\n').length)
  const height = Math.min(460, Math.max(90, rows * 20 + 24))
  return (
    <div className="diff">
      <div className="diff-h">
        <span className="dp">
          {preview.isNew && <span className="dnew">新建</span>}
          {preview.path}
        </span>
        <span className="dstat">
          <span className="da">+{stat.add}</span>
          <span className="dd">−{stat.del}</span>
        </span>
      </div>
      <div className="diff-mono" style={{ height }}>
        <CodeDiff path={preview.path} original={preview.oldText} modified={preview.newText} />
      </div>
    </div>
  )
}

// ── 单个工具调用：状态指示 + 默认折叠、可展开的详情 ──────────
function ToolCall({ t }: { t: StoredTool }): JSX.Element {
  const openPreview = useStore((s) => s.openPreview)
  const [open, setOpen] = useState(false)
  const path = toolPath(t.args)
  const canOpen =
    !!path && (t.name === 'read_file' || t.name === 'write_file' || t.name === 'edit_file' || t.name === 'multi_edit')
  const showDiff = !!t.preview && t.preview.oldText !== t.preview.newText
  const result = (t.result ?? '').trim()
  const running = t.status === 'running'
  const hasDetail = !!result || showDiff || canOpen
  const statusText = running
    ? '执行中…'
    : t.status === 'done'
      ? '完成'
      : t.status === 'denied'
        ? '已拒绝'
        : '失败'
  return (
    <div className={'tool-call ' + t.status + (open ? ' open' : '')}>
      <div
        className={'tc-head' + (hasDetail ? ' expandable' : '')}
        title={hasDetail ? (open ? '收起详情' : '展开详情') : ''}
        onClick={() => hasDetail && setOpen((o) => !o)}
      >
        <span className="tc-ind" aria-hidden>
          {running ? (
            <span className="tc-spin" />
          ) : t.status === 'done' ? (
            '✓'
          ) : t.status === 'denied' ? (
            '⊘'
          ) : (
            '✗'
          )}
        </span>
        <span className="tl">{t.name}</span>
        <span className="arg">{shortArgs(t.args)}</span>
        <span className="res">{statusText}</span>
        {hasDetail && <span className="tc-caret">{open ? '▾' : '▸'}</span>}
      </div>
      {/* 子代理进度卡：编排期间实时展示，无需展开 */}
      {t.subs && t.subs.length > 0 && (
        <div className="sub-list">
          {t.subs.map((su) => (
            <div key={su.id} className={'sub-card ' + su.status}>
              <span className="sub-ind" aria-hidden>
                {su.status === 'running' ? <span className="tc-spin" /> : su.status === 'done' ? '✓' : su.status === 'error' ? '✗' : '…'}
              </span>
              <div className="sub-main">
                <div className="sub-goal" title={su.goal}>
                  {su.goal}
                </div>
                <div className="sub-meta">
                  {su.status === 'queued' ? '排队中' : su.status === 'running' ? '运行中' : su.status === 'done' ? '已完成' : '失败'} ·{' '}
                  {su.toolCount} 次工具 · {su.lastAction}
                </div>
                {su.result && su.status === 'done' && <div className="sub-result">{su.result}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      {open && hasDetail && (
        <div className="tc-body">
          {showDiff && <DiffView preview={t.preview!} />}
          {result && <pre className="tc-result">{result}</pre>}
          {canOpen && (
            <button
              className="tc-open"
              onClick={(e) => {
                e.stopPropagation()
                void openPreview(path!)
              }}
            >
              在预览中打开 {path}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Message({ m }: { m: ChatMessage }): JSX.Element {
  const retryMessage = useStore((s) => s.retryMessage)
  const editMessage = useStore((s) => s.editMessage)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  if (m.note) {
    return <div className="sys-note">{renderText(m.content)}</div>
  }
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="ic">你</div>
        <div className="body">
          <div className="who">
            <b>你</b>
            {!editing && (
              <button
                className="msg-copy"
                onClick={() => {
                  setDraft(m.content)
                  setEditing(true)
                }}
              >
                编辑
              </button>
            )}
          </div>
          {editing ? (
            <div className="msg-edit">
              <textarea value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} />
              <div className="me-acts">
                <button
                  className="me-save"
                  onClick={() => {
                    setEditing(false)
                    void editMessage(m.id, draft)
                  }}
                >
                  保存并重发
                </button>
                <button className="me-cancel" onClick={() => setEditing(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="text">{renderText(m.content)}</div>
              {m.images && m.images.length > 0 && (
                <div className="msg-imgs">
                  {m.images.map((src, i) => (
                    <img key={i} src={src} alt="附件" />
                  ))}
                </div>
              )}
              {m.files && m.files.length > 0 && (
                <div className="msg-files">
                  {m.files.map((f, i) => (
                    <span className="msg-file" key={i}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                        <path d="M14 2H6v20h12V8z" />
                        <path d="M14 2v6h6" />
                      </svg>
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    )
  }
  const tag = (m.mode ?? 'balanced') as ReasoningMode
  return (
    <div className="msg assistant">
      <div className="ic">SC</div>
      <div className="body">
        <div className="who">
          <b>SeekCode</b>
          <span className={'reason-tag ' + tag}>{MODE_LABEL[tag]}</span>
          {m.content && !m.streaming && (
            <>
              <button className="msg-copy" title="复制回复" onClick={() => void navigator.clipboard.writeText(m.content)}>
                复制
              </button>
              <button className="msg-copy" title="重新生成" onClick={() => void retryMessage(m.id)}>
                重试
              </button>
            </>
          )}
        </div>
        {m.timeline && m.timeline.length > 0 ? (
          // 新版：推理 / 文本 / 工具按真实发生顺序交错渲染（边思考边行动）
          m.timeline.map((part, i) => {
            if (part.type === 'reasoning')
              return part.text ? (
                <div key={i} className="reasoning-block">
                  {part.text}
                </div>
              ) : null
            if (part.type === 'tool') {
              const tool = m.tools.find((t) => t.callId === part.callId)
              return tool ? <ToolCall key={part.callId} t={tool} /> : null
            }
            if (!part.text) return null
            return m.streaming ? (
              <div key={i} className="text">
                {renderText(part.text)}
              </div>
            ) : (
              <MarkdownView key={i} source={part.text} className="chat-md md-body" />
            )
          })
        ) : (
          // 回退：旧消息无时间线时按 推理 → 工具 → 文本 分段渲染
          <>
            {m.reasoning && <div className="reasoning-block">{m.reasoning}</div>}
            {m.tools.map((t) => (
              <ToolCall key={t.callId} t={t} />
            ))}
            {m.content &&
              (m.streaming ? (
                <div className="text">{renderText(m.content)}</div>
              ) : (
                <MarkdownView source={m.content} className="chat-md md-body" />
              ))}
          </>
        )}
        {m.error && (
          <div className="err-card">
            <div className="ec-title">⚠ {friendlyError(m.error)}</div>
            <div className="ec-detail">{m.error}</div>
            <div className="ec-acts">
              {isKeyError(m.error) && (
                <button className="ec-btn primary" onClick={() => setSettingsOpen(true)}>
                  打开设置
                </button>
              )}
              <button className="ec-btn" onClick={() => void retryMessage(m.id)}>
                重试
              </button>
            </div>
          </div>
        )}
        {m.streaming && !m.content && m.tools.length === 0 && !(m.timeline && m.timeline.length > 0) && (
          <div className="typing">
            <i />
            <i />
            <i />
          </div>
        )}
      </div>
    </div>
  )
}

function shortArgs(args: string): string {
  try {
    const o = JSON.parse(args)
    if (Array.isArray(o.tasks)) return `${o.tasks.length} 个并行子任务`
    if (o.path) return o.path
    if (o.command) return o.command
    if (o.pattern) return `/${o.pattern}/`
    if (o.query) return `“${o.query}”`
    return JSON.stringify(o).slice(0, 60)
  } catch {
    return args.slice(0, 60)
  }
}

function isKeyError(msg: string): boolean {
  return /api\s*key|apikey|401|unauthorized|authentication|未配置/i.test(msg)
}
function friendlyError(msg: string): string {
  const m = msg.toLowerCase()
  if (isKeyError(msg)) return 'API Key 无效或未配置，请在设置中检查'
  if (/enotfound|econnrefused|fetch failed|network|timeout|etimedout|getaddrinfo|socket/.test(m))
    return '网络连接失败，请检查网络或接口地址（baseURL）'
  if (/429|rate limit|too many/.test(m)) return '请求过于频繁（限流），请稍后重试'
  if (/insufficient|balance|quota|余额|欠费/.test(m)) return '账户额度不足或已欠费'
  return '请求出错，可重试或检查设置'
}

function toolPath(args: string): string | null {
  try {
    const o = JSON.parse(args)
    return typeof o.path === 'string' ? o.path : null
  } catch {
    return null
  }
}

// ── 任务清单卡（todo_write 工具维护，Composer 上方常驻）──
function TodoBar(): JSX.Element | null {
  const cur = useStore((st) => st.active())
  const todos = useStore((st) => (cur ? st.todos[cur.id] : undefined))
  const clearTodos = useStore((st) => st.clearTodos)
  const [open, setOpen] = useState(true)
  if (!cur || !todos || todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length
  const active = todos.find((t) => t.status === 'in_progress')
  return (
    <div className={'todo-bar' + (open ? ' open' : '')}>
      <div className="todo-head" onClick={() => setOpen((o) => !o)}>
        <span className="todo-prog">
          {done}/{todos.length}
        </span>
        <span className="todo-title">
          {done === todos.length ? '任务清单 · 全部完成 ✓' : (active?.content ?? '任务清单')}
        </span>
        <span className="todo-caret">{open ? '▾' : '▴'}</span>
        <button
          className="todo-x"
          title="隐藏清单"
          onClick={(e) => {
            e.stopPropagation()
            clearTodos(cur.id)
          }}
        >
          ✕
        </button>
      </div>
      {open && (
        <div className="todo-list">
          {todos.map((t, i) => (
            <div key={i} className={'todo-item ' + t.status}>
              <span className="ti-mark">
                {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? <span className="tc-spin" /> : '○'}
              </span>
              <span className="ti-text">{t.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Composer：项目选择（开始后锁定）+ 推理档位 + 输入 ──────
function ModeMenu(): JSX.Element {
  const cur = useStore((st) => st.active())
  const config = useStore((st) => st.config)
  const permissionMode = cur?.permissionMode ?? config?.permissionMode ?? 'ask'
  const setMode = useStore((st) => st.setMode)
  const [open, setOpen] = useState(false)
  return (
    <div className="mode-menu">
      <button
        className={'mode-chip mode-' + permissionMode}
        onClick={() => setOpen((o) => !o)}
        title="权限模式 · Shift+Ctrl+M 切换"
      >
        <span className="dot" />
        {modeLabel(permissionMode)}
        <span className="mc-caret">{open ? '▾' : '▴'}</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="mode-pop">
            <div className="mp-h">权限模式</div>
            {MODES.map((m) => (
              <button
                key={m.id}
                className={'mp-item' + (permissionMode === m.id ? ' on' : '')}
                onClick={() => {
                  setMode(m.id)
                  setOpen(false)
                }}
              >
                <span className="mp-text">
                  <b>{m.label}</b>
                  <span className="mp-desc">{m.desc}</span>
                </span>
                <span className="mp-right">
                  {permissionMode === m.id && <span className="mp-check">✓</span>}
                  <span className="mp-key">{m.key}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function Composer(): JSX.Element {
  const { send, abort, running, reasoning, setReasoning, pickProject } = useStore()
  const cur = useStore((st) => st.active())
  const busy = !!(cur && running[cur.id])
  const hasProject = !!cur?.projectRoot
  // 锁定仅在「已开始且已绑过项目」时生效；未绑定的会话即使已开始也可随时补绑项目
  const locked = !!cur?.started && hasProject
  const root = cur?.projectRoot ?? null

  return (
    <div className="composer">
      <div className="seg-row">
        <button
          className={'proj-chip' + (locked ? ' locked' : '')}
          onClick={() => !locked && pickProject()}
          title={locked ? '会话已开始，项目目录已锁定' : hasProject ? '更改项目目录' : '绑定项目目录（可选；绑定后可读写代码）'}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 7l2-3h6l2 3h6v12H3z" />
          </svg>
          {cur?.projectName ?? '选择项目目录'}
          {locked ? (
            <svg className="lk" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
          ) : (
            <span className="ch-hint">{hasProject ? '可更改' : '可选'}</span>
          )}
        </button>
        <div className="spacer" />
        <ModeMenu />
        <div className={'mini-seg' + (reasoning === 'deep' ? ' deep' : '')}>
          {(['fast', 'balanced', 'deep'] as ReasoningMode[]).map((m) => (
            <button key={m} className={reasoning === m ? 'on' : ''} onClick={() => setReasoning(m)}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      </div>

      <RichInput
        root={root}
        busy={busy}
        onStop={abort}
        onSubmit={(t, a) => void send(t, a)}
        placeholder={
          hasProject
            ? '描述任务，回车发送 · / 命令 · @ 文件 · 可粘贴/拖入图片…'
            : '直接提问，回车发送 · 需读写代码时点上方「选择项目目录」绑定…'
        }
        sendTitle="发送"
      />
    </div>
  )
}
