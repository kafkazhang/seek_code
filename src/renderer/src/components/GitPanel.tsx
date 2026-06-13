import { useCallback, useEffect, useState } from 'react'
import { GitDiffPayload, GitFileChange, GitLogEntry, GitStatusResult } from '@shared/types'
import { useStore } from '../store'
import { CodeDiff } from './CodeEditor'
import MarkdownView from './MarkdownView'

// 内置 Git 面板：变更列表（暂存/未暂存分组）+ Monaco diff + 提交 + AI 提交信息 / AI 变更评审。

const isStaged = (f: GitFileChange): boolean => f.x !== ' ' && f.x !== '?'
const isUnstaged = (f: GitFileChange): boolean => f.y !== ' ' || f.x === '?'
const isUntracked = (f: GitFileChange): boolean => f.x === '?'

function changeLabel(f: GitFileChange, staged: boolean): string {
  const code = isUntracked(f) ? '?' : staged ? f.x : f.y
  switch (code) {
    case 'M':
      return 'M'
    case 'A':
      return 'A'
    case 'D':
      return 'D'
    case 'R':
      return 'R'
    case 'U':
      return 'U'
    case '?':
      return 'U?'
    default:
      return code.trim() || 'M'
  }
}

const base = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p

export default function GitPanel({ root }: { root: string }): JSX.Element {
  const treeVersion = useStore((s) => s.treeVersion)
  const [st, setSt] = useState<GitStatusResult | null>(null)
  const [sel, setSel] = useState<{ path: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState<GitDiffPayload | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState<string | null>(null) // 'commit' | 'gen' | 'review' | path 级操作
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [review, setReview] = useState<string | null>(null)
  const [view, setView] = useState<'changes' | 'history'>('changes')
  const [log, setLog] = useState<GitLogEntry[]>([])

  const refresh = useCallback(async (): Promise<void> => {
    const r = await window.seek.gitStatus(root)
    setSt(r)
    if (r.isRepo && view === 'history') setLog(await window.seek.gitLog(root))
  }, [root, view])

  useEffect(() => {
    void refresh()
  }, [refresh, treeVersion])

  // 选中文件 → 加载 diff
  useEffect(() => {
    if (!sel) {
      setDiff(null)
      return
    }
    let dead = false
    void window.seek.gitDiff(root, sel.path, sel.staged).then((d) => !dead && setDiff(d))
    return () => {
      dead = true
    }
  }, [root, sel])

  function flash(ok: boolean, text: string): void {
    setNotice({ ok, text })
    setTimeout(() => setNotice(null), ok ? 2500 : 6000)
  }

  async function op(key: string, fn: () => Promise<{ ok: boolean; error?: string; output?: string }>): Promise<void> {
    setBusy(key)
    const r = await fn()
    setBusy(null)
    if (!r.ok) flash(false, r.error ?? '操作失败')
    await refresh()
  }

  if (!st) return <div className="dock-empty">读取 Git 状态…</div>
  if (!st.isRepo) {
    return (
      <div className="dock-empty">
        当前项目不是 Git 仓库。
        {st.error && <div className="git-err">{st.error}</div>}
      </div>
    )
  }

  const staged = st.files.filter(isStaged)
  const unstaged = st.files.filter(isUnstaged)

  async function commit(): Promise<void> {
    if (!msg.trim() || !staged.length) return
    setBusy('commit')
    const r = await window.seek.gitCommit(root, msg)
    setBusy(null)
    if (r.ok) {
      setMsg('')
      setSel(null)
      flash(true, r.output || '提交成功')
    } else {
      flash(false, r.error ?? '提交失败')
    }
    await refresh()
  }

  async function genMsg(): Promise<void> {
    setBusy('gen')
    const r = await window.seek.gitGenMsg(root)
    setBusy(null)
    if (r.ok && r.text) setMsg(r.text)
    else flash(false, r.error ?? '生成失败')
  }

  async function runReview(): Promise<void> {
    setBusy('review')
    setReview(null)
    const r = await window.seek.gitReview(root)
    setBusy(null)
    if (r.ok && r.text) setReview(r.text)
    else flash(false, r.error ?? '评审失败')
  }

  const fileRow = (f: GitFileChange, stagedGroup: boolean): JSX.Element => {
    const on = sel?.path === f.path && sel.staged === stagedGroup
    return (
      <div
        key={(stagedGroup ? 's:' : 'w:') + f.path}
        className={'git-file' + (on ? ' on' : '')}
        onClick={() => setSel({ path: f.path, staged: stagedGroup })}
        title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
      >
        <span className={'gf-badge t-' + changeLabel(f, stagedGroup)[0]}>{changeLabel(f, stagedGroup)}</span>
        <span className="gf-name">{base(f.path)}</span>
        <span className="gf-dir">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
        <span className="gf-acts" onClick={(e) => e.stopPropagation()}>
          {stagedGroup ? (
            <button title="取消暂存" onClick={() => void op(f.path, () => window.seek.gitUnstage(root, [f.path]))}>
              −
            </button>
          ) : (
            <>
              {!isUntracked(f) && (
                <button
                  title="丢弃工作区改动（不可撤销）"
                  className="danger"
                  onClick={() => {
                    if (window.confirm(`丢弃对 ${f.path} 的工作区改动？此操作不可撤销。`))
                      void op(f.path, () => window.seek.gitDiscard(root, f.path))
                  }}
                >
                  ↺
                </button>
              )}
              <button title="暂存" onClick={() => void op(f.path, () => window.seek.gitStage(root, [f.path]))}>
                ＋
              </button>
            </>
          )}
        </span>
      </div>
    )
  }

  return (
    <div className="git-panel">
      <div className="panel-bar">
        <span className="git-branch" title="当前分支">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="6" cy="6" r="2.6" />
            <circle cx="6" cy="18" r="2.6" />
            <circle cx="18" cy="8" r="2.6" />
            <path d="M6 8.6v6.8M18 10.6c0 3-3 4-6 4" />
          </svg>
          {st.branch ?? '—'}
          {(st.ahead ?? 0) > 0 && <span className="git-ab">↑{st.ahead}</span>}
          {(st.behind ?? 0) > 0 && <span className="git-ab">↓{st.behind}</span>}
        </span>
        <button
          className={'pb-btn-t' + (view === 'history' ? ' on' : '')}
          onClick={async () => {
            const v = view === 'changes' ? 'history' : 'changes'
            setView(v)
            if (v === 'history') setLog(await window.seek.gitLog(root))
          }}
        >
          {view === 'changes' ? '历史' : '变更'}
        </button>
        <button
          className="pb-btn-t"
          onClick={() => void runReview()}
          disabled={busy === 'review'}
          title="AI 评审当前全部变更（暂存 + 未暂存）"
        >
          {busy === 'review' ? '评审中…' : 'AI 评审'}
        </button>
        <button className="pb-btn" onClick={() => void refresh()} title="刷新">
          ⟳
        </button>
      </div>

      {notice && <div className={'git-notice ' + (notice.ok ? 'ok' : 'bad')}>{notice.text}</div>}

      {view === 'history' ? (
        <div className="git-log scroll">
          {log.length === 0 ? (
            <div className="dock-empty">暂无提交记录</div>
          ) : (
            log.map((l) => (
              <div className="git-commit" key={l.hash}>
                <span className="gc-hash">{l.hash}</span>
                <span className="gc-subject" title={l.subject}>
                  {l.subject}
                </span>
                <span className="gc-meta">
                  {l.author} · {l.date}
                </span>
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          <div className="git-lists scroll">
            <div className="git-group">
              <div className="gg-head">
                <span>已暂存（{staged.length}）</span>
                {staged.length > 0 && (
                  <button onClick={() => void op('all', () => window.seek.gitUnstage(root, staged.map((f) => f.path)))}>
                    全部取消
                  </button>
                )}
              </div>
              {staged.length ? staged.map((f) => fileRow(f, true)) : <div className="gg-empty">无</div>}
            </div>
            <div className="git-group">
              <div className="gg-head">
                <span>变更（{unstaged.length}）</span>
                {unstaged.length > 0 && (
                  <button onClick={() => void op('all', () => window.seek.gitStage(root, unstaged.map((f) => f.path)))}>
                    全部暂存
                  </button>
                )}
              </div>
              {unstaged.length ? unstaged.map((f) => fileRow(f, false)) : <div className="gg-empty">工作区干净</div>}
            </div>
          </div>

          {diff && sel && (
            <div className="git-diff">
              <div className="gd-head">
                <span className="gd-path">
                  {sel.path}
                  <i>{sel.staged ? 'HEAD ↔ 暂存区' : '暂存区 ↔ 工作区'}</i>
                </span>
                <button onClick={() => setSel(null)}>收起</button>
              </div>
              <div className="gd-body">
                <CodeDiff path={diff.path} original={diff.oldText} modified={diff.newText} />
              </div>
            </div>
          )}

          <div className="git-commitbox">
            <textarea
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              placeholder={staged.length ? '提交信息（首行为摘要）…' : '先暂存要提交的变更'}
              rows={2}
              spellCheck={false}
            />
            <div className="gcb-acts">
              <button className="gcb-ai" onClick={() => void genMsg()} disabled={busy === 'gen'} title="用 AI 根据 diff 生成提交信息">
                {busy === 'gen' ? '生成中…' : '✦ AI 生成'}
              </button>
              <div className="spacer" />
              <button
                className="gcb-commit"
                onClick={() => void commit()}
                disabled={!msg.trim() || !staged.length || busy === 'commit'}
                title={staged.length ? `提交 ${staged.length} 个已暂存文件` : '没有已暂存的变更'}
              >
                {busy === 'commit' ? '提交中…' : `提交（${staged.length}）`}
              </button>
            </div>
          </div>
        </>
      )}

      {review && (
        <div className="git-review">
          <div className="gd-head">
            <span className="gd-path">AI 变更评审</span>
            <button onClick={() => setReview(null)}>关闭</button>
          </div>
          <MarkdownView source={review} className="md-body gr-body scroll" />
        </div>
      )}
    </div>
  )
}
