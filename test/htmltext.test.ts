import { describe, it, expect } from 'vitest'
import { htmlToText, htmlTitle, looksLikeSpaShell } from '../src/main/htmltext'

describe('htmlToText', () => {
  it('剥离标签保留正文，块级标签转换行', () => {
    const text = htmlToText('<div><h1>标题</h1><p>第一段</p><p>第二段</p></div>')
    expect(text).toContain('标题')
    expect(text.split('\n').filter(Boolean)).toEqual(['标题', '第一段', '第二段'])
  })
  it('script/style/注释被移除', () => {
    const text = htmlToText('<script>alert(1)</script><style>.a{}</style><!-- c -->正文')
    expect(text).toBe('正文')
  })
  it('<li> 转列表项', () => {
    const text = htmlToText('<ul><li>甲</li><li>乙</li></ul>')
    expect(text).toContain('- 甲')
    expect(text).toContain('- 乙')
  })
  it('解码常见实体', () => {
    expect(htmlToText('a &lt;b&gt; &amp;&nbsp;&quot;c&quot;')).toBe('a <b> & "c"')
  })
  it('压缩连续空行与行内多空格', () => {
    const text = htmlToText('<p>a</p>\n\n\n\n<p>b   c</p>')
    expect(text).not.toMatch(/\n{3,}/)
    expect(text).toContain('b c')
  })
})

describe('htmlTitle', () => {
  it('提取并清理 title', () => {
    expect(htmlTitle('<head><title>  Node.js\n  Docs </title></head>')).toBe('Node.js Docs')
  })
  it('无 title 返回 null', () => {
    expect(htmlTitle('<p>x</p>')).toBeNull()
    expect(htmlTitle('<title></title>')).toBeNull()
  })
})

describe('looksLikeSpaShell', () => {
  const longText = '正文'.repeat(400) // 800 字符，足够厚

  it('正文极薄判定为空壳', () => {
    const html = '<html><body><div id="root"></div></body></html>'
    expect(looksLikeSpaShell(html, htmlToText(html))).toBe(true)
  })

  it('明示需要 JavaScript 判定为空壳（即使正文较长）', () => {
    const html = `<body><noscript>You need to enable JavaScript to run this app.</noscript>${longText}</body>`
    expect(looksLikeSpaShell(html, longText)).toBe(true)
    expect(looksLikeSpaShell(`<body>请启用 JavaScript${longText}</body>`, longText)).toBe(true)
  })

  it('正文偏薄（200-600 区间）+ 空挂载点判定为空壳', () => {
    const thin = '导航 首页 关于 联系我们 版权所有'.repeat(20) // 去空白后约 280 字符
    const html = `<body><nav>${thin}</nav><div id="app"></div></body>`
    expect(looksLikeSpaShell(html, thin)).toBe(true)
    // 同样厚度但没有空挂载点 → 不判空壳
    expect(looksLikeSpaShell(`<body><nav>${thin}</nav></body>`, thin)).toBe(false)
  })

  it('正文厚实的正常页面不误判', () => {
    const html = `<body><article>${longText}</article></body>`
    expect(looksLikeSpaShell(html, longText)).toBe(false)
  })
})
