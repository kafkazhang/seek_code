import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { CatalogEntry, DataInfo, DiscoveredSkill, McpStatus, SkillMeta } from '@shared/types'
import { MODES } from '../modes'
import { THEMES } from '../themes'

type TabId = 'model' | 'permission' | 'appearance' | 'skills' | 'mcp' | 'data'

const TABS: { id: TabId; label: string; icon: JSX.Element }[] = [
  {
    id: 'model',
    label: '模型与接入',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
      </svg>
    )
  },
  {
    id: 'permission',
    label: '权限模式',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
    )
  },
  {
    id: 'appearance',
    label: '外观',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <circle cx="12" cy="12" r="9" />
        <circle cx="8.5" cy="9.5" r="1.3" fill="currentColor" stroke="none" />
        <circle cx="15.5" cy="9.5" r="1.3" fill="currentColor" stroke="none" />
        <circle cx="9" cy="15" r="1.3" fill="currentColor" stroke="none" />
        <path d="M12 12c2.5 0 3.5 1.2 3.5 3" />
      </svg>
    )
  },
  {
    id: 'skills',
    label: '技能',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M12 2l3 6 6 1-4.5 4.3L18 20l-6-3-6 3 1.5-6.7L3 9l6-1z" />
      </svg>
    )
  },
  {
    id: 'mcp',
    label: 'MCP 服务器',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <rect x="3" y="4" width="18" height="6" rx="1.5" />
        <rect x="3" y="14" width="18" height="6" rx="1.5" />
        <path d="M7 7h.01M7 17h.01" />
      </svg>
    )
  },
  {
    id: 'data',
    label: '数据与隐私',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
      </svg>
    )
  }
]

export default function Settings(): JSX.Element {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const hasKey = useStore((s) => s.config?.hasKey ?? false)
  const [tab, setTab] = useState<TabId>('model')

  return (
    <div
      className="drawer-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && hasKey && setSettingsOpen(false)}
    >
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <h2>
              配置 <span>SeekCode</span>
            </h2>
            <p>纯本地运行，代码不出本机；仅 LLM 推理走网络。</p>
          </div>
          {hasKey && (
            <button className="x-btn" onClick={() => setSettingsOpen(false)} title="关闭">
              ✕
            </button>
          )}
        </div>
        <div className="drawer-body">
          <nav className="drawer-tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
                {t.icon}
                {t.label}
              </button>
            ))}
          </nav>
          <div className="drawer-content scroll">
            {tab === 'model' && <TabModel />}
            {tab === 'permission' && <TabPermission />}
            {tab === 'appearance' && <TabAppearance />}
            {tab === 'skills' && <TabSkills />}
            {tab === 'mcp' && <TabMcp />}
            {tab === 'data' && <TabData />}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 模型与接入 ───────────────────────────────────────
