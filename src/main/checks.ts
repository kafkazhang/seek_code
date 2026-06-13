// 项目检查命令探测（纯逻辑，无 Electron / 文件系统依赖，便于单测）。
// project_check 工具据此自动发现项目的 typecheck / lint / test 等质量门命令，
// 让模型改完代码后能一键自检——弥补"写完不验证"的短板。

export interface CheckCandidate {
  /** 展示名（typecheck / lint / test / cargo check …） */
  label: string
  /** 实际执行的命令 */
  command: string
}

/** npm scripts 中优先探测的脚本名（按运行顺序：先快后慢） */
const NPM_SCRIPT_PRIORITY = ['typecheck', 'tsc', 'check', 'lint', 'test']

const MAX_CANDIDATES = 4

/**
 * 探测可用的检查命令。
 * @param pkgJsonText 项目根 package.json 原文（无则 null）
 * @param rootEntries 项目根目录的文件名列表（探测 Cargo.toml / go.mod 等）
 */
export function detectChecks(pkgJsonText: string | null, rootEntries: string[]): CheckCandidate[] {
  const out: CheckCandidate[] = []

  if (pkgJsonText) {
    let scripts: Record<string, string> = {}
    try {
      scripts = JSON.parse(pkgJsonText)?.scripts ?? {}
    } catch {
      /* 损坏的 package.json 忽略 */
    }
    for (const name of NPM_SCRIPT_PRIORITY) {
      const body = scripts[name]
      if (typeof body !== 'string' || !body.trim()) continue
      // watch / serve / dev 类脚本会挂起，不能作为检查命令
      if (/\bwatch\b|--watch|\bserve\b|\bdev\b/i.test(body)) continue
      out.push({ label: name, command: name === 'test' ? 'npm test' : `npm run ${name}` })
      if (out.length >= MAX_CANDIDATES) return out
    }
  }

  const has = (f: string): boolean => rootEntries.includes(f)
  if (out.length < MAX_CANDIDATES && has('Cargo.toml')) out.push({ label: 'cargo check', command: 'cargo check' })
  if (out.length < MAX_CANDIDATES && has('go.mod')) out.push({ label: 'go vet', command: 'go vet ./...' })
  if (out.length < MAX_CANDIDATES && (has('gradlew') || has('gradlew.bat'))) {
    out.push({ label: 'gradle check', command: process.platform === 'win32' ? '.\\gradlew.bat check -q' : './gradlew check -q' })
  }
  return out.slice(0, MAX_CANDIDATES)
}

/** 单条检查输出的裁剪：保留头尾（错误通常在结尾），中间省略 */
export function clipCheckOutput(s: string, head = 400, tail = 1600): string {
  const t = s.trim()
  if (t.length <= head + tail + 40) return t
  return t.slice(0, head) + `\n…（中间省略 ${t.length - head - tail} 字符）…\n` + t.slice(-tail)
}
