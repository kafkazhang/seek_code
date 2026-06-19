import { promises as fs } from 'node:fs'
import { join, resolve, relative, sep, dirname } from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { EditPreview } from '@shared/types'
import { listSkills, readSkill } from './skills'
import { updateFile } from './codeindex'
import { hybridSearch } from './vecindex'
import { isAppKiller, isDangerousCommand } from './cmdsafety'
import { applyEdit, applyEdits, balanceCheck, BatchEdit, fileOutline, globToRegex } from './editing'
import { clipCheckOutput, detectChecks } from './checks'
import { startBg, readBg, killBg } from './bgproc'
import { isValidSymbol, SymbolHit } from './symbols'
import { findSymbolHits } from './codeindex'

const execAsync = promisify(exec)

// 工具层：全部限定在当前项目根目录内执行（防目录穿越）。
// 读类工具自动放行；写/执行类工具需经权限审批（见 agent.ts）。

const IGNORE = new Set(['node_modules', '.git', 'out', 'dist', '.next', '.cache', 'build', 'target'])
const MAX_READ = 200_000 // 单文件读取上限（字符）
const MAX_READ_LINES = 1500 // 无行号区间时单次最多返回的行数（引导分段读）
const MAX_GREP_MATCHES = 80
const MAX_FIND_RESULTS = 100

export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'run_command', 'project_check', 'run_background'])
/** 会执行命令的工具（acceptEdits 模式下仍需审批） */
export const COMMAND_TOOLS = new Set(['run_command', 'project_check', 'run_background'])