function TabModel(): JSX.Element {
  const { config, saveConfig } = useStore()
  const projectRoot = useStore((s) => s.active()?.projectRoot ?? null)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [baseURL, setBaseURL] = useState(config?.baseURL ?? 'https://api.deepseek.com')
  const [flashModel, setFlash] = useState(config?.flashModel ?? 'deepseek-v4-flash')
  const [proModel, setPro] = useState(config?.proModel ?? 'deepseek-v4-pro')
  const [fimModel, setFim] = useState(config?.fimModel ?? 'deepseek-v4-flash')
  const [semanticIndex, setSemantic] = useState(config?.semanticIndex ?? false)
  const [embedBaseURL, setEmbedBase] = useState(
    config?.embedBaseURL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  )
  const [embedModel, setEmbed] = useState(config?.embedModel ?? 'text-embedding-v3')
  const [embedKey, setEmbedKey] = useState('')
  const [showEmbedKey, setShowEmbedKey] = useState(false)
  const [vecInfo, setVecInfo] = useState<{ state: string; chunks: number; reason?: string } | null>(null)
  const [embedTesting, setEmbedTesting] = useState(false)
  const [embedResult, setEmbedResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [saved, setSaved] = useState(false)
  const hasKey = config?.hasKey ?? false
  const hasEmbedKey = config?.hasEmbedKey ?? false

  function patchObj(): any {
    const p: any = { baseURL, flashModel, proModel, fimModel, semanticIndex, embedBaseURL, embedModel }
    if (apiKey.trim()) p.apiKey = apiKey.trim()
    if (embedKey.trim()) p.embedApiKey = embedKey.trim()
    return p
  }
  async function loadVecInfo(): Promise<void> {
    setVecInfo(await window.seek.vecStatus(projectRoot))
  }
  async function testEmbed(): Promise<void> {
    setEmbedTesting(true)
    setEmbedResult(null)
    await saveConfig(patchObj()) // 先落盘当前向量配置，再用它测试
    const r = await window.seek.embedTest()
    setEmbedTesting(false)
    setEmbedResult(
      r.ok ? { ok: true, text: `连接成功 ✓ 向量维度 ${r.dim}` } : { ok: false, text: `连接失败：${r.error}` }
    )
  }
  async function save(): Promise<void> {
    await saveConfig(patchObj())
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }
  async function test(): Promise<void> {
    setTesting(true)
    setResult(null)
    await saveConfig(patchObj())
    const r = await window.seek.testConnection()
    setTesting(false)
    setResult(r.ok ? { ok: true, text: `连接成功 ✓ 可用模型：${(r.models ?? []).join(', ') || '—'}` } : { ok: false, text: `连接失败：${r.error}` })
  }

  return (
    <div className="tab-pane">
      <div className="tab-h">模型与接入</div>
      <div className="tab-sub">只需一个 DeepSeek API Key 即可开始；OpenAI 兼容协议，可改 Base URL。</div>

      <div className="field">
        <label>DeepSeek API Key</label>
        <div className="key-row">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasKey ? '已配置（如需更换请粘贴新 Key）' : 'sk-...'}
            autoFocus={!hasKey}
          />
          <button className="key-eye" onClick={() => setShowKey((v) => !v)}>
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
        <div className="tip">通过操作系统级加密（safeStorage）保存在本机，不写入日志、不进入提示词正文。</div>
      </div>

      <div className="field">
        <label>API 接口地址（Base URL）</label>
        <input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://api.deepseek.com" />
        <div className="tip">出口白名单自动跟随此域名——仅该域名被允许联网。</div>
      </div>

      <div className="field-row">
        <div className="field">
          <label>快速档（FAST）</label>
          <input value={flashModel} onChange={(e) => setFlash(e.target.value)} />
          <div className="tip">thinking 关闭，最快最省</div>
        </div>
        <div className="field">
          <label>深度档（BALANCED / DEEP）</label>
          <input value={proModel} onChange={(e) => setPro(e.target.value)} />
          <div className="tip">thinking 开启，effort high / max</div>
        </div>
      </div>
      <div className="field">
        <label>FIM 补全模型</label>
        <input value={fimModel} onChange={(e) => setFim(e.target.value)} />
        <div className="tip">编辑器内 Tab 补全使用的模型（DeepSeek FIM 接口）。</div>
      </div>

      <div className="field">
        <label className="check-row">
          <input type="checkbox" checked={semanticIndex} onChange={(e) => setSemantic(e.target.checked)} />
          语义向量检索（与 BM25 混合召回）
        </label>
        <div className="tip">
          开启后对代码库分块向量化（OpenAI 兼容 /embeddings，按内容缓存、增量更新），search_code 走「BM25 +
          向量」RRF 混合召回；未配置/接口不可用时自动回退纯 BM25。会产生少量 embedding 费用。
          <br />
          <b>DeepSeek 暂无向量模型，需单独配置外部向量服务</b>（默认：阿里 DashScope · text-embedding-v3）。
        </div>
        {semanticIndex && (
          <div className="embed-cfg">
            <label>向量服务接口地址（Base URL）</label>
            <input
              value={embedBaseURL}
              onChange={(e) => setEmbedBase(e.target.value)}
              placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
            />
            <label style={{ marginTop: 8 }}>向量服务 API Key</label>
            <div className="key-row">
              <input
                type={showEmbedKey ? 'text' : 'password'}
                value={embedKey}
                onChange={(e) => setEmbedKey(e.target.value)}
                placeholder={hasEmbedKey ? '已配置（如需更换请粘贴新 Key）' : 'sk-... / DashScope API Key'}
              />
              <button className="key-eye" onClick={() => setShowEmbedKey((v) => !v)}>
                {showEmbedKey ? '隐藏' : '显示'}
              </button>
            </div>
            <label style={{ marginTop: 8 }}>向量化模型 id</label>
            <input value={embedModel} onChange={(e) => setEmbed(e.target.value)} placeholder="text-embedding-v3" />
            <div className="tip">
              独立于 DeepSeek Key，经操作系统级加密单独保存。出口白名单会自动加入该接口域名。
              {vecInfo && (
                <>
                  {' · 当前索引：'}
                  {vecInfo.state === 'ready'
                    ? `就绪 · ${vecInfo.chunks} 块`
                    : vecInfo.state === 'building'
                      ? `构建中 · 已 ${vecInfo.chunks} 块`
                      : vecInfo.state === 'nokey'
                        ? '未配置向量 Key'
                        : vecInfo.state === 'unavailable'
                          ? `接口不可用（${vecInfo.reason ?? ''}），已回退 BM25`
                          : vecInfo.state === 'disabled'
                            ? '未启用'
                            : '待构建（打开项目或首次检索时构建）'}
                </>
              )}
            </div>
            {embedResult && (
              <div className={'test-result ' + (embedResult.ok ? 'ok' : 'bad')}>{embedResult.text}</div>
            )}
            <div className="acts" style={{ marginTop: 8 }}>
              <button className="btn ghost" onClick={() => void testEmbed()} disabled={embedTesting}>
                {embedTesting ? '测试中…' : '测试向量连接'}
              </button>
              <button className="link-btn" onClick={() => void loadVecInfo()}>
                查询索引状态
              </button>
            </div>
          </div>
        )}
      </div>

      {result && <div className={'test-result ' + (result.ok ? 'ok' : 'bad')}>{result.text}</div>}

      <div className="acts">
        <button className="btn primary" onClick={() => void save()}>
          {saved ? '已保存 ✓' : '保存'}
        </button>
        <button className="btn ghost" onClick={() => void test()} disabled={testing}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        <button
          className="btn ghost"
          style={{ marginLeft: 'auto' }}
          onClick={() => {
            setFlash('deepseek-v4-flash')
            setPro('deepseek-v4-pro')
            setFim('deepseek-v4-flash')
          }}
        >
          恢复默认模型
        </button>
      </div>
    </div>
  )
}

