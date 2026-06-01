import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { PersistedState } from '@shared/types'

// 会话与活动会话持久化：纯本地，存于 userData/sessions.json。
// 渲染层为唯一数据源，变更后整体回写；主进程只负责读写文件。

export function sessionsPath(): string {
  return join(app.getPath('userData'), 'sessions.json')
}

/** 原子写：先写临时文件再重命名，避免写入中断导致文件损坏 */
function atomicWrite(p: string, content: string): void {
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, p)
}

const EMPTY: PersistedState = { activeId: null, sessions: [] }

export function loadSessions(): PersistedState {
  try {
    const p = sessionsPath()
    if (!existsSync(p)) return EMPTY
    const raw = JSON.parse(readFileSync(p, 'utf-8'))
    // 兼容旧格式（纯数组）
    const data: PersistedState = Array.isArray(raw) ? { activeId: null, sessions: raw } : raw
    const sessions = (data.sessions ?? []).map((s) => ({
      ...s,
      messages: (s.messages ?? []).map((m) => ({ ...m, streaming: false }))
    }))
    return { activeId: data.activeId ?? null, sessions }
  } catch {
    return EMPTY
  }
}

export function saveSessions(data: PersistedState): void {
  try {
    const sessions = [...(data.sessions ?? [])]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 200) // 上限保护
    atomicWrite(sessionsPath(), JSON.stringify({ activeId: data.activeId ?? null, sessions }, null, 2))
  } catch {
    /* 忽略写入失败 */
  }
}

export function clearSessions(): void {
  try {
    rmSync(sessionsPath(), { force: true })
  } catch {
    /* ignore */
  }
}
