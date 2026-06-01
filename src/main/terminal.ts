import { spawn, ChildProcess } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CdResult } from '@shared/types'

// 轻量终端：用系统默认 shell 执行单条命令并流式回传输出。
// 非 PTY（无需 node-pty 原生依赖），适合 git / npm / 构建 / 测试等命令；
// cwd 由渲染层跟踪并随每条命令传入，cd 通过 resolveCd 校验。

const procs = new Map<string, ChildProcess>()

export function termExec(
  execId: string,
  cwd: string,
  command: string,
  env: Record<string, string>,
  onData: (chunk: string, stream: 'out' | 'err') => void,
  onExit: (code: number | null) => void
): void {
  const isWin = process.platform === 'win32'
  // 会话级环境变量叠加在系统环境之上；开启彩色输出（FORCE_COLOR）
  const childEnv = { ...process.env, FORCE_COLOR: '1', CLICOLOR_FORCE: '1', ...env }
  let child: ChildProcess
  try {
    if (isWin) {
      // Windows 用 PowerShell：强制 UTF-8 输出，杜绝中文乱码；并支持 ls/pwd/cat 等别名
      const wrapped = `chcp 65001 > $null; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', wrapped], {
        cwd,
        windowsHide: true,
        env: childEnv
      })
    } else {
      const shell = process.env.SHELL || '/bin/bash'
      child = spawn(shell, ['-c', command], { cwd, windowsHide: true, env: childEnv })
    }
  } catch (e: any) {
    onData(`无法执行: ${e?.message ?? String(e)}\n`, 'err')
    onExit(1)
    return
  }
  // 显式按 UTF-8 解码，避免多字节字符在 chunk 边界处被截断成乱码
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  procs.set(execId, child)
  child.stdout?.on('data', (d) => onData(String(d), 'out'))
  child.stderr?.on('data', (d) => onData(String(d), 'err'))
  child.on('error', (err) => {
    onData(`${err.message}\n`, 'err')
  })
  child.on('close', (code) => {
    procs.delete(execId)
    onExit(code)
  })
}

/** 向运行中的命令发送 stdin（交互式：回答提示、REPL 等） */
export function termInput(execId: string, data: string): void {
  const c = procs.get(execId)
  try {
    c?.stdin?.write(data)
  } catch {
    /* ignore */
  }
}

export function termKill(execId: string): void {
  const c = procs.get(execId)
  if (c) {
    try {
      c.kill()
    } catch {
      /* ignore */
    }
    procs.delete(execId)
  }
}

export async function resolveCd(cwd: string, arg: string): Promise<CdResult> {
  const target = resolve(cwd, arg || '.')
  try {
    const s = await stat(target)
    if (!s.isDirectory()) return { ok: false, cwd, error: '不是目录' }
    return { ok: true, cwd: target }
  } catch {
    return { ok: false, cwd, error: '目录不存在' }
  }
}
