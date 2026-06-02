// 纯命令安全分类（无 Electron / Node 依赖，便于单测）。
//
// 重要安全边界说明：
//   应用自身的网络出口（渲染层 webRequest + 主进程 net.fetch）受白名单强制约束，
//   但 run_command / 内置终端 spawn 出的【子进程】走的是操作系统网络栈，
//   不经过 Electron，因此【不受出口白名单约束】。
//   下面的 isNetworkCommand 是一道纵深防御：识别出可能联网的命令并强制人工审批，
//   降低（但无法根除）模型/全自动任务把代码外传的风险。它是黑名单启发式，不是隔离。

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

// 可能发起网络出站的命令——纵深防御：强制审批，提示用户该命令不受白名单约束。
// 注意：这是启发式黑名单，无法穷尽（如脚本内联网、间接执行），仅用于降低误放行风险。
const NETWORK_RE = [
  /\b(curl|wget|scp|sftp|rsync|nc|ncat|telnet|ftp|tftp)\b/i,
  /\bssh\b/i,
  /\bgit\s+(push|pull|fetch|clone|remote\s+add)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(publish|login)\b/i,
  /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|wget|curl)\b/i, // PowerShell 别名
  /\bStart-BitsTransfer\b/i,
  /\b(nslookup|dig|host)\b/i,
  /\b(python|python3|node|deno|ruby|php|perl)\b[^|&;]*\b(http|urllib|requests|fetch|socket|net\/http)\b/i
]

export function isNetworkCommand(cmd: string): boolean {
  return NETWORK_RE.some((re) => re.test(cmd))
}

export type CommandRisk = 'appkiller' | 'dangerous' | 'network' | 'safe'

/** 命令风险综合分类（优先级：自杀命令 > 危险 > 联网 > 安全） */
export function classifyCommand(cmd: string): CommandRisk {
  if (isAppKiller(cmd)) return 'appkiller'
  if (isDangerousCommand(cmd)) return 'dangerous'
  if (isNetworkCommand(cmd)) return 'network'
  return 'safe'
}
