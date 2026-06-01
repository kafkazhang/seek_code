import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { SkillMeta, DiscoveredSkill } from '@shared/types'
import { guardedFetch } from './egress'

// 技能 = 目录（与 Claude Code / Kiro 等一致）：
//   <skills>/<name>/SKILL.md  + 可选脚本/资源文件
//   <skills>/<name>/.seek-source  记录安装来源（用于「更新」）
// 兼容旧版扁平 <skills>/<name>.md。
//   - 全局：userData/skills/
//   - 项目：<root>/.seek/skills/

const MAX = 16_000

function globalDir(): string {
  return join(app.getPath('userData'), 'skills')
}
function projectDir(root: string): string {
  return join(root, '.seek', 'skills')
}
function baseFor(scope: 'global' | 'project', root: string | null): string | null {
  return scope === 'global' ? globalDir() : root ? projectDir(root) : null
}
function sanitize(name: string): string {
  return (name || 'skill').replace(/\.md$/i, '').replace(/[^\w.\-一-鿿]/g, '_').slice(0, 64) || 'skill'
}

function parseMeta(md: string): { name: string; description: string } {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    const block = fm[1]
    const n = block.match(/^name:\s*(.+)$/m)
    const d = block.match(/^description:\s*(.+)$/m)
    const strip = (s: string): string => s.trim().replace(/^["']|["']$/g, '')
    const name = n ? strip(n[1]) : ''
    const description = d ? strip(d[1]).slice(0, 120) : ''
    if (name || description) return { name, description }
  }
  let name = ''
  let description = ''
  for (const raw of md.split('\n')) {
    const t = raw.trim()
    if (t.startsWith('<!--')) continue
    if (!name && t.startsWith('#')) {
      name = t.replace(/^#+\s*/, '').trim()
      continue
    }
    if (name && !description && t) {
      description = t.replace(/^>\s*/, '').slice(0, 120)
      break
    }
  }
  return { name, description }
}

function scanDir(baseDir: string, scope: 'global' | 'project'): { meta: SkillMeta; content: string }[] {
  if (!existsSync(baseDir)) return []
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = readdirSync(baseDir, { withFileTypes: true }) as any
  } catch {
    return []
  }
  const out: { meta: SkillMeta; content: string }[] = []
  for (const e of entries) {
    try {
      if (e.isDirectory()) {
        const md = join(baseDir, e.name, 'SKILL.md')
        if (!existsSync(md)) continue
        const content = readFileSync(md, 'utf-8').slice(0, MAX)
        const { name, description } = parseMeta(content)
        const srcFile = join(baseDir, e.name, '.seek-source')
        const source = existsSync(srcFile) ? readFileSync(srcFile, 'utf-8').trim() : undefined
        out.push({ meta: { id: `${scope}:${e.name}`, name: name || e.name, description, scope, source }, content })
      } else if (e.name.endsWith('.md')) {
        // 旧版扁平 .md
        const content = readFileSync(join(baseDir, e.name), 'utf-8').slice(0, MAX)
        const { name, description } = parseMeta(content)
        const base = e.name.replace(/\.md$/, '')
        const sm = content.match(/<!--\s*seek:source\s+(\S+)\s*-->/)
        out.push({ meta: { id: `${scope}:${base}`, name: name || base, description, scope, source: sm?.[1] }, content })
      }
    } catch {
      /* skip */
    }
  }
  return out
}

function all(root: string | null): { meta: SkillMeta; content: string }[] {
  return [...scanDir(globalDir(), 'global'), ...(root ? scanDir(projectDir(root), 'project') : [])]
}

export function listSkills(root: string | null): SkillMeta[] {
  return all(root).map((x) => x.meta)
}
export function readSkill(root: string | null, id: string): string | null {
  return all(root).find((x) => x.meta.id === id)?.content ?? null
}

/** 手动 / 单文件技能：写入 <skills>/<name>/SKILL.md */
export function saveSkill(
  scope: 'global' | 'project',
  filename: string,
  content: string,
  root: string | null,
  source?: string
): boolean {
  const base = baseFor(scope, root)
  if (!base) return false
  try {
    const name = sanitize(filename)
    const dir = join(base, name)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8')
    if (source) writeFileSync(join(dir, '.seek-source'), source, 'utf-8')
    return true
  } catch {
    return false
  }
}

export function deleteSkill(id: string, root: string | null): boolean {
  const [scope, name] = id.split(':')
  const base = baseFor(scope as 'global' | 'project', root)
  if (!base) return false
  try {
    const dir = join(base, name)
    if (existsSync(join(dir, 'SKILL.md'))) {
      rmSync(dir, { recursive: true, force: true })
      return true
    }
    rmSync(join(base, name + '.md'), { force: true })
    return true
  } catch {
    return false
  }
}

// ── 网络安装 ──
async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await guardedFetch(url)
    if (!res.ok) return null
    const t = await res.text()
    return t.trim() ? t : null
  } catch {
    return null
  }
}
async function fetchJson(url: string): Promise<any> {
  try {
    const res = await guardedFetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SeekCode' }
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

interface GH {
  o: string
  r: string
  branch: string
  path: string
  kind: 'tree' | 'blob' | 'raw'
}
function parseGithub(url: string): GH | null {
  let m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/)
  if (m) return { o: m[1], r: m[2], branch: m[3], path: m[4].replace(/\/+$/, ''), kind: 'tree' }
  m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/)
  if (m) return { o: m[1], r: m[2], branch: m[3], path: m[4], kind: 'blob' }
  m = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/)
  if (m) return { o: m[1], r: m[2], branch: m[3], path: m[4], kind: 'raw' }
  return null
}