// 命令安全分类已抽离至纯模块 cmdsafety.ts（便于单测），此处转出以兼容既有引用。
export { isAppKiller, isDangerousCommand }

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
      description:
        '读取文本文件内容（相对项目根路径），输出带行号。大文件务必用 start_line/end_line 分段读取，配合 file_outline 先看结构。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'integer', description: '起始行（1 起，含）' },
          end_line: { type: 'integer', description: '结束行（含）' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'grep',
      description: '在项目内按正则搜索文本，返回命中的文件与行；可按 glob 过滤文件、带上下文行。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          path: { type: 'string', description: '搜索子目录，默认全项目' },
          glob: { type: 'string', description: '文件过滤，如 *.ts 或 src/**/*.vue' },
          context: { type: 'integer', description: '每个命中附带的上下文行数（0-5，默认 0）' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_files',
      description: '按 glob 模式查找文件路径（如 **/*.test.ts、src/**/index.*、*.json）。只返回路径，不读内容。',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string', description: 'glob 模式；不含 / 时匹配任意目录下的文件名' } },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'file_outline',
      description: '提取单个文件的符号大纲（行号 + function/class/type…），不读全文即可了解文件结构，再用 read_file 的行号区间精读。',
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
      name: 'find_definition',
      description: '查找符号（函数/类/类型/变量）的定义位置，返回文件、行号与定义行。比 grep 更准：会按语言规则识别定义行。',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string', description: '符号名（标识符，如 getUserName）' } },
        required: ['symbol']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_references',
      description:
        '查找符号的全部引用（词边界精确匹配，按文件分组，标注疑似定义行）。修改函数签名/重命名/删除前必查，确保改全所有调用点。',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string', description: '符号名（标识符）' } },
        required: ['symbol']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_code',
      description:
        '检索整个代码库（BM25 词法 + 语义向量混合召回，自动按可用性降级），按相关度返回最相关的文件与命中行。大型项目里优先用它定位，而非逐个 read_file。',
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
      description:
        '把文件中的 old_string 替换为 new_string。优先精确匹配；失败时自动做忽略缩进的容错匹配；仍失败会返回文件中最相近的片段供你修正。old_string 需唯一（带足上下文行），重复出现时可传 replace_all。需用户批准。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean', description: '替换全部匹配处（默认 false）' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'multi_edit',
      description:
        '对同一文件一次性应用多处编辑（按顺序执行，原子性：任何一处失败则整体不生效、文件不变）。同文件多处修改时优先用它，少走回合。需用户批准。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          edits: {
            type: 'array',
            description: '编辑列表，按顺序应用（后面的编辑作用在前面编辑后的内容上）',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string' },
                new_string: { type: 'string' },
                replace_all: { type: 'boolean' }
              },
              required: ['old_string', 'new_string']
            }
          }
        },
        required: ['path', 'edits']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: '在项目根目录执行一条 shell 命令（如运行测试、安装依赖）。可设 timeout_sec（默认 120，最大 300）。需用户批准。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_sec: { type: 'integer', description: '超时秒数（5-300，默认 120）' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'project_check',
      description:
        '自动探测并运行本项目的质量门命令（package.json 的 typecheck/lint/test 脚本、cargo check、go vet 等），返回各项通过/失败与报错摘要。完成代码改动后用它自检，失败则继续修复。需用户批准。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_background',
      description:
        '后台启动常驻命令（dev server / watch / 长任务），立即返回进程 id 与初始输出，不阻塞后续操作。配合 bg_output 看日志、bg_kill 结束。一次性命令（构建/测试）请用 run_command。需用户批准。',
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
      name: 'bg_output',
      description: '读取后台进程的最新输出（含运行状态）。如等待 dev server 就绪日志、查看报错。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'run_background 返回的进程 id' },
          tail_chars: { type: 'integer', description: '返回末尾多少字符（默认 4000）' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'bg_kill',
      description: '结束一个后台进程（含其子进程树）。任务验证完毕后务必清理自己启动的后台进程。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'todo_write',
      description:
        '维护本回合的任务清单（整表替换）。多步任务开始时列出全部步骤；每完成一步立即更新状态再继续。status: pending | in_progress（同时最多一项）| completed。传空数组清空。',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '完整的任务清单（替换旧表）',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '任务内容（具体、可验收）' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
              },
              required: ['content']
            }
          }
        },
        required: ['todos']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_fetch',
      description:
        '联网读取一个网页/文档 URL 并转为纯文本（GET，不发送任何用户代码）。检测到纯 JS 渲染的 SPA 时会自动用内置沙箱浏览器渲染后提取正文。仅在确需外部资料时使用：查报错含义、库 API 文档、版本变更说明。每个新域名需用户批准（含全自动模式）。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整 http(s) URL' },
          max_chars: { type: 'integer', description: '返回正文截断长度（默认 8000，最大 30000）' },
          render: {
            type: 'boolean',
            description: '强制用沙箱浏览器渲染后提取（已知是 SPA / 上次静态抓取为空壳时传 true）'
          }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'spawn_subagents',
      description:
        '把多个互相独立、可并行的子任务委派给子代理并发执行（1-6 个，最多 3 个同时运行），全部完成后返回各自的结果报告汇总。子代理与你使用同一套文件/命令工具，写入与命令同样受当前权限模式管控（审批会上浮给用户）。适合：大范围代码调研分摊、多文件批量改造、多个互不依赖的功能点并行实现。注意：子代理看不到本对话历史，每个 goal 必须自包含（写清楚背景、目标文件、验收标准）；有先后依赖的步骤不要拆给子代理。',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: '子任务列表（1-6 个）',
            items: {
              type: 'object',
              properties: {
                goal: { type: 'string', description: '自包含的子任务目标描述' }
              },
              required: ['goal']
            }
          }
        },
        required: ['tasks']
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
    case 'multi_edit':
      return `批量编辑 ${args.path}（${Array.isArray(args.edits) ? args.edits.length : 0} 处）`
    case 'run_command':
      return `执行命令: ${args.command}`
    case 'project_check':
      return '运行项目质量检查（typecheck / lint / test）'
    case 'run_background':
      return `后台启动常驻命令: ${args.command}`
    case 'web_fetch':
      return `联网读取: ${args.url}（仅 GET 该地址，host 将加入本会话信任出口）`
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
  if (name !== 'write_file' && name !== 'edit_file' && name !== 'multi_edit') return null
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
  // 与实际执行同一套匹配逻辑（含缩进容错），保证审批看到的 diff 即最终结果
  if (name === 'multi_edit') {
    const r = applyEdits(oldText, Array.isArray(args.edits) ? (args.edits as BatchEdit[]) : [])
    return { path: args.path, oldText, newText: r.ok ? r.content! : oldText, isNew: false }
  }
  const r = applyEdit(oldText, args.old_string ?? '', args.new_string ?? '', args.replace_all === true)
  return { path: args.path, oldText, newText: r.ok ? r.content! : oldText, isNew: false }
}

