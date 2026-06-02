import type OpenAI from 'openai'
import {
  getClient,
  modelFor,
  thinkingFor,
  systemPrompt,
  projectContextMessage,
  computeUsage,
  withRetry
} from './gateway'
import { toolDefs, execute, summarize, previewEdit, isDangerousCommand, isNetworkCommand, WRITE_TOOLS } from './tools'
import { mcpToolDefs, isMcpTool, callMcpTool } from './mcp'
import { AgentEvent, EditPreview, PermissionMode, PriorMessage, ProjectInfo, ReasoningMode, SendOptions } from '@shared/types'
import { getConfig } from './config'
import { memoryContext } from './memory'
import { symbolMap } from './codeindex'
import { recognizeImages } from './ocr'

type ChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam

interface Session {
  history: ChatMsg[]
  abort?: AbortController
}

const sessions = new Map<string, Session>()
const MAX_STEPS = 25
const MAX_SESSIONS = 50 // 内存中保留的最大会话数，超出按最久未用淘汰（避免长期运行内存只增不减）

/** 取/建会话，并按 LRU 维护：命中即移到末尾；超额淘汰最久未用（含中断其残留请求） */
function touchSession(sessionId: string): Session {
  let s = sessions.get(sessionId)
  if (s) {
    sessions.delete(sessionId) // 重新插入 → 移到 Map 末尾，标记为最近使用
  } else {
    s = { history: [] }
  }
  sessions.set(sessionId, s)
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined
    if (oldest === undefined || oldest === sessionId) break
    sessions.get(oldest)?.abort?.abort()
    sessions.delete(oldest)
  }
  return s
}

// ── 上下文压缩 ───────────────────────────────────────
// 会话历史跨轮次无限增长会撑爆上下文窗口、推高成本。当历史体量超过阈值时，
// 把较早的部分用 fast 档模型摘要成一条，仅保留最近若干 token 的原文。
// 裁剪点只选在 user 消息边界——user 消息天然是回合分界、且从不携带 tool_call 依赖，
// 因此不会切断「assistant.tool_calls ↔ tool 结果」的配对（否则接口会报错）。
const COMPACT_TRIGGER_TOKENS = 48_000 // 历史超过此估算值才触发压缩
const COMPACT_KEEP_TOKENS = 16_000 // 压缩后保留的最近原文预算
const COMPACT_MIN_MESSAGES = 8 // 消息太少不压缩

function msgText(m: ChatMsg): string {
  const c: any = (m as any).content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join(' ')
  return ''
}

// token 估算：CJK 字符的 token 密度远高于 ASCII（约 1.5 字符/token vs 4 字符/token），
// 分别计权可显著降低中英混排时的估算偏差，使压缩触发时机更准。
function estTokensOfText(text: string): number {
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // CJK 统一表意文字 / 扩展 A / 兼容 / 假名 / 谚文等高密度区段
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)) cjk++
  }
  const ascii = text.length - cjk
  return Math.round(ascii / 4 + cjk / 1.5)
}

function estTokens(messages: ChatMsg[]): number {
  let total = 0
  for (const m of messages) {
    total += estTokensOfText(msgText(m))
    const tc = (m as any).tool_calls as Array<{ function?: { arguments?: string } }> | undefined
    if (tc) for (const t of tc) total += estTokensOfText(t.function?.arguments ?? '')
  }
  return total
}

/** 找到一个安全的裁剪下标：从后往前累计至 keep 预算，落在最近的 user 消息边界。 */
function findCutIndex(history: ChatMsg[]): number {
  let acc = 0
  let cut = history.length
  for (let i = history.length - 1; i >= 0; i--) {
    acc += estTokens([history[i]])
    if (acc >= COMPACT_KEEP_TOKENS && history[i].role === 'user') {
      cut = i
      break
    }
  }
  // 没找到合适的 user 边界（如全是长 assistant/tool）→ 不压缩，避免破坏配对
  return cut === history.length ? -1 : cut
}

