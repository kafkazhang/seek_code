import { spawn, ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { McpStatus } from '@shared/types'
import { guardedFetch, registerTrustedHost } from './egress'
import { dataRoot } from './dataroot'

// MCP 客户端，支持两种传输：
//   - stdio：本地子进程，换行分隔 JSON-RPC（{ "command": "...", "args": [...] }）
//   - http ：远程服务器，Streamable HTTP / JSON-RPC（{ "url": "https://...", "headers": {...} }）
// 配置：优先 <root>/.seek/mcp.json，否则全局 <dataRoot>/mcp.json
//   { "servers": { "<name>": { ... } } }

interface McpServerCfg {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}
interface McpTool {
  name: string
  description?: string
  inputSchema?: unknown
}
interface McpConn {
  name: string
  kind: 'stdio' | 'http'
  tools: McpTool[]
  status: 'connecting' | 'ready' | 'error'
  error?: string
  nextId: number
  // stdio
  proc?: ChildProcess
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>
  buf: string
  // http
  url?: string
  headers?: Record<string, string>
  sessionId?: string
}

const conns = new Map<string, McpConn>()
const route = new Map<string, { server: string; tool: string }>()

function globalConfigPath(): string {
  return join(dataRoot(), 'mcp.json')
}
function configPath(root: string | null): string | null {
  if (root) {
    const p = join(root, '.seek', 'mcp.json')
    if (existsSync(p)) return p
  }
  const g = globalConfigPath()
  return existsSync(g) ? g : null
}
function loadConfig(root: string | null): Record<string, McpServerCfg> {
  const p = configPath(root)
  if (!p) return {}
  try {
    const j = JSON.parse(readFileSync(p, 'utf-8'))
    return j.servers ?? j.mcpServers ?? {}
  } catch {
    return {}
  }
}

// ── stdio ──
function stdioSend(c: McpConn, method: string, params: unknown, expectReply = true): Promise<any> {
  const id = c.nextId++
  const payload = JSON.stringify({ jsonrpc: '2.0', ...(expectReply ? { id } : {}), method, params }) + '\n'
  if (!expectReply) {
    try {
      c.proc?.stdin?.write(payload)
    } catch {
      /* ignore */
    }
    return Promise.resolve(null)
  }
  return new Promise((resolve, reject) => {
    c.pending.set(id, { resolve, reject })
    try {
      c.proc?.stdin?.write(payload)
    } catch (e: any) {
      reject(e)
    }
    setTimeout(() => {
      if (c.pending.has(id)) {
        c.pending.delete(id)
        reject(new Error('MCP 请求超时'))
      }
    }, 15000)
  })
}
function onStdioData(c: McpConn, chunk: string): void {
  c.buf += chunk
  let i: number
  while ((i = c.buf.indexOf('\n')) >= 0) {
    const line = c.buf.slice(0, i).trim()
    c.buf = c.buf.slice(i + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id !== undefined && c.pending.has(msg.id)) {
        const p = c.pending.get(msg.id)!
        c.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message || 'MCP 错误'))
        else p.resolve(msg.result)
      }
    } catch {
      /* 忽略非 JSON 行 */
    }
  }
}

// ── http (Streamable HTTP) ──
async function httpSend(c: McpConn, method: string, params: unknown, expectReply = true): Promise<any> {
  const id = c.nextId++
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(c.headers ?? {}),
    ...(c.sessionId ? { 'Mcp-Session-Id': c.sessionId } : {})
  }
  // 远端无响应时避免无限挂起（stdio 侧已有 15s 超时，此处对齐）
  const res = await guardedFetch(c.url!, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', ...(expectReply ? { id } : {}), method, params }),
    signal: AbortSignal.timeout(20000)
  })
  const sid = res.headers.get('mcp-session-id')
  if (sid) c.sessionId = sid
  if (!expectReply) return null
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('text/event-stream')) {
    const text = await res.text()
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      try {
        const msg = JSON.parse(line.slice(5).trim())
        if (msg.id === id) {
          if (msg.error) throw new Error(msg.error.message || 'MCP 错误')
          return msg.result
        }
      } catch {
        /* skip */
      }
    }
    throw new Error('未收到匹配的 MCP 响应')
  }
  const j = (await res.json()) as any
  if (j.error) throw new Error(j.error.message || 'MCP 错误')
  return j.result
}

function rpc(c: McpConn, method: string, params: unknown, expectReply = true): Promise<any> {
  return c.kind === 'http' ? httpSend(c, method, params, expectReply) : stdioSend(c, method, params, expectReply)
}

