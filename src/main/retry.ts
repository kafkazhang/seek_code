// 纯重试/退避逻辑（无 Electron 依赖，便于单测）。

/** 判断错误是否值得重试（瞬时网络抖动 / 限流 / 5xx 网关错误） */
export function isRetryableError(e: any): boolean {
  if (!e) return false
  const status = e?.status ?? e?.statusCode ?? e?.response?.status
  if (status === 429 || (typeof status === 'number' && status >= 500 && status < 600)) return true
  const code = e?.code ?? e?.cause?.code
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(code))
    return true
  const msg = String(e?.message ?? '').toLowerCase()
  return /timeout|timed out|temporarily|socket hang up|network|fetch failed/.test(msg)
}

/**
 * 通用重试：对瞬时错误做指数退避（含抖动）。
 * 用户主动中断（AbortError）不重试，立即抛出。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number } = {}
): Promise<T> {
  const retries = opts.retries ?? 3
  const baseMs = opts.baseMs ?? 600
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (e: any) {
      // 中断信号：用户取消，不应重试
      if (e?.name === 'AbortError' || e?.message === 'aborted') throw e
      lastErr = e
      if (attempt === retries || !isRetryableError(e)) throw e
      const delay = baseMs * 2 ** attempt + Math.floor(Math.random() * 200)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}