/** 压缩会话历史：把 [0, cut) 摘要为一条 system 消息，保留 [cut, end) 原文。失败则原样返回。 */
async function compactHistory(s: Session): Promise<void> {
  if (s.history.length < COMPACT_MIN_MESSAGES) return
  if (estTokens(s.history) < COMPACT_TRIGGER_TOKENS) return
  const cut = findCutIndex(s.history)
  if (cut <= 1) return // 没有可压缩的前缀

  const older = s.history.slice(0, cut)
  const transcript = older
    .map((m) => {
      const role = m.role === 'assistant' ? 'AI' : m.role === 'user' ? '用户' : m.role === 'tool' ? '工具结果' : m.role
      const tc = (m as any).tool_calls as Array<{ function?: { name?: string } }> | undefined
      const calls = tc?.length ? `（调用工具：${tc.map((t) => t.function?.name).filter(Boolean).join(', ')}）` : ''
      return `${role}${calls}: ${msgText(m).slice(0, 1500)}`
    })
    .join('\n')
    .slice(0, 60_000)

  try {
    const client = getClient()
    const res = await client.chat.completions.create({
      model: modelFor('fast'),
      thinking: { type: 'disabled' },
      temperature: 0.2,
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            '你是对话压缩器。把下面这段「AI 结对编程」的较早对话浓缩成简洁要点，供后续继续工作时参考。' +
            '务必保留：用户的目标与约束、已做出的关键决策、已创建/修改的文件及其作用、未完成的待办、重要结论。' +
            '不要编造，不要客套，用中文分条输出。'
        },
        { role: 'user', content: transcript }
      ]
    } as any)
    const summary = res.choices?.[0]?.message?.content?.trim()
    if (!summary) return
    s.history = [
      { role: 'system', content: `【早前对话摘要（已压缩 ${older.length} 条消息）】\n${summary}` },
      ...s.history.slice(cut)
    ]
  } catch {
    /* 压缩失败：保持原历史，宁可长也不丢内容 */
  }
}

export type Emit = (e: AgentEvent) => void
export type ApprovalFn = (
  sessionId: string,
  name: string,
  summary: string,
  preview?: EditPreview
) => Promise<boolean>

