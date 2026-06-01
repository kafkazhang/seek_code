// Monaco 引导：纯本地 worker（Vite ?worker，不走 CDN）、品牌主题、FIM 行内补全。
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

// 把 worker 指向本地打包产物：满足「代码不出本机」，且离线可用。
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  }
}

// 让 @monaco-editor/react 使用本地 monaco 实例，而非默认从 CDN 下载。
loader.config({ monaco })

export { monaco }

// 扩展名 → Monaco language id
const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml', vue: 'html',
  md: 'markdown', markdown: 'markdown', py: 'python', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', rb: 'ruby', sh: 'shell', bash: 'shell', zsh: 'shell',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', sql: 'sql',
  dockerfile: 'dockerfile', graphql: 'graphql', lua: 'lua', r: 'r', swift: 'swift'
}
export function langOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return LANG[ext] ?? 'plaintext'
}

// —— 主题：运行时读取当前 CSS 变量，定义与品牌一致的配色 —— //
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
// 将任意 CSS 颜色规范化为 Monaco 接受的 #rrggbb[aa]
function toHex(input: string, fallback: string): string {
  if (!input) return fallback
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return fallback
  try {
    ctx.fillStyle = input
    const s = ctx.fillStyle
    if (s.startsWith('#')) return s
    const m = s.match(/rgba?\(([^)]+)\)/)
    if (!m) return fallback
    const p = m[1].split(',').map((x) => x.trim())
    const r = parseInt(p[0], 10), g = parseInt(p[1], 10), b = parseInt(p[2], 10)
    const a = p[3] !== undefined ? Math.round(parseFloat(p[3]) * 255) : 255
    const h = (n: number): string => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
    return '#' + h(r) + h(g) + h(b) + (a < 255 ? h(a) : '')
  } catch {
    return fallback
  }
}

export const SEEK_THEME = 'seek'

// 依据当前 [data-theme] 重新定义并应用 Monaco 主题（换肤时调用）。
export function applyMonacoTheme(): void {
  const isLight = document.documentElement.dataset.theme === 'daylight'
  const bg = toHex(cssVar('--abyss'), isLight ? '#ffffff' : '#05080f')
  const fg = toHex(cssVar('--text'), isLight ? '#16233a' : '#d7e6f5')
  const dim = toHex(cssVar('--dim'), '#7e96b4')
  const faint = toHex(cssVar('--faint'), '#48607e')
  const accent = toHex(cssVar('--sonar'), '#27e7d4')
  const amber = toHex(cssVar('--amber'), '#ffc24b')
  const coral = toHex(cssVar('--coral'), '#ff7d5c')
  const blue = toHex(cssVar('--blue'), '#4d9bff')
  const good = toHex(cssVar('--good'), '#3fe6a4')
  const surface = toHex(cssVar('--surface'), isLight ? '#eef2f7' : '#10203a')

  monaco.editor.defineTheme(SEEK_THEME, {
    base: isLight ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: fg.slice(1) },
      { token: 'comment', foreground: faint.slice(1), fontStyle: 'italic' },
      { token: 'keyword', foreground: accent.slice(1) },
      { token: 'number', foreground: amber.slice(1) },
      { token: 'string', foreground: good.slice(1) },
      { token: 'type', foreground: blue.slice(1) },
      { token: 'function', foreground: blue.slice(1) },
      { token: 'variable', foreground: fg.slice(1) },
      { token: 'delimiter', foreground: dim.slice(1) },
      { token: 'tag', foreground: coral.slice(1) },
      { token: 'attribute.name', foreground: amber.slice(1) }
    ],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editorLineNumber.foreground': faint,
      'editorLineNumber.activeForeground': accent,
      'editorCursor.foreground': accent,
      'editor.selectionBackground': accent + '33',
      'editor.inactiveSelectionBackground': accent + '22',
      'editor.lineHighlightBackground': surface + '55',
      'editorIndentGuide.background1': faint + '33',
      'editorWhitespace.foreground': faint + '55',
      'editorGutter.background': bg,
      'editorWidget.background': surface,
      'editorWidget.border': faint + '66',
      'editorSuggestWidget.background': surface,
      'editorSuggestWidget.selectedBackground': accent + '22',
      'editorGhostText.foreground': faint,
      'minimap.background': bg,
      'scrollbarSlider.background': faint + '44',
      'scrollbarSlider.hoverBackground': faint + '77'
    }
  })
  monaco.editor.setTheme(SEEK_THEME)
}

// —— FIM 行内补全（ghost text）：复用主进程 window.seek.fim —— //
let fimRegistered = false
let fimEnabled = true
export function setFimEnabled(on: boolean): void {
  fimEnabled = on
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function registerFim(): void {
  if (fimRegistered) return
  fimRegistered = true
  monaco.languages.registerInlineCompletionsProvider(
    { pattern: '**' },
    {
      async provideInlineCompletions(model, position, _ctx, token) {
        if (!fimEnabled) return { items: [] }
        // 防抖：等待停顿；期间若继续输入，monaco 会取消本次请求。
        await sleep(320)
        if (token.isCancellationRequested) return { items: [] }

        const offset = model.getOffsetAt(position)
        const full = model.getValue()
        // 限制上下文窗口，控制 token 成本
        const prefix = full.slice(Math.max(0, offset - 4000), offset)
        const suffix = full.slice(offset, offset + 2000)
        if (!prefix.trim()) return { items: [] }

        const text = await window.seek.fim(prefix, suffix).catch(() => '')
        if (!text || token.isCancellationRequested) return { items: [] }
        return {
          items: [
            {
              insertText: text,
              range: new monaco.Range(
                position.lineNumber,
                position.column,
                position.lineNumber,
                position.column
              )
            }
          ]
        }
      },
      freeInlineCompletions() {
        /* 无需释放资源 */
      }
    }
  )
}