/** 下载 GitHub 仓库中某目录的全部文件（含脚本/资源），保持结构写入 destDir */
async function downloadGithubDir(
  gh: { o: string; r: string; branch: string },
  dirPath: string,
  destDir: string,
  source: string
): Promise<{ ok: boolean; files?: number; error?: string }> {
  const tree = await fetchJson(`https://api.github.com/repos/${gh.o}/${gh.r}/git/trees/${gh.branch}?recursive=1`)
  if (!tree?.tree) return { ok: false, error: '无法读取仓库目录树' }
  const prefix = dirPath ? dirPath + '/' : ''
  const blobs: { path: string; size?: number }[] = tree.tree.filter(
    (t: any) => t.type === 'blob' && (dirPath ? t.path.startsWith(prefix) : true)
  )
  if (!blobs.length) return { ok: false, error: '目录为空或不存在' }
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
  let files = 0
  for (const b of blobs.slice(0, 200)) {
    if ((b.size ?? 0) > 2_000_000) continue
    const rel = b.path.slice(prefix.length)
    if (!rel) continue
    try {
      const res = await guardedFetch(`https://raw.githubusercontent.com/${gh.o}/${gh.r}/${gh.branch}/${b.path}`)
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      const dest = join(destDir, rel)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, buf)
      files++
    } catch {
      /* skip one file */
    }
  }
  // 确保有 SKILL.md（无则用 README 兜底）
  if (!existsSync(join(destDir, 'SKILL.md'))) {
    const readme = ['README.md', 'readme.md'].map((f) => join(destDir, f)).find((p) => existsSync(p))
    if (readme) writeFileSync(join(destDir, 'SKILL.md'), readFileSync(readme))
    else return { ok: false, error: '该目录不含 SKILL.md' }
  }
  writeFileSync(join(destDir, '.seek-source'), source, 'utf-8')
  return { ok: true, files }
}

