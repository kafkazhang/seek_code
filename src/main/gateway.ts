import OpenAI from 'openai'
import { getApiKey, getConfig } from './config'
import { isEgressAllowed, guardedFetch } from './egress'
import { BalanceResult, ProjectInfo, ReasoningMode, ThinkingParam, UsageSnapshot } from '@shared/types'

/** 推理出口断言：baseURL 必须在出口白名单内（setConfig 会自动同步），防止被篡改的配置绕过白名单出网。 */
function assertInferenceEgress(baseURL: string): void {
  let host = ''
  try {
    host = new URL(baseURL).hostname
  } catch {
    throw new Error('接口地址（baseURL）非法：' + baseURL)
  }
  if (!isEgressAllowed(host)) {
    throw new Error(`推理接口 ${host} 不在出口白名单内，已拒绝出网`)
  }
}

// DeepSeek 网关：全应用唯一发起外网请求的模块。
// 采用 OpenAI 兼容协议，仅需 baseURL + apiKey。

export class NoKeyError extends Error {
  constructor() {
    super('尚未配置 DeepSeek API Key')
    this.name = 'NoKeyError'
  }
}

export function getClient(): OpenAI {
  const key = getApiKey()
  if (!key) throw new NoKeyError()
  const cfg = getConfig()
  assertInferenceEgress(cfg.baseURL)
  return new OpenAI({ apiKey: key, baseURL: cfg.baseURL })
}

/** 推理档位 → 模型：fast→flash；balanced/deep→pro */
export function modelFor(mode: ReasoningMode): string {
  const cfg = getConfig()
  return mode === 'fast' ? cfg.flashModel : cfg.proModel
}

/**
 * 推理档位 → DeepSeek-V4 `thinking` 参数。
 * V4 的关键变化：thinking 与 tools/temperature 解耦，三档都可带工具。
 *  - fast     → flash，关闭思考，最快最省
 *  - balanced → pro，开启思考，effort=high
 *  - deep     → pro，开启思考，effort=max
 */
export function thinkingFor(mode: ReasoningMode): ThinkingParam {
  if (mode === 'fast') return { type: 'disabled' }
  if (mode === 'balanced') return { type: 'enabled', reasoning_effort: 'high' }
  return { type: 'enabled', reasoning_effort: 'max' }
}

// ── 缓存优先：稳定前缀（系统提示）——跨会话、跨轮次保持完全一致 ──
const STABLE_SYSTEM = `你是 SeekCode —— 一个运行在用户本机的 AI 结对程序员，由 DeepSeek 驱动。

【最重要的行为准则：立即动手，不要只宣布计划】
- 当任务需要创建或修改文件时，**必须在本回合直接调用 write_file / edit_file 工具实际完成**，绝不允许只说"我来创建…/接下来我会写…"然后就结束。
- 严禁把完整代码贴在聊天里代替写文件；要落地就调用 write_file 写入真实文件。
- 一个回合里可以连续调用多个工具。持续调用工具推进，直到任务**真正全部完成**为止，中途不要停下来等待用户确认（除非遇到必须由用户决策的歧义）。
- 只有当工作确实做完、文件已落盘后，才用一两句话做简短总结（说明创建/修改了哪些文件）。这条总结不应包含"我将要做"这类未来式措辞。

【其它原则】
1. 纯本地：除本次推理外，用户代码不离开其机器。
2. 动手优先：需要了解代码时调用 read_file / grep / list_dir 获取真实内容，不要臆测。
3. 收集事实后立即落地：用 edit_file 做精确替换，用 write_file 创建/覆盖整文件。
4. 中文交流：用简洁中文回答；代码与命令保持原文。
5. 谨慎执行：run_command 可能有副作用，仅在确有必要时使用，并说明意图。
6. 进程安全：需要停止某个服务/进程时，**先按端口或 PID 精确定位再结束**（如 \`netstat -ano | findstr :端口\` / \`lsof -i :端口\` 找到 PID，再 \`taskkill /f /pid <PID>\` 或 \`kill <PID>\`）。**严禁**用 \`taskkill /im node.exe\`、\`killall node\`、\`pkill node\` 这类按名批量杀进程——那会把 SeekCode 自身一起杀掉。
7. 善用技能：遇到特定任务（如代码审查、写提交信息）时，可先用 list_skills 查看是否有可复用技能，命中则 read_skill 加载后据其执行。`

