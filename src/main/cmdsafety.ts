// 纯命令安全分类（无 Electron / Node 依赖，便于单测）。
// 仅用于拦截「会误伤应用自身」「造成不可逆破坏」的命令，与权限模型配合。

// 会杀死应用自身的命令（按映像名/进程名批量杀 node/electron）——一律硬拒绝
const APP_KILLER_RE = [
  /taskkill\b[^|&;]*\/im\s+["']?node(\.exe)?["']?/i,
  /taskkill\b[^|&;]*\/im\s+["']?electron(\.exe)?["']?/i,
  /taskkill\b[^|&;]*\/im\s+["']?seekcode/i,
  /\b(killall|pkill)\b[^|&;\n]*\b(node|electron|seekcode)\b/i
]

export function isAppKiller(cmd: string): boolean {
  return APP_KILLER_RE.some((re) => re.test(cmd))
}

// 危险命令（可能造成不可逆破坏）——即使全自动也强制弹审批
const DANGEROUS_RE = [
  /\brm\s+-[a-z]*[rf]/i,
  /\bdel\s+\/[a-z]/i,
  /\brmdir\s+\/s/i,
  /\bformat\b/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-z]*[fd]/i,
  /\b(taskkill|kill|pkill|killall)\b/i,
  />\s*\/dev\/(sd|hd|disk)/i
]

export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_RE.some((re) => re.test(cmd))
}
