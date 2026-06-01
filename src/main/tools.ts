import { promises as fs } from 'node:fs'
import { join, resolve, relative, sep, dirname } from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { EditPreview } from '@shared/types'
import { listSkills, readSkill } from './skills'
import { searchCode, updateFile } from './codeindex'

const execAsync = promisify(exec)

// 工具层：全部限定在当前项目根目录内执行（防目录穿越）。
// 读类工具自动放行；写/执行类工具需经权限审批（见 agent.ts）。

const IGNORE = new Set(['node_modules', '.git', 'out', 'dist', '.next', '.cache', 'build'])
const MAX_READ = 200_000 // 单文件读取上限（字符）
const MAX_GREP_MATCHES = 80

export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'run_command'])

// 会杀死应用自身的命令（按映像名/进程名批量杀 node/electron）——一律硬拒绝
const APP_KILLER_RE = [
  /taskkill\b[^|&;]*\/im\s+["']?node(\.exe)?["']?/i,
  /taskkill\b[^|&;]*\/im\s+["']?electron(\.exe)?["']?/i,
  /taskkill\b[^|&;]*\/im\s+["']?seekcode/i,
  /\b(killall|pkill)\b[^|&;\n]*\b(node|electron|seekcode)\b/i
]
export function isAppKiller(cmd: string): boolean {
  return APP_KILLER_RE.some((re) => re.test(cmd))
}

// 危险命令（可能造成不可逆破坏）——即使全自动也强制弹审批
const DANGEROUS_RE = [
  /\brm\s+-[a-z]*[rf]/i,
  /\bdel\s+\/[a-z]/i,
  /\brmdir\s+\/s/i,
  /\bformat\b/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-z]*[fd]/i,
  /\b(taskkill|kill|pkill|killall)\b/i,
  />\s*\/dev\/(sd|hd|disk)/i
]
export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_RE.some((re) => re.test(cmd))
}

export interface ToolContext {
  root: string
}

export const toolDefs = [
  {
    type: 'function' as const,
    function: {
      name: 'list_dir',
      description: '列出某个目录下的文件与子目录（相对项目根路径，默认根目录）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对项目根的目录路径，默认 "."' } }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: '读取一个文本文件的内容（相对项目根路径）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'grep',
      description: '在项目内按正则搜索文本，返回命中的文件与行。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          path: { type: 'string', description: '搜索子目录，默认全项目' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_code',
      description:
        '语义/词法检索整个代码库（BM25），按相关度返回最相关的文件与命中行。大型项目里优先用它定位，而非逐个 read_file。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '自然语言或关键字查询' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: '创建或覆盖写入一个文件（相对项目根路径）。需用户批准。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: '把文件中的 old_string 精确替换为 new_string（old_string 必须唯一匹配）。需用户批准。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: '在项目根目录执行一条 shell 命令（如运行测试、安装依赖）。需用户批准。',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_skills',
      description: '列出可用技能（领域知识/工作流），返回每个技能的 id、名称与说明。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_skill',
      description: '读取某个技能的完整内容（id 来自 list_skills），据此执行相应工作流。',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    }
  }
]

function safe(root: string, p: string): string {
  const abs = resolve(root, p || '.')
  const rel = relative(root, abs)
  if (rel === '..' || rel.startsWith('..' + sep) || rel.startsWith('../')) {
    throw new Error(`拒绝访问项目目录之外的路径: ${p}`)
  }
  return abs
}

export function summarize(name: string, args: Record<string, any>): string {
  switch (name) {
    case 'write_file':
      return `写入文件 ${args.path}（${(args.content ?? '').length} 字符）`
    case 'edit_file':
      return `编辑文件 ${args.path}`
    case 'run_command':
      return `执行命令: ${args.command}`
    default:
      return name
  }
}

/** 计算写入/编辑的 diff 预览（供审查 UI 使用） */
export async function previewEdit(
  name: string,
  args: Record<string, any>,
  root: string
): Promise<EditPreview | null> {
  if (name !== 'write_file' && name !== 'edit_file') return null
  let abs: string
  try {
    abs = safe(root, args.path)
  } catch {
    return null
  }
  let oldText = ''
  let isNew = false
  try {
    oldText = await fs.readFile(abs, 'utf-8')
  } catch {
    isNew = true
  }
  if (name === 'write_file') {
    return { path: args.path, oldText, newText: args.content ?? '', isNew }
  }
  const oldStr = args.old_string ?? ''
  const idx = oldText.indexOf(oldStr)
  if (idx === -1) return { path: args.path, oldText, newText: oldText, isNew: false }
  const newText = oldText.slice(0, idx) + (args.new_string ?? '') + oldText.slice(idx + oldStr.length)
  return { path: args.path, oldText, newText, isNew }
}