/**
 * 稳定系统前缀——刻意不随推理档位变化，使其在 fast/balanced/deep 间
 * 保持字节一致，从而稳定命中 DeepSeek 服务端前缀缓存（思考深度交给 thinking 参数控制）。
 */
export function systemPrompt(): string {
  return STABLE_SYSTEM
}

/** 半稳定层：项目代码地图。仅在打开/切换项目时变化，置于稳定前缀之后以利缓存。 */
export function projectContextMessage(project: ProjectInfo | null): string | null {
  if (!project) return null
  const lines: string[] = []
  walk(project.tree, '', lines)
  const map = lines.slice(0, 400).join('\n')
  return `当前项目：${project.name}\n根目录：${project.root}\n\n项目结构（代码地图）：\n${map}`
}

function walk(nodes: { name: string; type: string; children?: any[] }[], prefix: string, out: string[]): void {
  for (const n of nodes) {
    out.push(prefix + (n.type === 'dir' ? n.name + '/' : n.name))
    if (n.children && n.children.length) walk(n.children as any, prefix + '  ', out)
  }
}

// ── 成本核算：用 DeepSeek 返回的缓存命中 token 估算花费与省下金额 ──
export function computeUsage(raw: unknown): UsageSnapshot {
  const u = (raw ?? {}) as Record<string, number>
  const prompt = u.prompt_tokens ?? 0
  const completion = u.completion_tokens ?? 0
  // DeepSeek 专有字段
  const hit = u.prompt_cache_hit_tokens ?? 0
  const miss = u.prompt_cache_miss_tokens ?? Math.max(prompt - hit, 0)
  const { pricing } = getConfig()
  const M = 1_000_000
  const cost =
    (hit * pricing.cacheHitInput) / M +
    (miss * pricing.cacheMissInput) / M +
    (completion * pricing.output) / M
  // 若这些命中 token 全部按未命中计价，会多花多少 → 即省下金额
  const saved = (hit * (pricing.cacheMissInput - pricing.cacheHitInput)) / M
  const cacheHitRate = prompt > 0 ? hit / prompt : 0
  return {
    promptTokens: prompt,
    completionTokens: completion,
    cacheHitTokens: hit,
    cacheMissTokens: miss,
    cacheHitRate,
    cost,
    saved
  }
}

/**
 * 查询 DeepSeek 账户余额（GET /user/balance）。
 * 该接口非 OpenAI 兼容协议，直接走受控 fetch（host 已在出口白名单内）。
 * 返回首个币种的总可用余额（granted + topped_up）。
 */
export async function getBalance(): Promise<BalanceResult> {
  const key = getApiKey()
  if (!key) return { ok: false, error: '尚未配置 DeepSeek API Key' }
  const cfg = getConfig()
  assertInferenceEgress(cfg.baseURL)
  const url = cfg.baseURL.replace(/\/$/, '') + '/user/balance'
  try {
    const res = await guardedFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}` }
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const data = (await res.json()) as {
      is_available?: boolean
      balance_infos?: { currency?: string; total_balance?: string }[]
    }
    const info = data.balance_infos?.[0]
    return {
      ok: true,
      isAvailable: data.is_available,
      currency: info?.currency,
      totalBalance: info?.total_balance
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** FIM 代码补全（DeepSeek beta completions，prefix + suffix） */
export async function fim(prefix: string, suffix: string, maxTokens = 128): Promise<string> {
  const key = getApiKey()
  if (!key) throw new NoKeyError()
  const cfg = getConfig()
  assertInferenceEgress(cfg.baseURL)
  const client = new OpenAI({ apiKey: key, baseURL: cfg.baseURL.replace(/\/$/, '') + '/beta' })
  const res = await client.completions.create({
    model: cfg.fimModel,
    prompt: prefix,
    suffix,
    max_tokens: maxTokens,
    temperature: 0.1
  } as any)
  return res.choices?.[0]?.text ?? ''
}