async function connect(name: string, sc: McpServerCfg): Promise<void> {
  const c: McpConn = {
    name,
    kind: sc.url ? 'http' : 'stdio',
    tools: [],
    status: 'connecting',
    nextId: 1,
    pending: new Map(),
    buf: '',
    url: sc.url,
    headers: sc.headers
  }
  conns.set(name, c)
  // 远程 MCP 服务器是用户显式配置的可信出口，登记到主进程出口白名单
  if (c.kind === 'http' && sc.url) registerTrustedHost(sc.url)
  try {
    if (c.kind === 'stdio') {
      if (!sc.command) throw new Error('缺少 command')
      const proc = spawn(sc.command, sc.args ?? [], {
        env: { ...process.env, ...(sc.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      c.proc = proc
      proc.stdout?.setEncoding('utf-8')
      proc.stdout?.on('data', (d) => onStdioData(c, String(d)))
      proc.on('error', (e) => {
        c.status = 'error'
        c.error = e.message
      })
      proc.on('exit', () => {
        if (c.status !== 'error') {
          c.status = 'error'
          c.error = '服务器进程已退出'
        }
      })
    }
    await rpc(c, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'SeekCode', version: '0.1.0' }
    })
    await rpc(c, 'notifications/initialized', {}, false)
    const list = await rpc(c, 'tools/list', {})
    c.tools = (list?.tools ?? []) as McpTool[]
    c.status = 'ready'
    for (const t of c.tools) route.set(`mcp__${name}__${t.name}`, { server: name, tool: t.name })
  } catch (e: any) {
    c.status = 'error'
    c.error = e?.message ?? String(e)
  }
}

export async function initMcp(root: string | null): Promise<void> {
  await shutdownMcp()
  const cfg = loadConfig(root)
  await Promise.all(
    Object.entries(cfg)
      .filter(([, sc]) => sc?.command || sc?.url)
      .map(([name, sc]) => connect(name, sc))
  )
}

export async function shutdownMcp(): Promise<void> {
  for (const c of conns.values()) {
    try {
      c.proc?.kill()
    } catch {
      /* ignore */
    }
  }
  conns.clear()
  route.clear()
}

export function mcpToolDefs(): any[] {
  const defs: any[] = []
  for (const c of conns.values()) {
    if (c.status !== 'ready') continue
    for (const t of c.tools) {
      defs.push({
        type: 'function',
        function: {
          name: `mcp__${c.name}__${t.name}`,
          description: `${t.description ?? ''} [MCP:${c.name}]`.trim(),
          parameters: t.inputSchema ?? { type: 'object', properties: {} }
        }
      })
    }
  }
  return defs
}

export function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__')
}

export async function callMcpTool(name: string, args: unknown): Promise<string> {
  const r = route.get(name)
  if (!r) return `未找到 MCP 工具：${name}`
  const c = conns.get(r.server)
  if (!c || c.status !== 'ready') return `MCP 服务器 ${r.server} 不可用`
  try {
    const res = await rpc(c, 'tools/call', { name: r.tool, arguments: args ?? {} })
    const parts = (res?.content ?? []) as Array<{ type: string; text?: string }>
    const text = parts
      .map((p) => (p.type === 'text' ? p.text : `[${p.type}]`))
      .filter(Boolean)
      .join('\n')
    return text || JSON.stringify(res ?? {}).slice(0, 2000)
  } catch (e: any) {
    return `MCP 调用失败：${e?.message ?? String(e)}`
  }
}

export function mcpStatus(): McpStatus[] {
  return [...conns.values()].map((c) => ({
    name: c.name,
    status: c.status,
    tools: c.tools.length,
    toolNames: c.tools.map((t) => t.name),
    error: c.error
  }))
}

export async function addMcpServer(name: string, cfg: McpServerCfg, root: string | null): Promise<boolean> {
  try {
    const p = globalConfigPath()
    let obj: any = { servers: {} }
    if (existsSync(p)) {
      try {
        obj = JSON.parse(readFileSync(p, 'utf-8'))
      } catch {
        obj = { servers: {} }
      }
    }
    if (!obj.servers) obj.servers = obj.mcpServers ?? {}
    obj.servers[name] = cfg
    if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify({ servers: obj.servers }, null, 2), 'utf-8')
    await initMcp(root)
    return true
  } catch {
    return false
  }
}

export async function removeMcpServer(name: string, root: string | null): Promise<boolean> {
  try {
    const p = globalConfigPath()
    if (!existsSync(p)) return false
    const obj = JSON.parse(readFileSync(p, 'utf-8'))
    const servers = obj.servers ?? obj.mcpServers ?? {}
    delete servers[name]
    writeFileSync(p, JSON.stringify({ servers }, null, 2), 'utf-8')
    await initMcp(root)
    return true
  } catch {
    return false
  }
}
