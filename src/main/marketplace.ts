import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CatalogEntry } from '@shared/types'
import { addMcpServer } from './mcp'
import { saveSkill, listSkills, installSkillFromUrl } from './skills'
import { guardedFetch } from './egress'

// 默认市场目录（内置、可离线浏览）。搜索由渲染层在返回结果上过滤。
// MCP 一键写入 mcp.json 并连接；技能一键安装（内置内容直接落地 / 云端 URL 拉取）。

interface McpDef {
  id: string
  name: string // 作为 mcp.json 中的服务器键名
  description: string
  market: string
  tags: string[]
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  needsConfig?: string
  useRoot?: boolean
  fields?: { key: string; label: string; kind: 'env' | 'arg'; placeholder?: string }[]
  homepage?: string
  version?: string
}
interface SkillDef {
  id: string
  name: string
  description: string
  market: string
  tags: string[]
  content?: string
  url?: string
  homepage?: string
}

const MCP_CATALOG: McpDef[] = [
  {
    id: 'filesystem',
    name: 'filesystem',
    description: '读写本地文件系统（限定目录）',
    market: 'MCP 官方',
    tags: ['文件', '本地'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    useRoot: true,
    fields: [{ key: 'path', label: '可访问目录', kind: 'arg', placeholder: '留空＝当前项目目录' }]
  },
  {
    id: 'memory',
    name: 'memory',
    description: '基于知识图谱的持久记忆',
    market: 'MCP 官方',
    tags: ['记忆'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory']
  },
  {
    id: 'sequential-thinking',
    name: 'sequential-thinking',
    description: '结构化分步推理工具',
    market: 'MCP 官方',
    tags: ['推理'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking']
  },
  {
    id: 'github',
    name: 'github',
    description: '操作 GitHub 仓库 / Issue / PR',
    market: 'MCP 官方',
    tags: ['Git', '云服务'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    needsConfig: '需 GitHub 访问令牌',
    fields: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub Token', kind: 'env', placeholder: 'ghp_...' }]
  },
  {
    id: 'brave-search',
    name: 'brave-search',
    description: 'Brave 网络搜索',
    market: '社区',
    tags: ['搜索', '联网'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    needsConfig: '需 Brave API Key',
    fields: [{ key: 'BRAVE_API_KEY', label: 'Brave API Key', kind: 'env', placeholder: 'BSA...' }]
  },
  {
    id: 'puppeteer',
    name: 'puppeteer',
    description: '浏览器自动化 / 网页抓取',
    market: '社区',
    tags: ['浏览器', '抓取'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer']
  },
  {
    id: 'context7',
    name: 'context7',
    description: '实时库文档检索（远程 HTTP）',
    market: '社区 · 远程',
    tags: ['文档', '远程'],
    transport: 'http',
    url: 'https://mcp.context7.com/mcp'
  }
]

const SKILL_CATALOG: SkillDef[] = [
  {
    id: 'unit-test',
    name: '单元测试',
    description: '为目标代码补充高质量单元测试',
    market: 'SeekCode 技能库',
    tags: ['测试'],
    content:
      '# 单元测试\n> 为目标代码补充高质量单元测试\n\n步骤：\n1. 读取目标文件，识别公共函数与边界条件。\n2. 选用项目已有测试框架（jest/vitest/pytest 等），保持风格一致。\n3. 覆盖正常路径、边界、异常与错误处理。\n4. 测试应可独立运行、命名清晰、断言明确。\n5. 运行测试确认通过。'
  },
  {
    id: 'security-review',
    name: '安全审查',
    description: '审查改动中的安全风险',
    market: 'SeekCode 技能库',
    tags: ['安全'],
    content:
      '# 安全审查\n> 审查改动中的安全风险\n\n重点：注入（SQL/命令/路径穿越）、鉴权与越权、密钥硬编码、不安全反序列化、SSRF、XSS、依赖漏洞。\n按「风险 — 位置 — 影响 — 修复」逐条列出，标注严重程度。'
  },
  {
    id: 'refactor',
    name: '重构',
    description: '在不改变行为的前提下改进结构',
    market: 'SeekCode 技能库',
    tags: ['重构'],
    content:
      '# 重构\n> 在不改变外部行为的前提下改进结构\n\n原则：小步前进、每步可验证；先有测试再重构；消除重复、降低耦合、提升命名与可读性。每次修改后运行测试确认行为不变。'
  },
  {
    id: 'api-docs',
    name: 'API 文档',
    description: '为接口生成清晰文档',
    market: 'SeekCode 技能库',
    tags: ['文档'],
    content:
      '# API 文档\n> 为接口/函数生成清晰文档\n\n包含：用途、参数（类型/约束/默认值）、返回值、错误、示例。保持与代码一致，示例可运行。'
  },
  {
    id: 'commit-pr',
    name: 'PR 描述',
    description: '生成规范的 Pull Request 描述',
    market: 'SeekCode 技能库',
    tags: ['Git'],
    content:
      '# PR 描述\n> 生成规范的 Pull Request 描述\n\n结构：背景与动机、改动概述、关键实现、测试方式、风险与回滚、关联 Issue。语言简洁、面向评审者。'
  }
]

// 远程搜索结果缓存（供安装时解析 command/url/content）
const remoteCache = new Map<string, McpDef | SkillDef>()

async function fetchJson(url: string, headers?: Record<string, string>, ms = 6000): Promise<any> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), ms)
    const res = await guardedFetch(url, { headers, signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// 官方 MCP Registry
async function searchMcpRegistry(q: string): Promise<CatalogEntry[]> {
  const data = await fetchJson(
    `https://registry.modelcontextprotocol.io/v0/servers?limit=12&search=${encodeURIComponent(q)}`
  )
  const servers = data?.servers ?? data?.data ?? []
  const installed = mcpInstalledKeys()
  const out: CatalogEntry[] = []
  for (const s of servers.slice(0, 12)) {
    const remote = s.remotes?.[0]
    const pkg = s.packages?.[0]
    const transport: 'stdio' | 'http' = remote ? 'http' : 'stdio'
    const full = s.name || s.id || ''
    const shortName = (full.split('/').pop() || full).trim()
    if (!shortName) continue
    let command: string | undefined
    let args: string[] | undefined
    if (!remote && pkg) {
      const reg = pkg.registry_name || pkg.registry || 'npm'
      if (reg === 'pypi') {
        command = 'uvx'
        args = [pkg.name]
      } else {
        command = 'npx'
        args = ['-y', pkg.name + (pkg.version ? `@${pkg.version}` : '')]
      }
    }
    const id = 'reg:' + full
    const def: McpDef = {
      id,
      name: shortName,
      description: s.description || '',
      market: 'MCP Registry',
      tags: ['注册中心'],
      transport,
      command,
      args,
      url: remote?.url,
      homepage: s.repository?.url,
      version: s.version_detail?.version || pkg?.version
    }
    remoteCache.set(id, def)
    out.push({
      id,
      name: shortName,
      description: def.description,
      market: def.market,
      tags: def.tags,
      transport,
      installed: installed.has(shortName),
      remote: true,
      homepage: def.homepage,
      version: def.version
    })
  }
  return out
}

// GitHub 仓库搜索（技能）→ 安装时拉取其 README
async function searchGithubSkills(q: string): Promise<CatalogEntry[]> {
  const data = await fetchJson(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q + ' skill')}&per_page=8&sort=stars`,
    { Accept: 'application/vnd.github+json', 'User-Agent': 'SeekCode' }
  )
  const items = data?.items ?? []
  const names = new Set(listSkills(null).map((s) => s.name))
  const out: CatalogEntry[] = []
  for (const r of items.slice(0, 8)) {
    const id = 'gh:' + r.id
    const branch = r.default_branch || 'main'
    const def: SkillDef = {
      id,
      name: r.name,
      description: r.description || '',
      market: 'GitHub',
      tags: ['github'],
      url: `https://raw.githubusercontent.com/${r.full_name}/${branch}/README.md`,
      homepage: r.html_url
    }
    remoteCache.set(id, def)
    out.push({
      id,
      name: r.name,
      description: def.description,
      market: 'GitHub',
      tags: ['github'],
      installed: names.has(r.name),
      remote: true,
      homepage: r.html_url
    })
  }
  return out
}

export async function marketSearch(kind: 'mcp' | 'skill', q: string, root: string | null): Promise<CatalogEntry[]> {
  const query = q.trim().toLowerCase()
  const builtin = marketList(kind, root).filter(
    (e) => !query || (e.name + e.description + e.market + e.tags.join(' ')).toLowerCase().includes(query)
  )
  if (!query) return builtin
  let remote: CatalogEntry[] = []
  try {
    remote = kind === 'mcp' ? await searchMcpRegistry(q.trim()) : await searchGithubSkills(q.trim())
  } catch {
    remote = []
  }
  // 去重：远程中若名称已在内置，跳过
  const builtinNames = new Set(builtin.map((e) => e.name))
  return [...builtin, ...remote.filter((e) => !builtinNames.has(e.name))]
}

function mcpInstalledKeys(): Set<string> {
  try {
    const p = join(app.getPath('userData'), 'mcp.json')
    if (!existsSync(p)) return new Set()
    const obj = JSON.parse(readFileSync(p, 'utf-8'))
    return new Set(Object.keys(obj.servers ?? obj.mcpServers ?? {}))
  } catch {
    return new Set()
  }
}

export function marketList(kind: 'mcp' | 'skill', root: string | null): CatalogEntry[] {
  if (kind === 'mcp') {
    const installed = mcpInstalledKeys()
    return MCP_CATALOG.map((e) => {
      const pkg = (e.args ?? []).find((a) => a.startsWith('@'))
      return {
        id: e.id,
        name: e.name,
        description: e.description,
        market: e.market,
        tags: e.tags,
        transport: e.transport,
        needsConfig: e.needsConfig,
        fields: e.fields?.map((f) => ({ key: f.key, label: f.label, placeholder: f.placeholder })),
        installed: installed.has(e.name),
        remote: false,
        homepage: e.homepage ?? (pkg ? `https://www.npmjs.com/package/${pkg}` : e.url),
        version: e.version ?? (e.transport === 'stdio' ? 'latest' : undefined)
      }
    })
  }
  const names = new Set(listSkills(root).map((s) => s.name))
  return SKILL_CATALOG.map((e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    market: e.market,
    tags: e.tags,
    installed: names.has(e.name),
    remote: false,
    homepage: e.homepage
  }))
}

export async function marketInstall(
  kind: 'mcp' | 'skill',
  id: string,
  root: string | null,
  values?: Record<string, string>
): Promise<{ ok: boolean; name?: string; error?: string }> {
  if (kind === 'mcp') {
    const e = MCP_CATALOG.find((x) => x.id === id) ?? (remoteCache.get(id) as McpDef | undefined)
    if (!e) return { ok: false, error: '未找到条目' }
    let cfg: any
    if (e.transport === 'http') {
      cfg = { url: e.url }
    } else {
      const env: Record<string, string> = { ...(e.env ?? {}) }
      const args = [...(e.args ?? [])]
      let argFilled = false
      for (const f of e.fields ?? []) {
        const v = (values?.[f.key] ?? '').trim()
        if (f.kind === 'env' && v) env[f.key] = v
        else if (f.kind === 'arg' && v) {
          args.push(v)
          argFilled = true
        }
      }
      if (e.useRoot && !argFilled && root) args.push(root)
      cfg = { command: e.command, args, env }
    }
    const ok = await addMcpServer(e.name, cfg, root)
    return ok ? { ok: true, name: e.name } : { ok: false, error: '安装失败' }
  }
  const e = SKILL_CATALOG.find((x) => x.id === id) ?? (remoteCache.get(id) as SkillDef | undefined)
  if (!e) return { ok: false, error: '未找到条目' }
  if (e.content) {
    return saveSkill('global', e.name, e.content, root)
      ? { ok: true, name: e.name }
      : { ok: false, error: '保存失败' }
  }
  if (e.url) return installSkillFromUrl(e.url, 'global', root)
  return { ok: false, error: '条目无内容' }
}