// ── 权限模式 ─────────────────────────────────────────
function TabPermission(): JSX.Element {
  const permissionMode = useStore((s) => s.config?.permissionMode ?? 'ask')
  const setDefaultMode = useStore((s) => s.setDefaultMode)
  return (
    <div className="tab-pane">
      <div className="tab-h">权限模式</div>
      <div className="tab-sub">新建会话时的默认权限模式。每个会话可在对话框旁单独切换（Shift+Ctrl+M），互不影响。</div>
      <div className="mode-list">
        {MODES.map((m) => (
          <button key={m.id} className={'mode-opt' + (permissionMode === m.id ? ' on' : '')} onClick={() => setDefaultMode(m.id)}>
            <span className="mo-check">{permissionMode === m.id ? '✓' : ''}</span>
            <span className="mo-text">
              <b>{m.label}</b>
              <span className="mo-desc">{m.desc}</span>
            </span>
            <span className="mo-key">{m.key}</span>
          </button>
        ))}
      </div>
      <div className="note-box">
        <b>始终生效的安全护栏</b>
        <p>无论何种模式：会杀死应用自身的命令（如 `taskkill /im node.exe`、`killall node`）一律拒绝；危险命令（`rm -rf`、`shutdown`、任何 kill）即使在「全自动」也强制弹审批。</p>
      </div>
    </div>
  )
}

