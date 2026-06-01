import { useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/common'

// 渲染 Markdown + 代码块语法高亮 + 每块「复制」按钮（纯本地，无 CDN）
export default function MarkdownView({
  source,
  className
}: {
  source: string
  className?: string
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => marked.parse(source) as string, [source])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.querySelectorAll('pre code').forEach((block) => {
      try {
        hljs.highlightElement(block as HTMLElement)
      } catch {
        /* 不支持的语言忽略 */
      }
    })
    el.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.code-copy')) return
      const btn = document.createElement('button')
      btn.className = 'code-copy'
      btn.type = 'button'
      btn.textContent = '复制'
      btn.onclick = (e: MouseEvent): void => {
        e.stopPropagation()
        const code = pre.querySelector('code')
        void navigator.clipboard.writeText(code?.textContent ?? '')
        btn.textContent = '已复制'
        window.setTimeout(() => (btn.textContent = '复制'), 1200)
      }
      pre.appendChild(btn)
    })
  }, [html])

  return <div ref={ref} className={className} dangerouslySetInnerHTML={{ __html: html }} />
}
