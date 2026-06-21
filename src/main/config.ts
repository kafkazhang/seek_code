import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { AppConfig, ConfigPatch, DEFAULT_CONFIG } from '@shared/types'
import { dataRoot } from './dataroot'

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

type PersistShape = Omit<AppConfig, 'hasKey' | 'hasEmbedKey'>

let cache: AppConfig | null = null

export function settingsPath(): string {
  return join(dataRoot(), 'settings.json')
}
export function keyPath(): string {
  return join(dataRoot(), 'apikey.bin')
}
export function embedKeyPath(): string {
  return join(dataRoot(), 'embedkey.bin')
}
export function dataDir(): string {
  return dataRoot()
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
      // 迁移：旧版扁平 pricing（无 flash/pro 分档）→ 新版按模型分档（直接回退到默认价）
      if (merged.pricing && (merged.pricing.flash === undefined || merged.pricing.pro === undefined)) {
        merged.pricing = DEFAULT_CONFIG.pricing
      }
      return merged
    }
  } catch {
    /* 损坏则回退默认 */
  }
  return stripHasKey(DEFAULT_CONFIG)
}

function stripHasKey(c: AppConfig): PersistShape {
  const { hasKey: _o1, hasEmbedKey: _o2, ...rest } = c
  return rest
}

export function getConfig(): AppConfig {
  if (!cache) {
    const persisted = loadPersisted()
    cache = { ...persisted, hasKey: hasApiKey(), hasEmbedKey: hasEmbedApiKey() }
  } else {
    cache.hasKey = hasApiKey()
    cache.hasEmbedKey = hasEmbedApiKey()
  }
  return cache
}

export function setConfig(patch: ConfigPatch): AppConfig {
  const current = getConfig()
  const next: AppConfig = { ...current }

  if (patch.apiKey !== undefined) saveApiKey(patch.apiKey)
  if (patch.embedApiKey !== undefined) saveEmbedApiKey(patch.embedApiKey)
  if (patch.baseURL !== undefined) next.baseURL = patch.baseURL.trim().replace(/\/+$/, '')
  if (patch.embedBaseURL !== undefined) next.embedBaseURL = patch.embedBaseURL.trim().replace(/\/+$/, '')
  if (patch.flashModel !== undefined) next.flashModel = patch.flashModel.trim()
  if (patch.proModel !== undefined) next.proModel = patch.proModel.trim()
  if (patch.fimModel !== undefined) next.fimModel = patch.fimModel.trim()
  if (patch.reasoning !== undefined) next.reasoning = patch.reasoning
  if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode
  if (patch.theme !== undefined) next.theme = patch.theme
  if (patch.semanticIndex !== undefined) next.semanticIndex = patch.semanticIndex
  if (patch.embedModel !== undefined) next.embedModel = patch.embedModel.trim()
  if (patch.pricing !== undefined) next.pricing = patch.pricing

  // 出口白名单跟随 baseURL / 向量服务 baseURL 自动同步
  const hosts = ['api.deepseek.com']
  try {
    hosts.push(new URL(next.baseURL).hostname)
  } catch {
    /* baseURL 非法则忽略 */
  }
  try {
    if (next.embedBaseURL) hosts.push(new URL(next.embedBaseURL).hostname)
  } catch {
    /* embedBaseURL 非法则忽略 */
  }
  next.egressAllowlist = Array.from(new Set(hosts))

  atomicWrite(settingsPath(), JSON.stringify(stripHasKey(next), null, 2))
  cache = { ...next, hasKey: hasApiKey(), hasEmbedKey: hasEmbedApiKey() }
  return cache
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

// ── 向量服务 API Key（独立加密落盘；DeepSeek 无向量模型，需用外部服务）──
export function saveEmbedApiKey(key: string): void {
  const trimmed = key.trim()
  // 传空字符串表示清除已配置的向量 Key
  if (!trimmed) {
    try {
      rmSync(embedKeyPath(), { force: true })
    } catch {
      /* ignore */
    }
    return
  }
  if (safeStorage.isEncryptionAvailable()) {
    atomicWrite(embedKeyPath(), safeStorage.encryptString(trimmed))
  } else {
    atomicWrite(embedKeyPath(), Buffer.from('plain:' + trimmed, 'utf-8'))
  }
}

export function getEmbedApiKey(): string | null {
  try {
    if (!existsSync(embedKeyPath())) return null
    const buf = readFileSync(embedKeyPath())
    if (buf.subarray(0, 6).toString('utf-8') === 'plain:') {
      return buf.subarray(6).toString('utf-8')
    }
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf)
    return null
  } catch {
    return null
  }
}

export function hasEmbedApiKey(): boolean {
  return !!getEmbedApiKey()
}
