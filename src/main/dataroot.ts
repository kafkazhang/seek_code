import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  readdirSync,
  rmSync,
  statSync,
  accessSync,
  constants
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { DataDirChangeResult } from '@shared/types'

// 数据根目录：所有本地数据（settings / 会话 / 技能 / 索引 / 缓存等）都落在这个目录下。
// 解析优先级：用户自定义指针 > 环境变量 APP_DATA_ROOT（开发用）> 系统默认 userData。
//
// 引导指针存在系统固定位置 <userData>/data-root.json，不能存进数据根目录本身（鸡生蛋）。
// 默认情况下数据根目录就等于 userData（与现有安装保持完全一致，零迁移）。

/**
 * 本应用自有的数据条目清单。迁移时只按此清单选择性复制，
 * 避免把 Electron/Chromium 自身的缓存（Cache、GPUCache、Cookies 等）一并拖走。
 * 新增持久化文件/目录时记得同步登记，否则更改数据目录时不会被迁移。
 */
export const APP_DATA_ENTRIES = [
  'settings.json',
  'apikey.bin',
  'embedkey.bin',
  'sessions.json',
  'mcp.json',
  'memory.md',
  'tasks.json',
  'skills',
  'index',
  'ocr-cache',
  'logs'
] as const

function pointerFile(): string {
  return join(app.getPath('userData'), 'data-root.json')
}

/** 读取自定义数据根指针；未设置或损坏返回 null。 */
export function readPointer(): string | null {
  try {
    const v = JSON.parse(readFileSync(pointerFile(), 'utf-8')).dataRoot
    return typeof v === 'string' && v.trim() ? v : null
  } catch {
    return null
  }
}

/** 原子写指针文件。 */
function writePointer(target: string): void {
  const p = pointerFile()
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ dataRoot: target }, null, 2))
  renameSync(tmp, p)
}

let cached: string | null = null

/** 当前生效的数据根目录（已确保存在）。首次调用须在 app ready 之后。 */
export function dataRoot(): string {
  if (cached) return cached
  const candidate = readPointer() || process.env.APP_DATA_ROOT || app.getPath('userData')
  try {
    mkdirSync(candidate, { recursive: true })
    cached = candidate
  } catch {
    // 自定义目录不可用（如移动盘已拔出）→ 回退系统默认，保证应用仍可启动。
    cached = app.getPath('userData')
    mkdirSync(cached, { recursive: true })
  }
  return cached
}

/** 递归复制单个条目（文件或目录）。 */
function copyEntry(src: string, dest: string): void {
  const st = statSync(src)
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true })
    for (const name of readdirSync(src)) copyEntry(join(src, name), join(dest, name))
  } else {
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
  }
}

/**
 * 迁移数据根目录：先把本应用数据复制到新目录、校验关键文件完整，再切换指针。
 * 安全可回滚——失败时只清掉刚复制进新目录的那些条目，旧目录与旧指针保持不变，
 * 绝不让用户落到「新目录空、旧目录丢」的中间态。旧目录默认保留作为安全网（不删除）。
 * 成功后需重启应用，使数据库/缓存/索引等绑定到新路径。
 */
export function changeDataRoot(newRoot: string): DataDirChangeResult {
  const oldRoot = dataRoot()
  const resolvedNew = resolve(newRoot)

  if (resolvedNew === resolve(oldRoot)) {
    return { ok: true, moved: false, from: oldRoot, to: resolvedNew }
  }

  // 目标目录可写性校验
  try {
    mkdirSync(resolvedNew, { recursive: true })
    accessSync(resolvedNew, constants.W_OK)
  } catch (e: unknown) {
    return { ok: false, error: `目标目录不可写：${(e as Error)?.message ?? String(e)}` }
  }

  // 拒绝覆盖已含 SeekCode 数据的目录，避免清掉那边已有的用户数据
  if (APP_DATA_ENTRIES.some((entry) => existsSync(join(resolvedNew, entry)))) {
    return { ok: false, error: '目标目录已存在 SeekCode 数据，请另选一个空目录，避免覆盖。' }
  }

  const copied: string[] = []
  try {
    for (const entry of APP_DATA_ENTRIES) {
      const src = join(oldRoot, entry)
      if (!existsSync(src)) continue
      const dest = join(resolvedNew, entry)
      copyEntry(src, dest)
      copied.push(dest)
    }

    // 校验关键文件复制完整（按字节大小核对）
    for (const critical of ['settings.json', 'apikey.bin']) {
      const src = join(oldRoot, critical)
      const dest = join(resolvedNew, critical)
      if (existsSync(src) && (!existsSync(dest) || statSync(src).size !== statSync(dest).size)) {
        throw new Error(`关键文件复制不完整：${critical}`)
      }
    }

    // 全部成功后才切换指针
    writePointer(resolvedNew)
    cached = resolvedNew
    return { ok: true, moved: copied.length > 0, from: oldRoot, to: resolvedNew }
  } catch (e: unknown) {
    // 回滚：删掉刚复制进新目录的条目（不碰新目录里原有的无关文件），保留旧目录与旧指针
    for (const dest of copied) {
      try {
        rmSync(dest, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    return { ok: false, error: `迁移失败：${(e as Error)?.message ?? String(e)}` }
  }
}