/** 从 URL 安装技能：GitHub 目录(tree)/SKILL.md → 整目录下载；单个 .md/直链 → 包成目录 */
export async function installSkillFromUrl(
  url: string,
  scope: 'global' | 'project',
  root: string | null
): Promise<{ ok: boolean; name?: string; error?: string }> {
  try {
    const u = url.trim().replace(/\/+$/, '')
    const base = baseFor(scope, root)
    if (!base) return { ok: false, error: '无法确定安装目录' }
    const gh = parseGithub(u)
    if (gh) {
      const isSkillMd = /(^|\/)SKILL\.md$/i.test(gh.path)
      if (gh.kind === 'tree' || isSkillMd) {
        const dirPath = gh.kind === 'tree' ? gh.path : gh.path.replace(/\/?SKILL\.md$/i, '')
        const name = sanitize(dirPath.split('/').filter(Boolean).pop() || gh.r)
        const res = await downloadGithubDir(gh, dirPath, join(base, name), u)
        return res.ok ? { ok: true, name } : { ok: false, error: res.error }
      }
      // 单个 .md 文件
      const raw = gh.kind === 'blob' ? `https://raw.githubusercontent.com/${gh.o}/${gh.r}/${gh.branch}/${gh.path}` : u
      const content = await fetchText(raw)
      if (!content) return { ok: false, error: '无法获取文件内容' }
      const meta = parseMeta(content)
      const name = sanitize(meta.name || gh.path.split('/').pop()?.replace(/\.[^.]+$/, '') || 'skill')
      return saveSkill(scope, name, content, root, u) ? { ok: true, name } : { ok: false, error: '保存失败' }
    }
    // 非 GitHub 直链
    const content = await fetchText(u)
    if (!content) return { ok: false, error: '无法获取内容' }
    if (content.length > 200_000) return { ok: false, error: '文件过大（>200KB）' }
    const meta = parseMeta(content)
    const name = sanitize(meta.name || u.split('/').pop()?.replace(/\.[^.]+$/, '') || 'skill')
    return saveSkill(scope, name, content, root, u) ? { ok: true, name } : { ok: false, error: '保存失败' }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** 更新有来源的技能（重新拉取，目录技能会整目录刷新） */
export async function updateSkill(id: string, root: string | null): Promise<{ ok: boolean; error?: string }> {
  const item = all(root).find((x) => x.meta.id === id)
  const source = item?.meta.source
  if (!source) return { ok: false, error: '该技能无来源，无法更新' }
  const r = await installSkillFromUrl(source, id.startsWith('project:') ? 'project' : 'global', root)
  return { ok: r.ok, error: r.error }
}

/** 扫描 GitHub 仓库，发现所有含 SKILL.md 的技能目录 */
export async function discoverRepoSkills(
  repoUrl: string
): Promise<{ ok: boolean; skills?: DiscoveredSkill[]; error?: string }> {
  const m = repoUrl
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/tree\/[^/]+(?:\/.*)?)?$/)
  if (!m) return { ok: false, error: '请提供 GitHub 仓库地址，如 https://github.com/owner/repo' }
  const [, o, r] = m
  try {
    const info = await fetchJson(`https://api.github.com/repos/${o}/${r}`)
    if (!info) return { ok: false, error: '无法访问仓库' }
    const branch = info.default_branch || 'main'
    const tree = await fetchJson(`https://api.github.com/repos/${o}/${r}/git/trees/${branch}?recursive=1`)
    if (!tree?.tree) return { ok: false, error: '无法读取仓库树' }
    const blobs = tree.tree.filter((t: any) => t.type === 'blob' && /(^|\/)SKILL\.md$/i.test(t.path))
    const skills: DiscoveredSkill[] = blobs.slice(0, 100).map((t: any) => {
      const dir = t.path.replace(/\/?SKILL\.md$/i, '')
      return {
        id: `${o}/${r}:${dir || '.'}`,
        name: dir.split('/').pop() || r,
        dir: dir || '(根目录)',
        url: `https://github.com/${o}/${r}/tree/${branch}/${dir}`
      }
    })
    if (!skills.length) return { ok: false, error: '仓库中未发现 SKILL.md' }
    return { ok: true, skills }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** 首次运行写入示例技能（目录形式） */
export function seedSkills(): void {
  const dir = globalDir()
  if (existsSync(dir)) return
  try {
    const write = (name: string, body: string): void => {
      mkdirSync(join(dir, name), { recursive: true })
      writeFileSync(join(dir, name, 'SKILL.md'), body, 'utf-8')
    }
    write(
      'code-review',
      '# 代码审查\n> 对改动做结构化审查\n\n关注：正确性、边界条件、错误处理、命名、重复代码、性能与安全。\n按「问题 — 位置 — 建议」逐条列出，最后给总体结论与优先级。'
    )
    write(
      'commit-message',
      '# 提交信息\n> 生成规范的 commit message\n\n采用 Conventional Commits：`type(scope): 简述`。\ntype ∈ feat/fix/docs/refactor/test/chore/perf。'
    )
  } catch {
    /* ignore */
  }
}
