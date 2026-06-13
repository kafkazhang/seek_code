import { BrowserWindow, session } from 'electron'
import { guardedFetch, registerTrustedHost } from './egress'
import { htmlToText, htmlTitle, looksLikeSpaShell } from './htmltext'

// 受控联网读取（对标 Claude Code 的 WebFetch，但服从 SeekCode 的出口白名单模型）：
//  - 任何权限模式下 web_fetch 都强制弹审批（见 agent.ts），用户批准后才把该 host
//    注册进「用户显式信任」出口（egress.ts userTrustedHosts），再经 guardedFetch 出网；
//  - 只发 GET、不带任何用户代码/上下文，响应转纯文本并截断后回灌模型。

const FETCH_TIMEOUT_MS = 20_000
const MAX_BODY = 1_500_000 // 原始响应体上限（字符）
const DEFAULT_CLIP = 8_000

// ── SPA 沙箱渲染 ─────────────────────────────────────
// 纯 GET 抓不到 JS 渲染的内容（SPA 返回空壳 HTML）。SeekCode 内置 Chromium，
// 用一个隐藏的沙箱 BrowserWindow 把页面真正渲染出来再取 body.innerText：
//  - 仅在用户批准该 host 之后才会进入（web_fetch 的审批闸门在 agent.ts）；
//  - 独立内存 partition（不落盘、不与应用窗口共享 Cookie），每次用完清空存储；
//  - sandbox + contextIsolation、无 preload、无 Node；拒绝弹窗 / 下载 / 权限请求；
//  - 屏蔽 image/media/font 子资源（提速且收窄出网面），提取完即销毁窗口。
// 注：渲染会加载页面的脚本等子资源（与真实浏览器访问一致），范围仅限本沙箱会话。

const RENDER_PARTITION = 'webfetch-sandbox' // 无 persist: 前缀 → 内存级会话
const RENDER_DEADLINE_MS = 30_000
const SETTLE_POLL_MS = 900
const SETTLE_MAX_POLLS = 8

let sandboxPrepared = false
function sandboxSession(): Electron.Session {
  const ses = session.fromPartition(RENDER_PARTITION)
  if (!sandboxPrepared) {
    sandboxPrepared = true
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
      const t = details.resourceType
      cb({ cancel: t === 'image' || t === 'media' || t === 'font' })
    })
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    ses.on('will-download', (e) => e.preventDefault())
  }
  return ses
}

async function renderPage(url: string): Promise<{ ok: boolean; title?: string; text?: string; error?: string }> {
  const ses = sandboxSession()
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: {
      partition: RENDER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      images: false,
      webgl: false
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.setAudioMuted(true)
  const deadline = setTimeout(() => {
    try {
      win.webContents.stop()
    } catch {
      /* ignore */
    }
  }, RENDER_DEADLINE_MS)
  try {
    // 部分 SPA 首跳会触发 ERR_ABORTED（客户端路由重定向），吞掉错误继续等内容
    await win.loadURL(url).catch(() => undefined)
    // 等正文稳定：轮询 body 文本长度，连续两次相同且非空即认为渲染完成
    let last = -1
    for (let i = 0; i < SETTLE_MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, SETTLE_POLL_MS))
      const len = (await win.webContents
        .executeJavaScript('document.body ? document.body.innerText.length : 0', true)
        .catch(() => 0)) as number
      if (len > 0 && len === last) break
      last = len
    }
    const payload = (await win.webContents.executeJavaScript(
      `({ title: document.title || '', text: document.body ? document.body.innerText : '' })`,
      true
    )) as { title: string; text: string }
    const text = (payload?.text ?? '').trim()
    if (!text) return { ok: false, error: '渲染后仍未取到正文（页面可能需要登录或有反爬）' }
    return { ok: true, title: payload.title?.trim() || undefined, text }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  } finally {
    clearTimeout(deadline)
    try {
      win.destroy()
    } catch {
      /* ignore */
    }
    void ses.clearStorageData().catch(() => undefined) // 用完即清，不留 Cookie/缓存
  }
}

function formatResult(url: string, title: string | null | undefined, text: string, clip: number, via: string): string {
  const clipped = text.length > clip ? text.slice(0, clip) + `\n…（已截断，原文 ${text.length} 字符）` : text
  return (title ? `【${title}】\n` : '') + `来源：${url}${via ? `（${via}）` : ''}\n\n` + (clipped || '（页面无文本内容）')
}

/** 经用户批准后调用：注册信任 host → 受控 GET → SPA 空壳时自动沙箱渲染兜底 */
export async function fetchWeb(url: string, maxChars?: number, render = false): Promise<string> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return `非法 URL：${url}`
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `仅支持 http(s)，拒绝 ${u.protocol}`
  registerTrustedHost(url) // 用户已批准 → 登记为显式信任出口
  const clip = Math.min(Math.max(500, Math.floor(maxChars ?? DEFAULT_CLIP)), 30_000)

  // 显式要求渲染：直接走沙箱浏览器
  if (render) {
    const r = await renderPage(url)
    if (r.ok) return formatResult(url, r.title, r.text!, clip, '沙箱浏览器渲染')
    return `渲染抓取失败：${r.error}（${url}）`
  }

  try {
    const res = await guardedFetch(url, {
      method: 'GET',
      headers: { Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5', 'User-Agent': 'SeekCode/0.1' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) return `HTTP ${res.status} ${res.statusText}（${url}）`
    const ctype = res.headers.get('content-type') ?? ''
    let body = await res.text()
    if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY)
    const isHtml = /html/i.test(ctype) || /^\s*</.test(body.slice(0, 200))
    if (!isHtml) return formatResult(url, null, body.trim(), clip, '')

    const title = htmlTitle(body)
    const text = htmlToText(body)
    // SPA 空壳检测：正文过薄 / 明示需要 JS → 自动用沙箱浏览器渲染兜底
    if (looksLikeSpaShell(body, text)) {
      const r = await renderPage(url)
      if (r.ok) return formatResult(url, r.title ?? title, r.text!, clip, '检测到 SPA，已自动沙箱渲染')
      return (
        formatResult(url, title, text, clip, '静态抓取') +
        `\n\n[提示] 该页面疑似纯 JS 渲染，且沙箱渲染失败：${r.error}。正文可能不完整。`
      )
    }
    return formatResult(url, title, text, clip, '')
  } catch (e: any) {
    const msg = e?.name === 'TimeoutError' ? `请求超时（${FETCH_TIMEOUT_MS / 1000}s）` : (e?.message ?? String(e))
    return `抓取失败：${msg}（${url}）`
  }
}
