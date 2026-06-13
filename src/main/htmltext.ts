// HTML → 纯文本（纯逻辑，无依赖，便于单测）。web_fetch 用它把网页转成可读文本回灌模型。

/** 去 script/style/注释，块级标签转换行，<li> 转列表项，解码常见实体，压缩空白 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  s = s
    .replace(/<\s*(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/pre)\s*\/?>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '')
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
  // 压缩空白：行内多空格合一，连续空行合一
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 提取 <title>（无则 null） */
export function htmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 200) || null : null
}

/**
 * SPA 空壳检测：静态 HTML 抓下来但正文极薄，说明内容由 JS 渲染。
 * @param html 原始 HTML
 * @param text 经 htmlToText 提取的正文
 */
export function looksLikeSpaShell(html: string, text: string): boolean {
  // 页面明示需要 JavaScript
  if (/enable\s+javascript|requires?\s+javascript|doesn'?t\s+work\s+without\s+javascript|请(?:启用|开启).{0,4}javascript/i.test(html)) {
    return true
  }
  const dense = text.replace(/\s+/g, '')
  if (dense.length < 200) return true // 正文过薄：典型空壳
  // 正文偏薄且存在空的框架挂载点（React/Vue/Next/Gatsby 常见 id）
  if (dense.length < 600 && /<div[^>]+id=["'](?:root|app|__next|___gatsby|q-app)["'][^>]*>\s*<\/div>/i.test(html)) {
    return true
  }
  return false
}
