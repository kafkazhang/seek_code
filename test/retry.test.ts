import { describe, it, expect, vi } from 'vitest'
import { isRetryableError, withRetry } from '../src/main/retry'

describe('isRetryableError', () => {
  it('429 / 5xx 可重试', () => {
    expect(isRetryableError({ status: 429 })).toBe(true)
    expect(isRetryableError({ status: 503 })).toBe(true)
    expect(isRetryableError({ response: { status: 500 } })).toBe(true)
  })
  it('4xx（除 429）不可重试', () => {
    expect(isRetryableError({ status: 400 })).toBe(false)
    expect(isRetryableError({ status: 401 })).toBe(false)
  })
  it('瞬时网络错误码可重试', () => {
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true)
    expect(isRetryableError({ cause: { code: 'ETIMEDOUT' } })).toBe(true)
  })
  it('错误信息含 network/timeout 可重试', () => {
    expect(isRetryableError(new Error('fetch failed'))).toBe(true)
    expect(isRetryableError(new Error('socket hang up'))).toBe(true)
  })
  it('普通错误不可重试', () => {
    expect(isRetryableError(new Error('bad request'))).toBe(false)
    expect(isRetryableError(null)).toBe(false)
  })
})

describe('withRetry', () => {
  it('首次成功直接返回', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    await expect(withRetry(fn)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('瞬时错误后重试成功', async () => {
    const fn = vi.fn().mockRejectedValueOnce({ status: 503 }).mockResolvedValue('recovered')
    await expect(withRetry(fn, { baseMs: 1 })).resolves.toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('不可重试错误立即抛出，不再重试', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400 })
    await expect(withRetry(fn, { baseMs: 1 })).rejects.toEqual({ status: 400 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('用户中断（AbortError）不重试', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const fn = vi.fn().mockRejectedValue(err)
    await expect(withRetry(fn, { baseMs: 1 })).rejects.toThrow('aborted')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('达到重试上限后抛出最后一个错误', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 500 })
    await expect(withRetry(fn, { retries: 2, baseMs: 1 })).rejects.toEqual({ status: 500 })
    expect(fn).toHaveBeenCalledTimes(3) // 初次 + 2 次重试
  })
})
