import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useStore, type Attachment } from '../store'
import { FileNode, SkillMeta } from '@shared/types'

// 富文本输入框：对话区与任务委派区共用。
// 能力：自适应高度文本域、/命令+技能、@文件（项目内/外部）、粘贴/拖拽/上传附件、发送/中断。
// 通过 props 裁剪「任务特性」：是否启用 /命令、发送按钮文案、占位提示等。

const SLASH_CMDS: { cmd: string; label: string; desc: string; arg?: boolean }[] = [
  { cmd: '/fast', label: '快速档', desc: '推理 → FAST' },
  { cmd: '/balanced', label: '平衡档', desc: '推理 → BALANCED' },
  { cmd: '/deep', label: '深度档', desc: '推理 → DEEP' },
  { cmd: '/plan', label: '计划模式', desc: '只读，先出方案' },
  { cmd: '/auto', label: '全自动', desc: '写入与命令自动放行' },
  { cmd: '/accept', label: '接受编辑', desc: '自动写文件' },
  { cmd: '/ask', label: '询问授权', desc: '每次确认' },
  { cmd: '/cost', label: '查看花费', desc: '本会话成本' },
  { cmd: '/memory', label: '查看记忆', desc: 'SEEK.md + 全局' },
  { cmd: '/remember', label: '记住…', desc: '写入项目记忆', arg: true },
  { cmd: '/clear', label: '新建会话', desc: '清空当前对话' },
  { cmd: '/help', label: '帮助', desc: '命令列表' }
]

interface AcItem {
  type: 'cmd' | 'skill' | 'file' | 'action'
  key: string
  label: string
  sub: string
  insert: string
  action?: 'pickFile' | 'pickFolder'
}
interface AcState {
  kind: 'slash' | 'file'
  query: string
  start: number
  end: number
}

export const auid = (): string => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
function flattenFiles(nodes: FileNode[], out: string[]): void {
  for (const n of nodes) {
    if (n.type === 'file') out.push(n.path)
    else {
      out.push(n.path + '/') // 项目内的文件夹也可被 @ 引用
      if (n.children) flattenFiles(n.children, out)
    }
  }
}
const readImage = (f: File): Promise<string> =>
  new Promise((res) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.readAsDataURL(f)
  })
const readTextFile = (f: File): Promise<string> =>
  new Promise((res) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result || ''))
    r.readAsText(f)
  })

export interface RichInputProps {
  /** 项目根目录：用于 @文件 与技能补全；为 null 时仅可手输 */
  root: string | null
  /** 文本域占位提示 */
  placeholder: string
  /** 运行中：显示中断按钮 */
  busy?: boolean
  /** 中断回调（busy 时点击） */
  onStop?: () => void
  /** 提交回调：返回当前文本与附件，由调用方决定「发送」或「委派」 */
  onSubmit: (text: string, atts: Attachment[]) => void | Promise<void>
  /** 是否启用 /命令+技能 补全（任务委派关闭，因其为一次性目标） */
  enableSlash?: boolean
  /** 发送按钮文案；提供时渲染文字胶囊按钮，否则渲染箭头图标 */
  sendLabel?: string
  /** 发送按钮悬浮提示 */
  sendTitle?: string
}

