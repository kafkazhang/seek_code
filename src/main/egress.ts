import { net } from 'electron'
import { getConfig } from './config'

// 主进程出网统一闸门。
//
// SeekCode 的安全承诺是"用户代码只发往 DeepSeek"，但生态功能（安装 Skills / MCP、
// 市场搜索）确实需要访问少数公共只读源。为避免"主进程随意 fetch 任意域名"这一暴露面，
// 主进程的所有出网都必须经由本模块的 guardedFetch，并受白名单约束。
//
// 受信任出口分三类：
//   1) 推理出口：DeepSeek（baseURL）—— 用户代码/上下文的唯一去处，随配置同步。
//   2) 生态出口：扩展安装/市场所需的公共只读源 —— 不发送用户代码。
//   3) 用户显式信任：用户主动配置的远程 MCP 服务器 host（连接时动态登记）。

// 生态出口（公共只读源；仅用于发现/下载扩展，不上传用户代码）
const ECOSYSTEM_HOSTS = [
  'github.com',
  'raw.githubusercontent.com',
  'api.github.com',
  'registry.modelcontextprotocol.io',
  'mcp.context7.com'
]

// 用户显式配置的远程 MCP 服务器 host（运行时登记）
const userTrustedHosts = new Set<string>()

export function ecosystemHosts(): string[] {
  return [...ECOSYSTEM_HOSTS]
}

/** 登记用户显式配置的可信 host（如远程 MCP 服务器地址） */
export function registerTrustedHost(url: string): void {
  try {
    userTrustedHosts.add(new URL(url).hostname)
  } catch {
    /* 非法 URL 忽略 */
  }
}

function matchHost(host: string, allow: string[]): boolean {
  return allow.some((a) => host === a || host.endsWith('.' + a))
}

/** 判断某 host 是否在主进程出口白名单内 */
export function isEgressAllowed(host: string): boolean {
  if (matchHost(host, getConfig().egressAllowlist)) return true // 推理出口（含 baseURL）
  if (matchHost(host, ECOSYSTEM_HOSTS)) return true // 生态出口
  if (userTrustedHosts.has(host)) return true // 用户显式信任
  return false
}

/**
 * 主进程受控 fetch：
 *  - 非白名单 host 直接拒绝（抛错），杜绝意外出网；
 *  - 经 Electron `net.fetch` 发起，从而走 session、可被 webRequest 审计/拦截，
 *    与渲染层使用同一套网络栈与策略。
 */
export async function guardedFetch(url: string, init?: RequestInit): Promise<Response> {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    throw new Error('非法 URL：' + url)
  }
  if (!isEgressAllowed(host)) {
    throw new Error(`出口白名单拦截（主进程）：${host} 不在受信任出口内`)
  }
  return net.fetch(url, init as Parameters<typeof net.fetch>[1])
}
