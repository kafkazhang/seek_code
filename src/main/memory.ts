import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { MemorySnapshot } from '@shared/types'

// 记忆系统（纯本地文件）：
//  - 项目记忆 SEEK.md：随项目根目录存放，可随仓库提交、团队共享
//  - 全局记忆 memory.md：用户偏好，存 userData

const MAX = 16_000 // 注入上下文的记忆上限（字符）

function globalMemoryPath(): string {
  return join(app.getPath('userData'), 'memory.md')
}

export function readProjectMemory(root: string | null): string | null {
  if (!root) return null
  for (const name of ['SEEK.md', 'CLAUDE.md']) {
    try {
      const p = join(root, name)
      if (existsSync(p)) {
        const t = readFileSync(p, 'utf-8').trim()
        if (t) return t.slice(0, MAX)
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

export function readGlobalMemory(): string | null {
  try {
    const p = globalMemoryPath()
    if (existsSync(p)) {
      const t = readFileSync(p, 'utf-8').trim()
      if (t) return t.slice(0, MAX)
    }
  } catch {
    /* ignore */
  }
  return null
}

export function readMemory(root: string | null): MemorySnapshot {
  return { project: readProjectMemory(root), global: readGlobalMemory() }
}

export function addMemory(scope: 'project' | 'global', text: string, root: string | null): boolean {
  const line = `- ${text.trim().replace(/\s+/g, ' ')}\n`
  try {
    if (scope === 'global') {
      const p = globalMemoryPath()
      if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true })
      if (!existsSync(p)) writeFileSync(p, `# 全局记忆 / 用户偏好\n\n${line}`, 'utf-8')
      else appendFileSync(p, line, 'utf-8')
      return true
    }
    if (!root) return false
    const p = join(root, 'SEEK.md')
    if (!existsSync(p)) writeFileSync(p, `# SEEK.md — 项目记忆\n\n> SeekCode 会在每次对话自动读取本文件。\n\n${line}`, 'utf-8')
    else appendFileSync(p, line, 'utf-8')
    return true
  } catch {
    return false
  }
}

/** 组装注入上下文的记忆消息（置于半稳定层，仅记忆文件变更时失效） */
export function memoryContext(root: string | null): string | null {
  const parts: string[] = []
  const g = readGlobalMemory()
  if (g) parts.push('【全局记忆 / 用户偏好】\n' + g)
  const p = readProjectMemory(root)
  if (p) parts.push('【项目记忆 SEEK.md】\n' + p)
  return parts.length ? parts.join('\n\n') : null
}
