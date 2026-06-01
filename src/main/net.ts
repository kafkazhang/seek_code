import { session } from 'electron'
import { isEgressAllowed } from './egress'

// 网络出口白名单（渲染层）：从框架层拦截一切非白名单域名的请求。
// 与主进程的 guardedFetch（见 egress.ts）共用同一份白名单判定，
// 二者共同构成"纯本地、仅受信任出口联网"承诺的强制实现：
//   - 用户代码/上下文只发往 DeepSeek（推理出口）；
//   - 扩展安装/市场仅访问少数公共只读源（生态出口）；
//   - 其余一切 http/https/ws 请求一律拒绝。

const ALWAYS_ALLOW_SCHEMES = ['devtools:', 'file:', 'data:', 'blob:', 'chrome-extension:']

export function installEgressGuard(): void {
  const filter = { urls: ['*://*/*'] }

  session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    let host = ''
    let scheme = ''
    try {
      const u = new URL(details.url)
      host = u.hostname
      scheme = u.protocol
    } catch {
      callback({ cancel: false })
      return
    }

    if (ALWAYS_ALLOW_SCHEMES.includes(scheme)) {
      callback({ cancel: false })
      return
    }

    // 本地回环（dev server / 预览）始终放行
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      callback({ cancel: false })
      return
    }

    const ok = isEgressAllowed(host)
    if (!ok) {
      console.warn(`[net] 出口白名单拦截: ${details.url}`)
    }
    callback({ cancel: !ok })
  })
}