export default function RichInput({
  root,
  placeholder,
  busy = false,
  onStop,
  onSubmit,
  enableSlash = true,
  sendLabel,
  sendTitle = '发送'
}: RichInputProps): JSX.Element {
  const [text, setText] = useState('')
  const [atts, setAtts] = useState<Attachment[]>([])
  const [ac, setAc] = useState<AcState | null>(null)
  const [acIndex, setAcIndex] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const skillsRev = useStore((st) => st.skillsRev)
  function loadSkills(): void {
    if (root && enableSlash) void window.seek.listSkills(root).then(setSkills)
    else setSkills([])
  }
  useEffect(() => {
    if (!root) {
      setFiles([])
      setSkills([])
      return
    }
    void window.seek.getTree(root).then((tree) => {
      const out: string[] = []
      flattenFiles(tree, out)
      setFiles(out)
    })
    loadSkills()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, skillsRev, enableSlash])

  const acItems: AcItem[] = useMemo(() => {
    if (!ac) return []
    if (ac.kind === 'slash') {
      const q = ac.query.toLowerCase()
      const cmds: AcItem[] = SLASH_CMDS.filter((c) => c.cmd.includes(q) || c.label.includes(ac.query))
        .slice(0, 6)
        .map((c) => ({ type: 'cmd', key: c.cmd, label: c.cmd, sub: `${c.label} · ${c.desc}`, insert: c.cmd + (c.arg ? ' ' : '') }))
      const sk: AcItem[] = skills
        .filter((s) => s.name.includes(ac.query) || s.id.toLowerCase().includes(q))
        .slice(0, 8)
        .map((s) => ({ type: 'skill', key: s.id, label: s.name, sub: s.description || '技能', insert: `使用「${s.name}」技能：` }))
      return [...cmds, ...sk]
    }
    const q = ac.query.toLowerCase()
    const actions = (
      [
        { type: 'action', key: '__pickfile', label: '浏览文件…', sub: '选择项目外的任意文件', insert: '', action: 'pickFile' },
        { type: 'action', key: '__pickdir', label: '浏览文件夹…', sub: '选择项目外的任意文件夹', insert: '', action: 'pickFolder' }
      ] as AcItem[]
    ).filter((a) => !q || a.label.includes(ac.query) || '浏览'.includes(ac.query))
    const proj: AcItem[] = files
      .filter((f) => f.toLowerCase().includes(q))
      .slice(0, 10)
      .map((f) => ({ type: 'file', key: f, label: f, sub: '', insert: '@' + f + ' ' }))
    return [...actions, ...proj]
  }, [ac, skills, files])

  function syncAc(value: string, caret: number): void {
    const before = value.slice(0, caret)
    // @ 文件引用（任意位置，前面是空白或行首）
    const fm = before.match(/(^|\s)@([^\s@]*)$/)
    if (fm) {
      const at = before.length - fm[2].length - 1
      setAc({ kind: 'file', query: fm[2], start: at, end: caret })
      setAcIndex(0)
      return
    }
    // / 命令/技能（任意位置，前面是空白或行首）
    if (enableSlash) {
      const sm = before.match(/(^|\s)\/(\S*)$/)
      if (sm) {
        const at = before.length - sm[2].length - 1
        setAc({ kind: 'slash', query: sm[2], start: at, end: caret })
        setAcIndex(0)
        return
      }
    }
    setAc(null)
  }

  async function accept(item: AcItem): Promise<void> {
    if (!ac) return
    const range = { start: ac.start, end: ac.end }
    // 浏览文件/文件夹：打开原生选择框，插入带引号的绝对路径（兼容空格）
    let insert = item.insert
    if (item.action) {
      setAc(null)
      const picked = await window.seek.pickPath(item.action === 'pickFile' ? 'file' : 'folder')
      if (!picked) {
        taRef.current?.focus()
        return
      }
      insert = `@"${picked}" `
    } else {
      setAc(null)
    }
    const next = text.slice(0, range.start) + insert + text.slice(range.end)
    setText(next)
    requestAnimationFrame(() => {
      const pos = range.start + insert.length
      const ta = taRef.current
      if (ta) {
        ta.focus()
        ta.setSelectionRange(pos, pos)
        ta.style.height = 'auto'
        ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
      }
    })
  }

  async function addFiles(fl: FileList | File[]): Promise<void> {
    const next: Attachment[] = []
    for (const f of Array.from(fl)) {
      if (f.type.startsWith('image/')) next.push({ id: auid(), kind: 'image', name: f.name || '图片', dataUrl: await readImage(f) })
      else if (f.size < 200_000) next.push({ id: auid(), kind: 'text', name: f.name, text: await readTextFile(f) })
    }
    if (next.length) setAtts((a) => [...a, ...next])
  }
  async function onPaste(e: { clipboardData: DataTransfer | null; preventDefault: () => void }): Promise<void> {
    const items = e.clipboardData?.items
    if (!items) return
    const imgs = Array.from(items).filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    if (imgs.length) {
      e.preventDefault()
      for (const it of imgs) {
        const f = it.getAsFile()
        if (f) await addFiles([f])
      }
    }
  }

  function submit(): void {
    if (busy) return
    if (!text.trim() && atts.length === 0) return
    const t = text
    const a = atts
    setText('')
    setAtts([])
    setAc(null)
    if (taRef.current) taRef.current.style.height = 'auto'
    void onSubmit(t, a)
  }

  return (
    <>
      {atts.length > 0 && (
        <div className="att-row">
          {atts.map((a) => (
            <div className={'att ' + a.kind} key={a.id}>
              {a.kind === 'image' ? <img src={a.dataUrl} alt={a.name} /> : <span className="att-name">{a.name}</span>}
              <button className="att-x" onClick={() => setAtts((x) => x.filter((y) => y.id !== a.id))}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className="box"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files)
        }}
      >
        {ac && acItems.length > 0 && (
          <div className="ac-pop">
            {acItems.map((it, i) => (
              <Fragment key={it.key}>
                {(i === 0 || acItems[i - 1].type !== it.type) && (
                  <div className="ac-head">
                    {it.type === 'cmd' ? '命令' : it.type === 'skill' ? '技能' : it.type === 'action' ? '外部' : '项目文件'}
                  </div>
                )}
                <button
                  className={'ac-item' + (i === acIndex ? ' on' : '')}
                  onMouseEnter={() => setAcIndex(i)}
                  onClick={() => accept(it)}
                >
                  <span className="ac-label">{it.label}</span>
                  {it.sub && <span className="ac-sub">{it.sub}</span>}
                </button>
              </Fragment>
            ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <button className="attach-btn" onClick={() => fileInputRef.current?.click()} title="上传文件 / 图片">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M21 12.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8.5-8.5" />
          </svg>
        </button>

        <textarea
          ref={taRef}
          value={text}
          placeholder={placeholder}
          onFocus={() => loadSkills()}
          onPaste={(e) => void onPaste(e)}
          onChange={(e) => {
            setText(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'
            syncAc(e.target.value, e.target.selectionStart)
          }}
          onKeyUp={(e) => syncAc((e.target as HTMLTextAreaElement).value, (e.target as HTMLTextAreaElement).selectionStart)}
          onClick={(e) => syncAc((e.target as HTMLTextAreaElement).value, (e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={(e) => {
            if (ac && acItems.length) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setAcIndex((i) => (i + 1) % acItems.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setAcIndex((i) => (i - 1 + acItems.length) % acItems.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                accept(acItems[acIndex])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setAc(null)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {busy ? (
          <button className="send stop" onClick={onStop} title="中断">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : sendLabel ? (
          <button
            className="send labeled"
            onClick={submit}
            disabled={!text.trim() && atts.length === 0}
            title={sendTitle}
          >
            {sendLabel}
          </button>
        ) : (
          <button className="send" onClick={submit} disabled={!text.trim() && atts.length === 0} title={sendTitle}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        )}
      </div>
    </>
  )
}