export async function execute(name: string, args: Record<string, any>, ctx: ToolContext): Promise<string> {
  switch (name) {
    case 'list_dir':
      return listDir(ctx.root, args.path ?? '.')
    case 'read_file':
      return readFile(ctx.root, args.path, args.start_line, args.end_line)
    case 'grep':
      return grep(ctx.root, args.pattern, args.path ?? '.', args.glob, args.context)
    case 'find_files':
      return findFiles(ctx.root, args.pattern ?? '')
    case 'file_outline':
      return fileOutlineTool(ctx.root, args.path)
    case 'search_code':
      return searchCodeTool(ctx.root, args.query ?? '')
    case 'write_file':
      return writeFile(ctx.root, args.path, args.content ?? '')
    case 'edit_file':
      return editFile(ctx.root, args.path, args.old_string, args.new_string, args.replace_all === true)
    case 'multi_edit':
      return multiEdit(ctx.root, args.path, Array.isArray(args.edits) ? args.edits : [])
    case 'run_command':
      return runCommand(ctx.root, args.command, args.timeout_sec)
    case 'project_check':
      return projectCheck(ctx.root)
    case 'run_background': {
      const cmd = String(args.command ?? '')
      if (isAppKiller(cmd)) return '⛔ 已拒绝：该命令会按名批量杀死 Node/Electron 进程（包括 SeekCode 自身）。'
      return startBg(ctx.root, cmd)
    }
    case 'bg_output':
      return readBg(String(args.id ?? ''), args.tail_chars)
    case 'bg_kill':
      return killBg(String(args.id ?? ''))
    case 'find_definition':
      return findDefinitionTool(ctx.root, String(args.symbol ?? ''))
    case 'find_references':
      return findReferencesTool(ctx.root, String(args.symbol ?? ''))
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

async function readFile(root: string, p: string, startLine?: number, endLine?: number): Promise<string> {
  const abs = safe(root, p)
  const buf = await fs.readFile(abs, 'utf-8')
  const lines = buf.split('\n')
  const total = lines.length

  // 行号区间读取（1 起，含端点）
  if (startLine !== undefined || endLine !== undefined) {
    const from = Math.max(1, Math.floor(startLine ?? 1))
    const to = Math.min(total, Math.floor(endLine ?? from + MAX_READ_LINES - 1))
    if (from > total) return `（起始行 ${from} 超出文件范围，全文共 ${total} 行）`
    const numbered = numberLines(lines.slice(from - 1, to), from)
    return `（${p} 共 ${total} 行，以下为第 ${from}-${to} 行）\n${numbered}`
  }

  // 全文读取：超长时只给开头并引导分段读
  if (total > MAX_READ_LINES || buf.length > MAX_READ) {
    const headLines = lines.slice(0, MAX_READ_LINES)
    let text = headLines.join('\n')
    if (text.length > MAX_READ) text = text.slice(0, MAX_READ)
    const shown = text.split('\n').length
    return (
      `（文件较大：共 ${total} 行，仅显示前 ${shown} 行。请用 start_line/end_line 分段读取后续，或先 file_outline 看结构）\n` +
      numberLines(text.split('\n'), 1)
    )
  }
  return numberLines(lines, 1)
}

function numberLines(lines: string[], from: number): string {
  return lines.map((l, i) => `${String(from + i).padStart(4)}  ${l}`).join('\n')
}

/** 写入后的轻量体检：JSON 解析 / 括号平衡，仅警告不拦截 */
function healthNote(p: string, content: string): string {
  const ext = p.split('.').pop() ?? ''
  const warn = balanceCheck(content, ext)
  return warn ? `\n⚠ 语法体检：${warn}` : ''
}

/** 变更区域回显：定位新旧内容首个差异行，返回新内容该处 ±ctx 行（带行号） */
function changedRegion(oldText: string, newText: string, ctx = 3): string {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const from = Math.max(0, i - ctx)
  const to = Math.min(b.length - 1, i + ctx)
  if (from > to) return ''
  return '\n变更区域（新内容）：\n' + numberLines(b.slice(from, to + 1), from + 1)
}

async function writeFile(root: string, p: string, content: string): Promise<string> {
  const abs = safe(root, p)
  await fs.mkdir(dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf-8')
  void updateFile(root, p) // 增量更新索引，不整库失效
  return `已写入 ${p}（${content.length} 字符）` + healthNote(p, content)
}

async function editFile(root: string, p: string, oldStr: string, newStr: string, replaceAll: boolean): Promise<string> {
  const abs = safe(root, p)
  const cur = await fs.readFile(abs, 'utf-8')
  const r = applyEdit(cur, oldStr ?? '', newStr ?? '', replaceAll)
  if (!r.ok) throw new Error(r.error + (r.hint ? `\n${r.hint}` : ''))
  await fs.writeFile(abs, r.content!, 'utf-8')
  void updateFile(root, p) // 增量更新索引，不整库失效
  return (
    `已编辑 ${p}（替换 ${r.count} 处${r.fuzzy ? '，经忽略缩进的容错匹配命中，请在变更区域核对缩进' : ''}）` +
    changedRegion(cur, r.content!) +
    healthNote(p, r.content!)
  )
}

async function multiEdit(root: string, p: string, edits: BatchEdit[]): Promise<string> {
  const abs = safe(root, p)
  const cur = await fs.readFile(abs, 'utf-8')
  const r = applyEdits(cur, edits)
  if (!r.ok) throw new Error(r.error + (r.hint ? `\n${r.hint}` : '') + '\n（原子性：整体未生效，文件未改动）')
  await fs.writeFile(abs, r.content!, 'utf-8')
  void updateFile(root, p)
  const total = r.counts!.reduce((s, n) => s + n, 0)
  return `已批量编辑 ${p}（${edits.length} 处编辑，共替换 ${total} 处）` + changedRegion(cur, r.content!) + healthNote(p, r.content!)
}

async function findFiles(root: string, pattern: string): Promise<string> {
  if (!pattern.trim()) return '请提供 glob 模式。'
  let matcher: { re: RegExp; baseNameOnly: boolean }
  try {
    matcher = globToRegex(pattern.trim().replace(/\\/g, '/'))
  } catch {
    return `非法 glob 模式: ${pattern}`
  }
  const files: string[] = []
  await collect(root, files)
  const hits: string[] = []
  for (const abs of files) {
    const rel = relative(root, abs).replace(/\\/g, '/')
    const target = matcher.baseNameOnly ? (rel.split('/').pop() ?? rel) : rel
    if (matcher.re.test(target)) {
      hits.push(rel)
      if (hits.length >= MAX_FIND_RESULTS) break
    }
  }
  if (!hits.length) return '(无匹配文件)'
  hits.sort()
  return hits.join('\n') + (hits.length >= MAX_FIND_RESULTS ? `\n…（已达 ${MAX_FIND_RESULTS} 条上限）` : '')
}

async function fileOutlineTool(root: string, p: string): Promise<string> {
  const abs = safe(root, p)
  const text = await fs.readFile(abs, 'utf-8')
  const ext = p.split('.').pop() ?? ''
  const total = text.split('\n').length
  const outline = fileOutline(text, ext)
  if (!outline.length) return `（${p} 共 ${total} 行；该文件类型不支持大纲提取或未发现符号，请直接 read_file）`
  return `${p}（共 ${total} 行）符号大纲：\n` + outline.join('\n')
}

// ── 符号导航 ─────────────────────────────────────────
async function findDefinitionTool(root: string, symbol: string): Promise<string> {
  const sym = symbol.trim()
  if (!isValidSymbol(sym)) return '符号名不合法：请传单个标识符（如 getUserName / CodeIndex），整段代码请用 grep。'
  const hits = await findSymbolHits(root, sym)
  const defs = hits.filter((h) => h.def)
  if (defs.length) {
    return (
      `${sym} 的定义（${defs.length} 处）：\n` +
      defs.slice(0, 10).map((h) => `${h.path}:${h.line}  ${h.text}`).join('\n')
    )
  }
  if (hits.length) {
    return (
      `未识别到明确的定义行，但找到 ${hits.length} 处出现（可能定义在不支持的语言或以重导出形式存在）：\n` +
      hits.slice(0, 10).map((h) => `${h.path}:${h.line}  ${h.text}`).join('\n')
    )
  }
  return `索引中未找到符号 ${sym}（可能拼写不同、在忽略目录或非代码文件中）。可改用 grep 或 search_code。`
}

async function findReferencesTool(root: string, symbol: string): Promise<string> {
  const sym = symbol.trim()
  if (!isValidSymbol(sym)) return '符号名不合法：请传单个标识符。'
  const hits = await findSymbolHits(root, sym)
  if (!hits.length) return `未找到 ${sym} 的任何引用。`
  // 按文件分组展示，定义行标注
  const byFile = new Map<string, SymbolHit[]>()
  for (const h of hits) {
    const arr = byFile.get(h.path) ?? []
    arr.push(h)
    byFile.set(h.path, arr)
  }
  const parts: string[] = []
  for (const [path, arr] of byFile) {
    parts.push(
      `${path}（${arr.length} 处）\n` +
        arr.map((h) => `  ${h.line}${h.def ? '(定义)' : ''}: ${h.text}`).join('\n')
    )
  }
  const defCount = hits.filter((h) => h.def).length
  return (
    `${sym} 共 ${hits.length} 处出现（${byFile.size} 个文件，含 ${defCount} 处疑似定义）${hits.length >= 50 ? '，已达上限可能不全' : ''}：\n\n` +
    parts.join('\n\n')
  )
}

/** 自动探测并运行项目质量门（typecheck / lint / test …），汇总通过/失败 */
async function projectCheck(root: string): Promise<string> {
  let pkg: string | null = null
  try {
    pkg = await fs.readFile(join(root, 'package.json'), 'utf-8')
  } catch {
    /* 无 package.json */
  }
  let entries: string[] = []
  try {
    entries = await fs.readdir(root)
  } catch {
    /* ignore */
  }
  const candidates = detectChecks(pkg, entries)
  if (!candidates.length) {
    return '未探测到可用的检查命令（package.json scripts 中无 typecheck/lint/test，亦无 Cargo.toml/go.mod）。可改用 run_command 运行你认为合适的验证命令。'
  }
  const parts: string[] = []
  let failed = 0
  for (const c of candidates) {
    try {
      const { stdout, stderr } = await execAsync(c.command, {
        cwd: root,
        timeout: 180_000,
        maxBuffer: 1024 * 1024 * 8,
        windowsHide: true
      })
      const tail = (stdout || stderr || '').trim().split('\n').slice(-2).join(' ').slice(0, 160)
      parts.push(`✓ ${c.label}（${c.command}）通过${tail ? ` · ${tail}` : ''}`)
    } catch (e: any) {
      failed++
      const out = clipCheckOutput(`${e?.stdout ?? ''}\n${e?.stderr ?? e?.message ?? ''}`)
      parts.push(`✗ ${c.label}（${c.command}）失败（exit ${e?.code ?? '?'}）：\n${out}`)
    }
  }
  const head = failed
    ? `检查完成：${candidates.length - failed}/${candidates.length} 通过。请修复以下失败项后再次 project_check：`
    : `检查完成：全部 ${candidates.length} 项通过 ✓`
  return head + '\n\n' + parts.join('\n\n')
}

async function searchCodeTool(root: string, query: string): Promise<string> {
  if (!query.trim()) return '请提供查询内容。'
  const { hits, mode } = await hybridSearch(root, query, 8)
  if (!hits.length) return '(无相关结果)'
  const head = mode === 'hybrid' ? '【混合召回：BM25 + 语义向量】\n' : ''
  return (
    head +
    hits
      .map((h) => `${h.path}  [相关度 ${h.score.toFixed(1)}]\n` + h.lines.map((l) => `  ${l.n}: ${l.text}`).join('\n'))
      .join('\n\n')
  )
}

async function grep(root: string, pattern: string, sub: string, glob?: string, context?: number): Promise<string> {
  let re: RegExp
  try {
    re = new RegExp(pattern, 'g')
  } catch {
    return `非法正则: ${pattern}`
  }
  let globMatcher: { re: RegExp; baseNameOnly: boolean } | null = null
  if (glob && glob.trim()) {
    try {
      globMatcher = globToRegex(glob.trim().replace(/\\/g, '/'))
    } catch {
      return `非法 glob: ${glob}`
    }
  }
  const ctx = Math.min(5, Math.max(0, Math.floor(context ?? 0)))
  const base = safe(root, sub)
  const blocks: string[] = []
  let matched = 0
  const files: string[] = []
  await collect(base, files)
  for (const f of files) {
    if (matched >= MAX_GREP_MATCHES) break
    const rel = relative(root, f).replace(/\\/g, '/')
    if (globMatcher) {
      const target = globMatcher.baseNameOnly ? (rel.split('/').pop() ?? rel) : rel
      if (!globMatcher.re.test(target)) continue
    }
    let content: string
    try {
      content = await fs.readFile(f, 'utf-8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length && matched < MAX_GREP_MATCHES; i++) {
      re.lastIndex = 0
      if (!re.test(lines[i])) continue
      matched++
      if (ctx === 0) {
        blocks.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
      } else {
        const from = Math.max(0, i - ctx)
        const to = Math.min(lines.length - 1, i + ctx)
        const seg: string[] = []
        for (let j = from; j <= to; j++) {
          seg.push(`${rel}:${j + 1}${j === i ? ':' : '-'} ${lines[j].slice(0, 200)}`)
        }
        blocks.push(seg.join('\n'))
      }
    }
  }
  if (!matched) return '(无匹配)'
  return blocks.join(ctx > 0 ? '\n--\n' : '\n') + (matched >= MAX_GREP_MATCHES ? `\n…（已达 ${MAX_GREP_MATCHES} 条上限，可加 glob/path 缩小范围）` : '')
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

async function runCommand(root: string, command: string, timeoutSec?: number): Promise<string> {
  if (isAppKiller(command)) {
    return '⛔ 已拒绝：该命令会按名批量杀死所有 Node/Electron 进程，包括 SeekCode 应用自身。请改用精确方式：先用 `netstat -ano | findstr :<端口>`（Windows）或 `lsof -i :<端口>`（macOS/Linux）找到目标进程的 PID，再用 `taskkill /f /pid <PID>`（Windows）或 `kill <PID>`（Unix）精确结束。'
  }
  const timeout = Math.min(300, Math.max(5, Math.floor(timeoutSec ?? 120))) * 1000
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: root,
      timeout,
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