// ── 外观 / 主题 ──────────────────────────────────────
function TabAppearance(): JSX.Element {
  const theme = useStore((s) => s.config?.theme ?? 'abyss')
  const setTheme = useStore((s) => s.setTheme)
  return (
    <div className="tab-pane">
      <div className="tab-h">界面主题</div>
      <div className="tab-sub">即时预览、自动保存。所有主题共享同一套排版与组件，仅配色不同。</div>
      <div className="theme-grid">
        {THEMES.map((t) => (
          <button
            key={t.id}
            className={'theme-card' + (theme === t.id ? ' on' : '')}
            onClick={() => setTheme(t.id)}
            title={t.desc}
          >
            <span className="theme-preview" style={{ background: t.swatch[0] }}>
              <span className="tp-panel" style={{ background: t.swatch[1] }}>
                <span className="tp-bar" style={{ background: t.swatch[2] }} />
                <span className="tp-line" style={{ background: t.swatch[3], opacity: 0.7 }} />
                <span className="tp-line short" style={{ background: t.swatch[3], opacity: 0.4 }} />
              </span>
              <span className="tp-dot" style={{ background: t.swatch[2] }} />
            </span>
            <span className="theme-meta">
              <b>
                {t.label}
                {theme === t.id && <span className="theme-on">✓</span>}
              </b>
              <span className="theme-desc">{t.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── 市场（搜索式在线安装，MCP / 技能共用）──────────────
function Market({ kind, onInstalled }: { kind: 'mcp' | 'skill'; onInstalled: () => void }): JSX.Element {
  const root = useStore((s) => s.active()?.projectRoot ?? null)
  const [list, setList] = useState<CatalogEntry[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [configuring, setConfiguring] = useState<string | null>(null)
  const [vals, setVals] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<string | null>(null)
  function refresh(query: string): void {
    setLoading(true)
    void window.seek.marketSearch(kind, query, root).then((r) => {
      setList(r)
      setLoading(false)
    })
  }
  useEffect(() => {
    const t = setTimeout(() => refresh(q), q ? 450 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])
  function startInstall(e: CatalogEntry): void {
    if (e.fields && e.fields.length) {
      setConfiguring(e.id)
      setVals({})
    } else void doInstall(e, {})
  }
  async function doInstall(e: CatalogEntry, values: Record<string, string>): Promise<void> {
    setBusy(e.id)
    setMsg(null)
    const r = await window.seek.marketInstall(kind, e.id, root, values)
    setBusy(null)
    setConfiguring(null)
    setVals({})
    setMsg(r.ok ? `已安装：${r.name}` : `失败：${r.error}`)
    refresh(q)
    onInstalled()
  }
  const markets = Array.from(new Set(list.map((e) => e.market)))
  return (
    <div className="market">
      <input
        className="market-search"
        placeholder={kind === 'mcp' ? '搜索内置 + MCP 官方注册中心…' : '搜索内置 + GitHub…'}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />
      {loading && <div className="market-msg">搜索中…</div>}
      {msg && <div className={'market-msg' + (msg.startsWith('失败') ? ' bad' : '')}>{msg}</div>}
      {markets.map((m) => (
        <div key={m}>
          <div className="mk-group">{m}</div>
          {list
            .filter((e) => e.market === m)
            .map((e) => (
              <div key={e.id}>
                <div className="mk-item">
                  <div className="mk-main">
                    <div className="mk-row1">
                      <b>{e.name}</b>
                      {e.remote && <span className="mk-remote">云端</span>}
                      {e.transport === 'http' && <span className="mk-remote">HTTP</span>}
                      {e.version && <span className="mk-ver">v{e.version}</span>}
                    </div>
                    <div className="mk-desc">{e.description}</div>
                    <div className="mk-tags">
                      {e.tags.map((t) => (
                        <span key={t} className="mk-tag">
                          {t}
                        </span>
                      ))}
                      {e.needsConfig && (
                        <span className="mk-need" title={e.needsConfig}>
                          需配置
                        </span>
                      )}
                      {(e.homepage || e.version) && (
                        <button className="mk-detail" onClick={() => setDetail(detail === e.id ? null : e.id)}>
                          详情
                        </button>
                      )}
                    </div>
                  </div>
                  {e.installed ? (
                    <span className="mk-done">已安装</span>
                  ) : (
                    <button className="mk-install" disabled={busy === e.id} onClick={() => startInstall(e)}>
                      {busy === e.id ? '安装中…' : e.fields && e.fields.length ? '配置安装' : '安装'}
                    </button>
                  )}
                </div>
                {detail === e.id && (
                  <div className="mk-detailbox">
                    <div className="mk-dl">{e.description || '（无描述）'}</div>
                    <div className="mk-dl-row">
                      {e.version && <span className="mk-ver">v{e.version}</span>}
                      {e.transport && <span className="mk-tag">{e.transport}</span>}
                      {e.homepage && (
                        <button className="mk-open" onClick={() => void window.seek.openUrl(e.homepage as string)}>
                          打开主页 ↗
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {configuring === e.id && e.fields && (
                  <div className="mk-fields">
                    {e.fields.map((f) => (
                      <label key={f.key} className="mk-field">
                        <span>{f.label}</span>
                        <input
                          value={vals[f.key] ?? ''}
                          placeholder={f.placeholder}
                          onChange={(ev) => setVals((v) => ({ ...v, [f.key]: ev.target.value }))}
                        />
                      </label>
                    ))}
                    <div className="mk-fields-acts">
                      <button className="mk-install" disabled={busy === e.id} onClick={() => void doInstall(e, vals)}>
                        确认安装
                      </button>
                      <button
                        className="eco-edit"
                        onClick={() => {
                          setConfiguring(null)
                          setVals({})
                        }}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
        </div>
      ))}
      {list.length === 0 && !loading && <div className="eco-empty">无匹配结果</div>}
    </div>
  )
}

// ── 技能 ─────────────────────────────────────────────
function TabSkills(): JSX.Element {
  const root = useStore((s) => s.active()?.projectRoot ?? null)
  const bumpSkills = useStore((s) => s.bumpSkills)
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [editing, setEditing] = useState<{ name: string; scope: 'global' | 'project'; body: string } | null>(null)
  const [showInstall, setShowInstall] = useState(false)
  const [showMarket, setShowMarket] = useState(false)
  const [url, setUrl] = useState('')
  const [installMsg, setInstallMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [installing, setInstalling] = useState(false)
  const [discovered, setDiscovered] = useState<DiscoveredSkill[] | null>(null)
  const [dir, setDir] = useState('')
  const refresh = (): void => {
    void window.seek.listSkills(root).then(setSkills)
    bumpSkills() // 通知输入框 / 菜单刷新技能列表
  }

  const scope = (): 'global' | 'project' => 'global' // 技能统一全局安装
  async function install(): Promise<void> {
    const u = url.trim()
    if (!u) return
    setInstalling(true)
    setInstallMsg(null)
    setDiscovered(null)
    // 仓库地址（含 .git 或仅 owner/repo）→ 扫描出所有技能供选择
    const isRepo = /^https?:\/\/github\.com\/[^/]+\/[^/]+(\.git)?\/?$/i.test(u)
    if (isRepo) {
      const r = await window.seek.discoverSkills(u)
      setInstalling(false)
      if (r.ok && r.skills) {
        setDiscovered(r.skills)
        setInstallMsg({ ok: true, text: `发现 ${r.skills.length} 个技能，选择安装：` })
      } else setInstallMsg({ ok: false, text: `扫描失败：${r.error}` })
      return
    }
    const r = await window.seek.installSkill(u, scope(), root)
    setInstalling(false)
    if (r.ok) {
      setInstallMsg({ ok: true, text: `已安装技能：${r.name}` })
      setUrl('')
      refresh()
    } else setInstallMsg({ ok: false, text: `安装失败：${r.error}` })
  }
  async function installOne(s: DiscoveredSkill): Promise<void> {
    const r = await window.seek.installSkill(s.url, scope(), root)
    if (r.ok) refresh()
    else setInstallMsg({ ok: false, text: `安装 ${s.name} 失败：${r.error}` })
  }
  async function installAll(): Promise<void> {
    const todo = (discovered ?? []).filter((s) => !skills.some((x) => x.name === s.name))
    for (const s of todo) await window.seek.installSkill(s.url, scope(), root)
    refresh()
    setInstallMsg({ ok: true, text: `已安装 ${todo.length} 个技能` })
  }
  useEffect(() => {
    refresh()
    void window.seek.getDataInfo().then((d) => setDir(d.dir))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function openEdit(s: SkillMeta): Promise<void> {
    const content = (await window.seek.readSkill(s.id, root)) ?? ''
    setEditing({ name: s.name, scope: s.scope, body: content })
  }
  async function newSkill(): Promise<void> {
    setEditing({ name: '', scope: 'global', body: '' })
  }
  async function save(): Promise<void> {
    if (!editing || !editing.name.trim() || !editing.body.trim()) return
    const body = editing.body.includes('#') ? editing.body : `# ${editing.name.trim()}\n\n${editing.body.trim()}`
    await window.seek.saveSkill(editing.scope, editing.name.trim(), body, root)
    setEditing(null)
    refresh()
  }

  return (
    <div className="tab-pane">
      <div className="tab-h">技能 Skills</div>
      <div className="tab-sub">Markdown 技能（领域知识 / 工作流）。Agent 按需 list_skills / read_skill 加载；输入框 / 菜单可直接选用。</div>
      <div className="eco-tip" style={{ wordBreak: 'break-all' }}>
        技能统一安装到全局目录（所有项目可用）：<code>{dir ? `${dir}\\skills` : '…'}</code>（「打开目录」可查看）
      </div>

      {!editing && (
        <>
          <div className="row-bar">
            <span className="rb-count">{skills.length} 个技能</span>
            <button className="eco-add" onClick={() => void newSkill()}>
              ＋ 新建
            </button>
            <button className="eco-add" onClick={() => setShowInstall((v) => !v)}>
              ⬇ 从 URL 安装
            </button>
            <button className={'eco-add' + (showMarket ? ' on' : '')} onClick={() => setShowMarket((v) => !v)}>
              🛒 浏览市场
            </button>
            <button className="eco-add" onClick={() => void window.seek.openDataDir()}>
              打开目录
            </button>
          </div>
          {showMarket && <Market kind="skill" onInstalled={refresh} />}
          {showInstall && (
            <div className="eco-form">
              <input
                placeholder="技能 URL 或仓库地址，如 https://github.com/anthropics/skills.git"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              {installMsg && <div className={'test-result ' + (installMsg.ok ? 'ok' : 'bad')}>{installMsg.text}</div>}
              <button className="btn primary" onClick={() => void install()} disabled={installing}>
                {installing ? '处理中…' : '安装 / 扫描仓库'}
              </button>
              <div className="tip">单文件 / 目录(tree) 直接安装；给整个仓库（如 …/skills.git）则扫描出全部技能供选择。</div>
              {discovered && (
                <div className="disc-list">
                  <div className="row-bar">
                    <span className="rb-count">{discovered.length} 个技能</span>
                    <button className="eco-add" onClick={() => void installAll()}>
                      全部安装
                    </button>
                  </div>
                  {discovered.map((s) => {
                    const done = skills.some((x) => x.name === s.name)
                    return (
                      <div className="disc-item" key={s.id}>
                        <div className="disc-main">
                          <b>{s.name}</b>
                          <span className="disc-dir">{s.dir}</span>
                        </div>
                        {done ? (
                          <span className="mk-done">已安装</span>
                        ) : (
                          <button className="mk-install" onClick={() => void installOne(s)}>
                            安装
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          {skills.length === 0 && <div className="eco-empty">暂无技能。新建一个，描述某类任务的标准做法。</div>}
          {skills.map((s) => (
            <div className="eco-item" key={s.id}>
              <div className="eco-main">
                <div className="eco-row1">
                  <b>{s.name}</b>
                  <span className="eco-scope">{s.scope === 'global' ? '全局' : '项目'}</span>
                  {s.source && <span className="eco-scope" title={s.source}>可更新</span>}
                </div>
                <div className="eco-desc">{s.description}</div>
              </div>
              {s.source && (
                <button
                  className="eco-edit"
                  onClick={() => void window.seek.updateSkill(s.id, root).then(refresh)}
                  title={'从来源重新拉取：' + s.source}
                >
                  更新
                </button>
              )}
              <button className="eco-edit" onClick={() => void openEdit(s)}>
                编辑
              </button>
              <button className="eco-del" onClick={() => void window.seek.deleteSkill(s.id, root).then(refresh)}>
                删除
              </button>
            </div>
          ))}
        </>
      )}

      {editing && (
        <div className="eco-form">
          <div className="field">
            <label>技能名称（全局，所有项目可用）</label>
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="如：单元测试" />
          </div>
          <div className="field">
            <label>内容（Markdown）</label>
            <textarea
              className="skill-body"
              value={editing.body}
              onChange={(e) => setEditing({ ...editing, body: e.target.value })}
              placeholder="# 技能名&#10;> 一句话说明&#10;&#10;指导 Agent 的步骤 / 知识…"
            />
          </div>
          <div className="acts">
            <button className="btn primary" onClick={() => void save()}>
              保存技能
            </button>
            <button className="btn ghost" onClick={() => setEditing(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── MCP ──────────────────────────────────────────────
function TabMcp(): JSX.Element {
  const root = useStore((s) => s.active()?.projectRoot ?? null)
  const [list, setList] = useState<McpStatus[]>([])
  const [adding, setAdding] = useState(false)
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
  const [name, setName] = useState('')
  const [cmd, setCmd] = useState('')
  const [env, setEnv] = useState('')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showMarket, setShowMarket] = useState(false)
  const refresh = (): void => void window.seek.mcpStatus().then(setList)
  useEffect(() => {
    refresh()
  }, [])

  function parseJson(s: string): Record<string, string> | undefined {
    if (!s.trim()) return undefined
    try {
      return JSON.parse(s)
    } catch {
      return undefined
    }
  }
  async function add(): Promise<void> {
    if (!name.trim()) return
    let cfg: unknown
    if (transport === 'http') {
      if (!url.trim()) return
      cfg = { url: url.trim(), headers: parseJson(headers) }
    } else {
      if (!cmd.trim()) return
      const parts = cmd.trim().split(/\s+/)
      cfg = { command: parts[0], args: parts.slice(1), env: parseJson(env) }
    }
    await window.seek.addMcpServer(name.trim(), cfg, root)
    setName('')
    setCmd('')
    setEnv('')
    setUrl('')
    setHeaders('')
    setAdding(false)
    setTimeout(refresh, 1200)
  }

  return (
    <div className="tab-pane">
      <div className="tab-h">MCP 服务器</div>
      <div className="tab-sub">通过 stdio 连接 MCP 服务器，其工具会并入 Agent（命名空间 mcp__服务器__工具）。配置存于 mcp.json。</div>

      <div className="row-bar">
        <span className="rb-count">{list.length} 个服务器</span>
        <button className="eco-add" onClick={() => setAdding((v) => !v)}>
          ＋ 添加
        </button>
        <button className={'eco-add' + (showMarket ? ' on' : '')} onClick={() => setShowMarket((v) => !v)}>
          🛒 浏览市场
        </button>
        <button className="eco-add" onClick={() => void window.seek.reloadMcp(root).then(() => setTimeout(refresh, 800))}>
          ↻ 重连
        </button>
      </div>
      {showMarket && <Market kind="mcp" onInstalled={() => setTimeout(refresh, 800)} />}

      {adding && (
        <div className="eco-form">
          <div className="scope-seg">
            <button className={transport === 'stdio' ? 'on' : ''} onClick={() => setTransport('stdio')}>
              本地命令 (stdio)
            </button>
            <button className={transport === 'http' ? 'on' : ''} onClick={() => setTransport('http')}>
              远程 (HTTP)
            </button>
          </div>
          <input placeholder="服务器名，如 filesystem" value={name} onChange={(e) => setName(e.target.value)} />
          {transport === 'stdio' ? (
            <>
              <input
                placeholder="启动命令，如 npx -y @modelcontextprotocol/server-filesystem ."
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
              />
              <input placeholder='环境变量（可选 JSON），如 {"TOKEN":"xxx"}' value={env} onChange={(e) => setEnv(e.target.value)} />
            </>
          ) : (
            <>
              <input placeholder="服务器地址，如 https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
              <input placeholder='请求头（可选 JSON），如 {"Authorization":"Bearer xxx"}' value={headers} onChange={(e) => setHeaders(e.target.value)} />
            </>
          )}
          <button className="btn primary" onClick={() => void add()}>
            添加并连接
          </button>
        </div>
      )}

      {list.length === 0 && !adding && <div className="eco-empty">未配置 MCP 服务器。</div>}
      {list.map((m) => (
        <div className="eco-item col" key={m.name}>
          <div className="eco-line">
            <div className="eco-main">
              <div className="eco-row1">
                <span className={'mcp-dot ' + m.status} />
                <b>{m.name}</b>
                <span className="eco-scope">
                  {m.status === 'ready' ? `${m.tools} 工具` : m.status === 'connecting' ? '连接中' : '错误'}
                </span>
              </div>
              {m.error && <div className="eco-desc">{m.error}</div>}
            </div>
            {m.status === 'ready' && m.tools > 0 && (
              <button className="eco-edit" onClick={() => setExpanded(expanded === m.name ? null : m.name)}>
                {expanded === m.name ? '收起' : '工具'}
              </button>
            )}
            <button className="eco-del" onClick={() => void window.seek.removeMcpServer(m.name, root).then(() => setTimeout(refresh, 600))}>
              移除
            </button>
          </div>
          {expanded === m.name && (
            <div className="mcp-tools">
              {m.toolNames.map((t) => (
                <span className="mcp-tool" key={t}>
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── 数据与隐私 ───────────────────────────────────────
function TabData(): JSX.Element {
  const [info, setInfo] = useState<DataInfo | null>(null)
  const [changing, setChanging] = useState(false)
  const [changeMsg, setChangeMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [needRestart, setNeedRestart] = useState(false)
  useEffect(() => {
    void window.seek.getDataInfo().then(setInfo)
  }, [])

  async function changeDir(): Promise<void> {
    setChanging(true)
    setChangeMsg(null)
    const r = await window.seek.changeDataDir()
    setChanging(false)
    if (!r.ok) {
      if (r.error === 'cancelled') return // 用户取消选择，静默
      setChangeMsg({ ok: false, text: `更改失败：${r.error}` })
      return
    }
    if (r.from === r.to) {
      setChangeMsg({ ok: true, text: '已是当前数据目录，无需更改。' })
      return // 同一目录，不必重启
    }
    setInfo(await window.seek.getDataInfo())
    setChangeMsg({
      ok: true,
      text: r.moved ? `数据已迁移到新目录：${r.to}` : `数据目录已设置为：${r.to}`
    })
    setNeedRestart(true)
  }

  return (
    <div className="tab-pane">
      <div className="tab-h">数据与隐私</div>
      <div className="tab-sub">所有数据仅存本机，卸载即清除。唯一出网的是 DeepSeek 推理调用。</div>

      <div className="kv">
        <span>会话数</span>
        <b>{info ? info.sessionCount : '…'}</b>
      </div>
      <div className="kv">
        <span>API Key</span>
        <b className={info?.hasKey ? 'good' : ''}>{info ? (info.hasKey ? '已加密保存' : '未配置') : '…'}</b>
      </div>
      <div className="field" style={{ marginTop: 14 }}>
        <label>数据目录</label>
        <div className="key-row">
          <input readOnly value={info?.dir ?? ''} />
          <button className="key-eye" onClick={() => void window.seek.openDataDir()}>
            打开
          </button>
          <button className="key-eye" onClick={() => void changeDir()} disabled={changing || needRestart}>
            {changing ? '迁移中…' : '更改'}
          </button>
        </div>
        <div className="tip">
          settings.json（配置）· apikey.bin（加密密钥）· sessions.json（历史会话）· skills/ · mcp.json
          <br />
          更改目录会把上述数据安全复制到新位置（旧目录保留作备份），完成后需重启应用生效。
        </div>
      </div>

      {changeMsg && <div className={'test-result ' + (changeMsg.ok ? 'ok' : 'bad')}>{changeMsg.text}</div>}

      {needRestart && (
        <div className="data-confirm">
          <span>数据目录已更改，重启应用后生效。</span>
          <div className="cc-acts">
            <button className="btn primary" onClick={() => void window.seek.relaunchApp()}>
              立即重启
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