export function abortSession(sessionId: string): void {
  sessions.get(sessionId)?.abort?.abort()
}
export function resetSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export async function runAgent(
  sessionId: string,
  userText: string,
  options: SendOptions,
  project: ProjectInfo | null,
  emit: Emit,
  approve: ApprovalFn,
  priorMessages: PriorMessage[] = [],
  images: string[] = []
): Promise<void> {
  const cfg = getConfig()
  const mode: ReasoningMode = options.reasoning ?? cfg.reasoning
  const perm: PermissionMode = options.permissionMode ?? cfg.permissionMode
  const client = getClient()
  const model = modelFor(mode)
  // 计划模式：追加只读指令（置于消息尾部，不破坏稳定前缀缓存）
  const planTail: ChatMsg | null =
    perm === 'plan' ? { role: 'system', content: PLAN_DIRECTIVE } : null

  const s = touchSession(sessionId)
  const abort = new AbortController()
  s.abort = abort

  // 恢复会话（应用重启后主进程无内存历史）：用精简文本回灌上下文
  if (s.history.length === 0 && priorMessages.length) {
    for (const pm of priorMessages) {
      if (pm.content && (pm.role === 'user' || pm.role === 'assistant')) {
        s.history.push({ role: pm.role, content: pm.content })
      }
    }
  }

  // 缓存优先：稳定前缀(system) + 半稳定(项目地图 + 记忆) 永远置顶且保持一致
  const prefix: ChatMsg[] = [{ role: 'system', content: systemPrompt() }]
  if (project) {
    try {
      const sm = await symbolMap(project.root)
      prefix.push({
        role: 'system',
        content: `当前项目：${project.name}\n根目录：${project.root}\n\n${sm.map}`
      })
    } catch {
      const pctx = projectContextMessage(project)
      if (pctx) prefix.push({ role: 'system', content: pctx })
    }
  }
  const mem = memoryContext(project?.root ?? null)
  if (mem) prefix.push({ role: 'system', content: mem })

  // 历史过长时先压缩较早部分（仅在 user 边界裁剪，不破坏 tool_call 配对）
  await compactHistory(s)

  // 识图：DeepSeek 的 /chat/completions 不接受图片字段（实测 400 unknown variant `image_url`），
  // 因此改走"本地 OCR 提取文字 → 拼进 prompt"。完全离线，不依赖任何视觉接口。
  if (images.length) {
    emit({ type: 'status', sessionId, text: `正在识别 ${images.length} 张截图中的文字…`, mode })
    let ocrTexts: string[] = []
    try {
      ocrTexts = await recognizeImages(images)
    } catch {
      /* OCR 引擎初始化/识别失败：降级为提示，让模型友善告知用户 */
    }
    const recognized = ocrTexts.filter((t) => t.trim().length > 0)
    s.history.push({
      role: 'user',
      content: recognized.length ? userText + ocrBlock(ocrTexts) : userText + ocrFailNote(images.length)
    })
  } else {
    s.history.push({ role: 'user', content: userText })
  }
  emit({ type: 'status', sessionId, text: mode === 'deep' ? '深度推理中…' : '思考中…', mode })

  // 流式请求：对瞬时错误（429 / 5xx / 网络抖动）指数退避重试，用户中断不重试
  const createStream = (request: any): Promise<unknown> =>
    withRetry(() => client.chat.completions.create(request, { signal: abort.signal }) as Promise<unknown>)

  let autoContinues = 0
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (abort.signal.aborted) return void emit({ type: 'aborted', sessionId })

      // DeepSeek-V4：thinking 独立于 tools/temperature，三档均可带工具
      const req: any = {
        model,
        messages: planTail ? [...prefix, ...s.history, planTail] : [...prefix, ...s.history],
        thinking: thinkingFor(mode),
        temperature: 0.2,
        tools: [...toolDefs, ...mcpToolDefs()],
        tool_choice: 'auto',
        stream: true,
        stream_options: { include_usage: true }
      }

      const stream = await createStream(req)

      let content = ''
      const toolAcc: Record<number, { id: string; name: string; args: string }> = {}
      let rawUsage: unknown = null

      for await (const chunk of stream as any) {
        const delta = chunk.choices?.[0]?.delta
        if (delta?.content) {
          content += delta.content
          emit({ type: 'delta', sessionId, text: delta.content })
        }
        if (delta?.reasoning_content) {
          emit({ type: 'reasoning', sessionId, text: delta.reasoning_content })
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0
            const acc = (toolAcc[i] ??= { id: '', name: '', args: '' })
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name = tc.function.name
            if (tc.function?.arguments) acc.args += tc.function.arguments
          }
        }
        if (chunk.usage) rawUsage = chunk.usage
      }

      if (rawUsage) emit({ type: 'usage', sessionId, usage: computeUsage(rawUsage) })

      const toolCalls = Object.values(toolAcc).filter((t) => t.name)
      const assistantMsg: any = { role: 'assistant', content: content || null }
      if (toolCalls.length) {
        assistantMsg.tool_calls = toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: t.args || '{}' }
        }))
      }
      s.history.push(assistantMsg)

      if (!toolCalls.length) {
        // 模型只"宣布要做"却没调用工具 → 自动催它用工具继续（有界，防死循环）
        if (autoContinues < MAX_AUTO_CONTINUE && shouldAutoContinue(content)) {
          autoContinues++
          s.history.push({ role: 'user', content: AUTO_NUDGE })
          emit({ type: 'status', sessionId, text: '继续执行…', mode })
          continue
        }
        return void emit({ type: 'done', sessionId })
      }

      autoContinues = 0 // 有工具调用＝有进展，重置计数
      for (const t of toolCalls) {
        if (abort.signal.aborted) return void emit({ type: 'aborted', sessionId })
        let args: Record<string, any> = {}
        try {
          args = JSON.parse(t.args || '{}')
        } catch {
          /* 容错 */
        }
        emit({ type: 'tool', sessionId, callId: t.id, name: t.name, args: t.args || '{}', status: 'running' })

        let result: string
        if (!project) {
          result = '请先打开一个项目文件夹，再进行文件或命令操作。'
          emit({ type: 'tool', sessionId, callId: t.id, name: t.name, args: t.args || '{}', status: 'error', result })
          s.history.push({ role: 'tool', tool_call_id: t.id, content: result })
          continue
        }

        // 写/建文件：预先计算 diff（既供审批，也在完成后内联展示，让用户看到改动）
        let editPreview: EditPreview | undefined
        if (t.name === 'write_file' || t.name === 'edit_file') {
          editPreview = (await previewEdit(t.name, args, project.root)) ?? undefined
        }

        // 计划模式：禁止一切写入/执行，反馈以促使其产出方案
        if (perm === 'plan' && WRITE_TOOLS.has(t.name)) {
          result =
            '【计划模式】当前为只读分析，不执行写入或命令。请先输出完整实施计划（将创建/修改的文件与步骤），经用户批准并切换执行模式后再动手。'
          emit({ type: 'tool', sessionId, callId: t.id, name: t.name, args: t.args || '{}', status: 'denied', result })
          s.history.push({ role: 'tool', tool_call_id: t.id, content: result })
          continue
        }

        // 危险命令（如 taskkill / rm -rf / shutdown）即使在全自动模式也强制审批
        const cmd = args.command ?? ''
        const dangerousCmd = t.name === 'run_command' && isDangerousCommand(cmd)
        // 联网命令（curl/git push/ssh…）即使全自动也强制审批：子进程出网不受白名单约束，存在外传风险
        const networkCmd = t.name === 'run_command' && !dangerousCmd && isNetworkCommand(cmd)
        // MCP 外部工具：在询问/接受编辑模式下需审批（可能有外部副作用）
        const mcpNeedsApproval = isMcpTool(t.name) && (perm === 'ask' || perm === 'acceptEdits')
        if (needsApproval(perm, t.name) || dangerousCmd || networkCmd || mcpNeedsApproval) {
          const sum = dangerousCmd
            ? '⚠ 危险命令 · ' + summarize(t.name, args)
            : networkCmd
              ? '🌐 联网命令（出网不受白名单约束） · ' + summarize(t.name, args)
              : summarize(t.name, args)
          const ok = await approve(sessionId, t.name, sum, editPreview)
          if (!ok) {
            result = '用户拒绝了该操作。'
            emit({ type: 'tool', sessionId, callId: t.id, name: t.name, args: t.args || '{}', status: 'denied', result })
            s.history.push({ role: 'tool', tool_call_id: t.id, content: result })
            continue
          }
        }

        try {
          result = isMcpTool(t.name)
            ? await callMcpTool(t.name, args)
            : await execute(t.name, args, { root: project.root })
          emit({
            type: 'tool',
            sessionId,
            callId: t.id,
            name: t.name,
            args: t.args || '{}',
            status: 'done',
            result: clip(result, clipLimitFor(t.name)),
            preview: editPreview
          })
        } catch (e: any) {
          result = '错误：' + (e?.message ?? String(e))
          emit({ type: 'tool', sessionId, callId: t.id, name: t.name, args: t.args || '{}', status: 'error', result })
        }
        s.history.push({ role: 'tool', tool_call_id: t.id, content: result })
      }
    }
    emit({ type: 'done', sessionId })
  } catch (e: any) {
    if (abort.signal.aborted) emit({ type: 'aborted', sessionId })
    else emit({ type: 'error', sessionId, message: e?.message ?? String(e) })
  }
}

