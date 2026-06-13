import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getClient, modelFor } from './gateway'
import { withRetry } from './retry'
import { parseStatusZ, parseLog, isUntracked } from './gitparse'
import { GitAiResult, GitDiffPayload, GitLogEntry, GitOpResult, GitStatusResult } from '@shared/types'

const execFileAsync = promisify(execFile)

// 内置 Git 面板：主进程直接调本机 git CLI（execFile 传参数组，无 shell 注入面）。
// 全部操作限定在项目根目录；提交信息生成与变更评审复用 DeepSeek 网关（不引入新出口）。

const GIT_TIMEOUT = 30_000
const MAX_BUFFER = 1024 * 1024 * 16
const DIFF_CLIP = 48_000 // 喂给模型的 diff 字符上限
const MAX_UNTRACKED_FOR_AI = 5 // AI 评审/提交信息时附带的未跟踪文件数上限

async function git(root: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: root,
      timeout: GIT_TIMEOUT,
      maxBuffer: MAX_BUFFER,
      windowsHide: true
    })
    return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '' }
  } catch (e: any) {
    return { ok: false, stdout: e?.stdout ?? '', stderr: (e?.stderr || e?.message || String(e)).trim() }
  }
}

export async function gitStatus(root: string): Promise<GitStatusResult> {
  const probe = await git(root, ['rev-parse', '--is-inside-work-tree'])
  if (!probe.ok || probe.stdout.trim() !== 'true') {
    return { isRepo: false, files: [], error: probe.ok ? undefined : friendlyGitError(probe.stderr) }
  }
  const st = await git(root, ['status', '--porcelain=v1', '-z', '-b'])
  if (!st.ok) return { isRepo: true, files: [], error: st.stderr }
  const parsed = parseStatusZ(st.stdout)
  return { isRepo: true, branch: parsed.branch, ahead: parsed.ahead, behind: parsed.behind, files: parsed.files }
}

function friendlyGitError(err: string): string {
  if (/ENOENT|not recognized|无法将|不是内部或外部命令/i.test(err)) return '未找到 git 命令，请先安装 Git 并加入 PATH。'
  return err
}

function looksBinary(s: string): boolean {
  return s.includes('\0')
}

/** 读某个版本的文件内容：rev 为 'HEAD' / ''（index 用 ':path'）；不存在返回 '' */
async function showFile(root: string, spec: string): Promise<string> {
  const r = await git(root, ['show', spec])
  return r.ok ? r.stdout : ''
}

/**
 * 单文件 diff 两侧文本（供 Monaco DiffEditor）：
 *  - staged：HEAD ↔ 暂存区（index）
 *  - 未暂存：暂存区（index）↔ 工作区（未跟踪文件 index 侧为空）
 */
export async function gitDiffFile(root: string, path: string, staged: boolean): Promise<GitDiffPayload> {
  let oldText: string
  let newText: string
  if (staged) {
    oldText = await showFile(root, `HEAD:${path}`)
    newText = await showFile(root, `:${path}`)
  } else {
    oldText = await showFile(root, `:${path}`)
    try {
      newText = await fs.readFile(join(root, path), 'utf-8')
    } catch {
      newText = '' // 已删除
    }
  }
  if (looksBinary(oldText) || looksBinary(newText)) {
    return { path, oldText: '（二进制文件，不展示内容）', newText: '（二进制文件，不展示内容）' }
  }
  const clip = (s: string): string => (s.length > 400_000 ? s.slice(0, 400_000) + '\n…（已截断）' : s)
  return { path, oldText: clip(oldText), newText: clip(newText) }
}

export async function gitStage(root: string, paths: string[]): Promise<GitOpResult> {
  if (!paths.length) return { ok: false, error: '未指定文件' }
  const r = await git(root, ['add', '--', ...paths])
  return r.ok ? { ok: true } : { ok: false, error: r.stderr }
}

export async function gitUnstage(root: string, paths: string[]): Promise<GitOpResult> {
  if (!paths.length) return { ok: false, error: '未指定文件' }
  let r = await git(root, ['reset', 'HEAD', '--', ...paths])
  // 仓库尚无任何提交（无 HEAD）时改用 rm --cached
  if (!r.ok && /unknown revision|ambiguous argument 'HEAD'/i.test(r.stderr)) {
    r = await git(root, ['rm', '--cached', '-r', '--', ...paths])
  }
  return r.ok ? { ok: true } : { ok: false, error: r.stderr }
}

