// 极简 ANSI 解析：SGR 颜色/加粗 → 带类名片段；其余转义（光标/清屏/OSC）剥离
export interface AnsiSpan {
  text: string
  cls: string
}

const ESC = String.fromCharCode(27)
const FG: Record<number, string> = {
  30: 'a-black',
  31: 'a-red',
  32: 'a-green',
  33: 'a-yellow',
  34: 'a-blue',
  35: 'a-magenta',
  36: 'a-cyan',
  37: 'a-white',
  90: 'a-gray',
  91: 'a-red',
  92: 'a-green',
  93: 'a-yellow',
  94: 'a-blue',
  95: 'a-magenta',
  96: 'a-cyan',
  97: 'a-white'
}

const OSC = new RegExp(ESC + '\\][\\s\\S]*?(?:' + String.fromCharCode(7) + '|' + ESC + '\\\\)', 'g')
const CSI_OTHER = new RegExp(ESC + '\\[[0-9;?]*[ABCDEFGHJKSTfhln]', 'g')
const SGR = new RegExp(ESC + '\\[([0-9;]*)m', 'g')

export function ansiToSpans(input: string): AnsiSpan[] {
  const text = input.replace(OSC, '').replace(CSI_OTHER, '')
  const spans: AnsiSpan[] = []
  let cls = ''
  let bold = false
  let last = 0
  let m: RegExpExecArray | null
  const push = (t: string): void => {
    if (t) spans.push({ text: t, cls: (bold ? 'a-bold ' : '') + cls })
  }
  SGR.lastIndex = 0
  while ((m = SGR.exec(text))) {
    push(text.slice(last, m.index))
    last = SGR.lastIndex
    const codes = m[1] ? m[1].split(';').map(Number) : [0]
    for (const c of codes) {
      if (c === 0) {
        cls = ''
        bold = false
      } else if (c === 1) bold = true
      else if (c === 22) bold = false
      else if (c === 39) cls = ''
      else if (FG[c]) cls = FG[c]
    }
  }
  push(text.slice(last))
  return spans.length ? spans : [{ text, cls: '' }]
}