export async function execute(name: string, args: Record<string, any>, ctx: ToolContext): Promise<string> {
  switch (name) {
    case 'list_dir':
      return listDir(ctx.root, args.path ?? '.')
    case 'read_file':
      return readFile(ctx.root, args.path)
    case 'grep':
      return grep(ctx.root, args.pattern, args.path ?? '.')
    case 'search_code':
      return searchCodeTool(ctx.root, args.query ?? '')
    case 'write_file':
      return writeFile(ctx.root, args.path, args.content ?? '')
    case 'edit_file':
      return editFile(ctx.root, args.path, args.old_string, args.new_string)
    case 'run_command':
      return runCommand(ctx.root, args.command)
    case 'list_skills': {
      const ss = listSkills(ctx.root)
      return ss.length ? ss.map((x) => `${x.id} — ${x.name}：${x.description}`).join('\n') : '（暂无可用技能）'
    }
    case 'read_skill':
      return readSkill(ctx.root, args.id) ?? '未找到该技能'
    default:
      throw new Error(`未知工具: ${name}`)
  }
}

async function listDir(root: string, p: string): Promise<string> {
  const abs = safe(root, p)
  const entries = await fs.readdir(abs, { withFileTypes: true })
  const lines = entries
    .filter((e) => !IGNORE.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  return lines.length ? lines.join('\n') : '(空目录)'
}

async function readFile(root: string, p: string): Promise<string> {
  const abs = safe(root, p)
  const buf = await fs.readFile(abs, 'utf-8')
  const text = buf.length > MAX_READ ? buf.slice(0, MAX_READ) + '\n... (已截断)' : buf
  const numbered = text
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(4)}  ${l}`)
    .join('\n')
  return numbered
}

async function writeFile(root: string, p: string, content: string): Promise<string> {
  const abs = safe(root, p)
  await fs.mkdir(dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf-8')
  void updateFile(root, p) // 增量更新索引，不整库失效
  return `已写入 ${p}（${content.length} 字符）`
}

async function editFile(root: string, p: string, oldStr: string, newStr: string): Promise<string> {
  const abs = safe(root, p)
  const cur = await fs.readFile(abs, 'utf-8')
  const idx = cur.indexOf(oldStr)
  if (idx === -1) throw new Error('未找到 old_string，文件未改动。请先 read_file 确认确切内容。')
  if (cur.indexOf(oldStr, idx + 1) !== -1) throw new Error('old_string 匹配到多处，需提供更长的唯一片段。')
  await fs.writeFile(abs, cur.slice(0, idx) + newStr + cur.slice(idx + oldStr.length), 'utf-8')
  void updateFile(root, p) // 增量更新索引，不整库失效
  return `已编辑 ${p}`
}

async function searchCodeTool(root: string, query: string): Promise<string> {
  if (!query.trim()) return '请提供查询内容。'
  const hits = await searchCode(root, query, 8)
  if (!hits.length) return '(无相关结果)'
  return hits
    .map((h) => `${h.path}  [相关度 ${h.score.toFixed(1)}]\n` + h.lines.map((l) => `  ${l.n}: ${l.text}`).join('\n'))
    .join('\n\n')
}

async function grep(root: string, pattern: string, sub: string): Promise<string> {
  let re: RegExp
  try {
    re = new RegExp(pattern, 'g')
  } catch {
    return `非法正则: ${pattern}`
  }
  const base = safe(root, sub)
  const hits: string[] = []
  const files: string[] = []
  await collect(base, files)
  for (const f of files) {
    if (hits.length >= MAX_GREP_MATCHES) break
    let content: string
    try {
      content = await fs.readFile(f, 'utf-8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length && hits.length < MAX_GREP_MATCHES; i++) {
      re.lastIndex = 0
      if (re.test(lines[i])) hits.push(`${relative(root, f)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
    }
  }
  return hits.length ? hits.join('\n') : '(无匹配)'
}

async function collect(dir: string, out: string[]): Promise<void> {
  let entries: any[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await collect(full, out)
    else if (out.length < 5000) out.push(full)
  }
}

async function runCommand(root: string, command: string): Promise<string> {
  if (isAppKiller(command)) {
    return '⛔ 已拒绝：该命令会按名批量杀死所有 Node/Electron 进程，包括 SeekCode 应用自身。请改用精确方式：先用 `netstat -ano | findstr :<端口>`（Windows）或 `lsof -i :<端口>`（macOS/Linux）找到目标进程的 PID，再用 `taskkill /f /pid <PID>`（Windows）或 `kill <PID>`（Unix）精确结束。'
  }
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: root,
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 8,
      windowsHide: true
    })
    const out = (stdout || '').trim()
    const err = (stderr || '').trim()
    return [out && `stdout:\n${out}`, err && `stderr:\n${err}`].filter(Boolean).join('\n\n') || '(命令完成，无输出)'
  } catch (e: any) {
    return `命令失败（exit ${e.code ?? '?'}）：\n${(e.stdout || '').trim()}\n${(e.stderr || e.message || '').trim()}`
  }
}