/** 丢弃工作区改动（仅限已跟踪文件；未跟踪文件不删除，避免误删用户数据） */
export async function gitDiscard(root: string, path: string): Promise<GitOpResult> {
  const r = await git(root, ['checkout', '--', path])
  if (!r.ok && /did not match any file|pathspec/i.test(r.stderr)) {
    return { ok: false, error: '该文件未被 Git 跟踪，请手动删除（面板不代删未跟踪文件）。' }
  }
  return r.ok ? { ok: true } : { ok: false, error: r.stderr }
}

export async function gitCommit(root: string, message: string): Promise<GitOpResult> {
  const msg = message.trim()
  if (!msg) return { ok: false, error: '提交信息不能为空' }
  const r = await git(root, ['commit', '-m', msg])
  return r.ok ? { ok: true, output: r.stdout.trim() } : { ok: false, error: r.stderr || r.stdout }
}

export async function gitLog(root: string, n = 30): Promise<GitLogEntry[]> {
  const r = await git(root, ['log', '-n', String(n), '--pretty=format:%h%x09%an%x09%ad%x09%s', '--date=format:%Y-%m-%d %H:%M'])
  if (!r.ok) return []
  return parseLog(r.stdout)
}

// ── AI：提交信息生成 / 变更评审 ─────────────────────────

/** 收集变更 diff：优先暂存区；为空则用全部工作区变更，并附带未跟踪新文件正文（有限量） */
async function collectDiff(root: string, preferStaged: boolean): Promise<{ diff: string; scope: string }> {
  let diff = ''
  let scope = ''
  if (preferStaged) {
    diff = (await git(root, ['diff', '--cached'])).stdout
    scope = '已暂存的变更'
  }
  if (!diff.trim()) {
    diff = (await git(root, ['diff', 'HEAD'])).stdout
    if (!diff.trim()) diff = (await git(root, ['diff'])).stdout // 无 HEAD 的新仓库兜底
    scope = '全部工作区变更'
  }
  // 未跟踪的新文件不在 diff 里，补充其正文（限量）
  const st = await gitStatus(root)
  const untracked = st.files.filter(isUntracked).slice(0, MAX_UNTRACKED_FOR_AI)
  for (const f of untracked) {
    try {
      const body = await fs.readFile(join(root, f.path), 'utf-8')
      if (!looksBinary(body)) diff += `\n--- 新文件（未跟踪）: ${f.path} ---\n${body.slice(0, 8000)}\n`
    } catch {
      /* ignore */
    }
  }
  if (diff.length > DIFF_CLIP) diff = diff.slice(0, DIFF_CLIP) + '\n…（diff 过长已截断）'
  return { diff, scope }
}

async function askModel(system: string, user: string, mode: 'fast' | 'balanced'): Promise<string> {
  const client = getClient()
  const res: any = await withRetry(() =>
    client.chat.completions.create({
      model: modelFor(mode),
      thinking: mode === 'fast' ? { type: 'disabled' } : { type: 'enabled', reasoning_effort: 'high' },
      temperature: 0.3,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    } as any)
  )
  return res.choices?.[0]?.message?.content?.trim() ?? ''
}

/** AI 生成提交信息（基于暂存区 diff；为空则用全部变更） */
export async function gitGenCommitMessage(root: string): Promise<GitAiResult> {
  try {
    const { diff } = await collectDiff(root, true)
    if (!diff.trim()) return { ok: false, error: '没有可提交的变更。' }
    const text = await askModel(
      '你是 Git 提交信息生成器。根据 diff 输出一条简洁的中文提交信息：首行为 Conventional Commits 格式（type(scope): 摘要，不超过 50 字），如改动较多可空一行后列 2-4 个要点。只输出提交信息本身，不要解释、不要代码块包裹。',
      diff,
      'fast'
    )
    if (!text) return { ok: false, error: '模型未返回内容' }
    return { ok: true, text }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** AI 变更评审：对当前全部变更（暂存 + 未暂存 + 未跟踪）产出结构化评审意见 */
export async function gitReviewChanges(root: string): Promise<GitAiResult> {
  try {
    const { diff, scope } = await collectDiff(root, false)
    if (!diff.trim()) return { ok: false, error: '没有可评审的变更。' }
    const text = await askModel(
      '你是严格但务实的代码评审者。基于给出的 diff 做变更评审，用中文 Markdown 输出，结构：\n' +
        '## 总体评价（1-2 句）\n## 问题（按严重度排序，引用文件与行；没有则明确说"未发现明显问题"）\n## 建议（可选的改进点）\n' +
        '只评审 diff 中出现的改动，不臆测未给出的代码；不要客套。',
      `评审范围：${scope}\n\n${diff}`,
      'balanced'
    )
    if (!text) return { ok: false, error: '模型未返回内容' }
    return { ok: true, text }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}
