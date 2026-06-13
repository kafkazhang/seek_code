import { spawn, ChildProcess } from 'node:child_process'
import { app } from 'electron'

// Agent 后台进程（对标 Claude Code 的 Bash 后台执行）：
// run_command 是阻塞式的，起 dev server / watch 任务会卡死回合。
// 这里提供：run_background 启动（立即返回 id + 初始输出）→ bg_output 轮询 → bg_kill 结束，
// 让 Agent 能完成「起服务 → 调接口验证 → 改代码 → 再验证」的真实开发闭环。

const MAX_PROCS = 5 // 同时运行的后台进程上限
const BUF_CAP = 64_000 // 每个进程的输出环形缓冲（字符）
const INITIAL_WAIT_MS = 1500 // 启动后等这么久再返回，带上初始输出（报错通常在最前面）

interface BgProc {
  id: string
  command: string
  child: ChildProcess
  /** 环形缓冲：超出截头留尾 */
  buf: string
  /** 已因超限丢弃的字符数 */
  dropped: number
  status: 'running' | 'exited'
  exitCode: number | null
  startedAt: number
}

const procs = new Map<string, BgProc>()
let seq = 0

function append(p: BgProc, chunk: string): void {
  p.buf += chunk
  if (p.buf.length > BUF_CAP) {
    p.dropped += p.buf.length - BUF_CAP
    p.buf = p.buf.slice(-BUF_CAP)
  }
}

function spawnShell(cwd: string, command: string): ChildProcess {
  // 与内置终端同一套 shell 选择与编码策略（Windows 强制 UTF-8 防中文乱码）
  if (process.platform === 'win32') {
    const wrapped = `chcp 65001 > $null; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`
    return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', wrapped], {
      cwd,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } // 后台输出回灌模型，关掉 ANSI 色噪声
    })
  }
  const shell = process.env.SHELL || '/bin/bash'
  return spawn(shell, ['-c', command], {
    cwd,
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
  })
}

/** 启动后台进程：等待初始输出后返回（id + 开头日志，启动报错当场可见） */
export async function startBg(root: string, command: string): Promise<string> {
  // 清理已退出的占位
  for (const [id, p] of procs) if (p.status === 'exited' && Date.now() - p.startedAt > 600_000) procs.delete(id)
  const running = [...procs.values()].filter((p) => p.status === 'running').length
  if (running >= MAX_PROCS) {
    return `已达后台进程上限（${MAX_PROCS} 个）。请先用 bg_kill 结束不需要的进程：\n${listBg()}`
  }
  const id = 'bg' + ++seq
  let child: ChildProcess
  try {
    child = spawnShell(root, command)
  } catch (e: any) {
    return `启动失败：${e?.message ?? String(e)}`
  }
  const p: BgProc = { id, command, child, buf: '', dropped: 0, status: 'running', exitCode: null, startedAt: Date.now() }
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (d) => append(p, String(d)))
  child.stderr?.on('data', (d) => append(p, String(d)))
  child.on('error', (err) => append(p, `\n[进程错误] ${err.message}\n`))
  child.on('close', (code) => {
    p.status = 'exited'
    p.exitCode = code
  })
  procs.set(id, p)

  await new Promise((r) => setTimeout(r, INITIAL_WAIT_MS))
  const head = p.buf.slice(0, 2000)
  if (p.status === 'exited') {
    return `进程已快速退出（exit ${p.exitCode}），可能不是常驻任务或启动失败：\n${head || '（无输出）'}\n\n如确属一次性命令请改用 run_command。`
  }
  return `已启动后台进程 ${id}：${command}\n初始输出：\n${head || '（暂无输出）'}\n\n用 bg_output 查看后续输出（如等服务就绪日志），用 bg_kill 结束。`
}

/** 读取后台进程输出（返回缓冲尾部 + 状态） */
export function readBg(id: string, tailChars = 4000): string {
  const p = procs.get(id)
  if (!p) return `不存在的后台进程 ${id}。当前进程：\n${listBg()}`
  const n = Math.min(Math.max(200, Math.floor(tailChars)), BUF_CAP)
  const out = p.buf.slice(-n)
  const meta =
    p.status === 'running'
      ? `[${id} 运行中 · 已运行 ${Math.round((Date.now() - p.startedAt) / 1000)}s]`
      : `[${id} 已退出 exit ${p.exitCode}]`
  const droppedNote = p.dropped > 0 ? `（更早的 ${p.dropped} 字符已滚出缓冲）\n` : ''
  return `${meta}\n${droppedNote}${out || '（暂无输出）'}`
}

/** 结束后台进程（Windows 用 taskkill 杀进程树，防止 shell 子进程残留） */
export function killBg(id: string): string {
  const p = procs.get(id)
  if (!p) return `不存在的后台进程 ${id}。当前进程：\n${listBg()}`
  if (p.status === 'exited') {
    procs.delete(id)
    return `${id} 已退出（exit ${p.exitCode}），已清理。`
  }
  try {
    if (process.platform === 'win32' && p.child.pid) {
      spawn('taskkill', ['/pid', String(p.child.pid), '/t', '/f'], { windowsHide: true })
    } else {
      p.child.kill('SIGTERM')
      const pid = p.child.pid
      setTimeout(() => {
        try {
          if (p.status === 'running' && pid) process.kill(pid, 'SIGKILL')
        } catch {
          /* 已退出 */
        }
      }, 3000)
    }
  } catch (e: any) {
    return `结束失败：${e?.message ?? String(e)}`
  }
  p.status = 'exited'
  return `已结束后台进程 ${id}（${p.command}）。`
}

export function listBg(): string {
  if (!procs.size) return '（无后台进程）'
  return [...procs.values()]
    .map(
      (p) =>
        `${p.id}  ${p.status === 'running' ? '运行中' : `已退出 exit ${p.exitCode}`}  ${p.command.slice(0, 80)}`
    )
    .join('\n')
}

// 应用退出时清理全部后台进程，避免残留孤儿进程
app?.on?.('will-quit', () => {
  for (const p of procs.values()) {
    if (p.status !== 'running') continue
    try {
      if (process.platform === 'win32' && p.child.pid) {
        spawn('taskkill', ['/pid', String(p.child.pid), '/t', '/f'], { windowsHide: true })
      } else {
        p.child.kill('SIGKILL')
      }
    } catch {
      /* ignore */
    }
  }
})
