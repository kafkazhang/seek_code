import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { AppConfig, ConfigPatch, DEFAULT_CONFIG } from '@shared/types'

/** 原子写：临时文件 + 重命名，防止写入中断损坏配置 */
function atomicWrite(p: string, content: string | Buffer): void {
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, p)
}

// 配置与密钥落盘：
//  - settings.json 存非敏感配置（明文）
//  - apikey.bin 存经 safeStorage（操作系统级）加密的 API Key
// 全部位于 userData 目录，纯本地，卸载即清除。

type PersistShape = Omit<AppConfig, 'hasKey'>

let cache: AppConfig | null = null

export function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}
export function keyPath(): string {
  return join(app.getPath('userData'), 'apikey.bin')
}
export function dataDir(): string {
  return app.getPath('userData')
}

function loadPersisted(): PersistShape {
  try {
    if (existsSync(settingsPath())) {
      const raw = JSON.parse(readFileSync(settingsPath(), 'utf-8'))
      const merged = { ...stripHasKey(DEFAULT_CONFIG), ...raw }
      // 迁移：旧版 autoApprove 布尔 → 新版 permissionMode
      if (raw.permissionMode === undefined && raw.autoApprove !== undefined) {
        merged.permissionMode = raw.autoApprove ? 'auto' : 'ask'
      }
      delete (merged as Record<string, unknown>).autoApprove
      return merged
    }
  } catch {
    /* 损坏则回退默认 */
  }
  return stripHasKey(DEFAULT_CONFIG)
}

function stripHasKey(c: AppConfig): PersistShape {
  const { hasKey: _omit, ...rest } = c
  return rest
}

export function getConfig(): AppConfig {
  if (!cache) {
    const persisted = loadPersisted()
    cache = { ...persisted, hasKey: hasApiKey() }
  } else {
    cache.hasKey = hasApiKey()
  }
  return cache
}

export function setConfig(patch: ConfigPatch): AppConfig {
  const current = getConfig()
  const next: AppConfig = { ...current }

  if (patch.apiKey !== undefined) saveApiKey(patch.apiKey)
  if (patch.baseURL !== undefined) next.baseURL = patch.baseURL.trim().replace(/\/+$/, '')
  if (patch.flashModel !== undefined) next.flashModel = patch.flashModel.trim()
  if (patch.proModel !== undefined) next.proModel = patch.proModel.trim()
  if (patch.fimModel !== undefined) next.fimModel = patch.fimModel.trim()
  if (patch.reasoning !== undefined) next.reasoning = patch.reasoning
  if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode
  if (patch.theme !== undefined) next.theme = patch.theme

  // 出口白名单跟随 baseURL 自动同步
  try {
    next.egressAllowlist = Array.from(new Set(['api.deepseek.com', new URL(next.baseURL).hostname]))
  } catch {
    next.egressAllowlist = ['api.deepseek.com']
  }

  atomicWrite(settingsPath(), JSON.stringify(stripHasKey(next), null, 2))
  cache = { ...next, hasKey: hasApiKey() }
  return cache
}

/** 清除全部本地数据：配置 + 密钥（会话由 sessions 模块清除） */
export function clearAll(): void {
  cache = null
  try {
    rmSync(settingsPath(), { force: true })
  } catch {
    /* ignore */
  }
  try {
    rmSync(keyPath(), { force: true })
  } catch {
    /* ignore */
  }
}

// ── API Key（加密落盘）──────────────────────────────
export function saveApiKey(key: string): void {
  const trimmed = key.trim()
  if (!trimmed) return
  if (safeStorage.isEncryptionAvailable()) {
    atomicWrite(keyPath(), safeStorage.encryptString(trimmed))
  } else {
    // 退化：仅当系统不支持加密时，加前缀标记明文（极少见）
    atomicWrite(keyPath(), Buffer.from('plain:' + trimmed, 'utf-8'))
  }
}

export function getApiKey(): string | null {
  try {
    if (!existsSync(keyPath())) return null
    const buf = readFileSync(keyPath())
    if (buf.subarray(0, 6).toString('utf-8') === 'plain:') {
      return buf.subarray(6).toString('utf-8')
    }
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf)
    return null
  } catch {
    return null
  }
}

export function hasApiKey(): boolean {
  return !!getApiKey()
}