function clip(s: string, n = 800): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

// UI 展示用的工具结果截断上限（不影响回灌给模型的完整结果）。
// 读类工具放宽，便于用户在面板里看清检索/读取到的内容。
const READ_TOOLS = new Set(['read_file', 'search_code', 'grep', 'list_dir', 'read_skill'])
function clipLimitFor(name: string): number {
  return READ_TOOLS.has(name) ? 2400 : 800
}

// ── 识图：本地 OCR 文本拼装 ───────────────────────────────────────
/** 把各张截图的 OCR 文本拼成给模型的上下文块。空结果的图片也标注，便于模型判断。 */
function ocrBlock(texts: string[]): string {
  const parts = texts.map((t, i) => {
    const body = t.trim()
    return `--- 截图 ${i + 1} ---\n${body || '（未识别到文字）'}`
  })
  return (
    `\n\n[以下为用户所附 ${texts.length} 张截图的本地 OCR 文字识别结果（可能存在识别误差，请结合上下文理解）：\n` +
    parts.join('\n\n') +
    `\n]`
  )
}

/** OCR 完全失败或无任何文字时的说明：让模型友善告知用户。 */
function ocrFailNote(n: number): string {
  return `\n\n[系统提示：用户附带了 ${n} 张截图，但本地 OCR 未能识别出文字（可能是纯图形界面、分辨率过低或引擎初始化失败）。请用一句话友善告知用户未能从截图中读到文字，并请其用文字补充描述关键信息。]`
}

const PLAN_DIRECTIVE = `【计划模式 / Plan Mode】当前为只读模式：你可以使用 read_file / list_dir / grep 充分了解代码，但禁止调用 write_file / edit_file / run_command。
请在调研后输出一份清晰的实施计划：要改动/新建的文件清单、关键步骤、风险点。不要实际修改任何东西——等用户批准并切换到执行模式后再动手。`

/** 按权限模式判断某工具是否需要用户批准 */
function needsApproval(perm: PermissionMode, name: string): boolean {
  if (perm === 'auto' || perm === 'plan') return false
  if (perm === 'acceptEdits') return name === 'run_command' // 仅命令需批准，编辑自动放行
  return WRITE_TOOLS.has(name) // ask：写入/命令均需批准
}

const MAX_AUTO_CONTINUE = 3
const AUTO_NUDGE =
  '请立即用工具继续并真正完成上述工作：需要创建/修改文件就直接调用 write_file / edit_file，不要只描述计划。全部完成后再给出简短总结。'

/** 判断模型是否"只宣布意图却没动手"，用于触发自动续跑 */
function shouldAutoContinue(text: string): boolean {
  if (!text) return false
  // 已表述完成的，不再催
  if (/已完成|完成了|已创建|已经(创建|实现|写好|改好|生成)|搞定|大功告成|已生成|已写入/.test(text)) return false
  // 含有明显的"将要动手"意图
  return /(我来|让我|现在(就|开始|来)?|接下来|下一步|马上|稍后|我将|我会|开始(创建|实现|编写|动手|设计)|准备(创建|实现|编写)|为你(打造|创建|实现|设计))/.test(
    text
  )
}
