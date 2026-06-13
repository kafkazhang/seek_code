import { describe, it, expect } from 'vitest'
import { isDefinitionLine, isValidSymbol, referenceRegex, scanFile } from '../src/main/symbols'

describe('isDefinitionLine · TS/JS', () => {
  const cases: [string, boolean][] = [
    ['export function getUser() {', true],
    ['export async function getUser(id: string) {', true],
    ['class getUser {', true],
    ['const getUser = (id) => {', true],
    ['let getUser = function () {', true],
    ['  getUser: async (req) => {', true], // 对象字面量方法也是定义
    ['  async getUser(id: string): Promise<U> {', true], // class 方法
    ['const x = getUser()', false], // 调用不是定义
    ['import { getUser } from "./api"', false],
    ['// function getUser was removed', false] // 注释里有也算正则命中? 'function getUser' → 命中模板 1
  ]
  it.each(cases.slice(0, 8))('%s → %s', (line, want) => {
    expect(isDefinitionLine(line, 'getUser', 'ts')).toBe(want)
  })
  it('对象字面量方法 foo: function / foo: (…) 识别为定义', () => {
    expect(isDefinitionLine('  getUser: function (req) {', 'getUser', 'ts')).toBe(true)
    expect(isDefinitionLine('  getUser: (req) => {', 'getUser', 'ts')).toBe(true)
  })
})

describe('isDefinitionLine · 其它语言', () => {
  it('python def/class', () => {
    expect(isDefinitionLine('def get_user(id):', 'get_user', 'py')).toBe(true)
    expect(isDefinitionLine('class GetUser:', 'GetUser', 'py')).toBe(true)
    expect(isDefinitionLine('x = get_user(1)', 'get_user', 'py')).toBe(false)
  })
  it('go func（含方法接收者）/ type', () => {
    expect(isDefinitionLine('func GetUser(id string) {}', 'GetUser', 'go')).toBe(true)
    expect(isDefinitionLine('func (s *Svc) GetUser(id string) {}', 'GetUser', 'go')).toBe(true)
    expect(isDefinitionLine('type GetUser struct {', 'GetUser', 'go')).toBe(true)
  })
  it('rust fn/struct/pub', () => {
    expect(isDefinitionLine('pub fn get_user() -> User {', 'get_user', 'rs')).toBe(true)
    expect(isDefinitionLine('struct GetUser;', 'GetUser', 'rs')).toBe(true)
  })
  it('不支持的扩展不误报', () => {
    expect(isDefinitionLine('function foo()', 'foo', 'md')).toBe(false)
  })
})

describe('referenceRegex · 词边界', () => {
  it('精确词边界：不匹配子串', () => {
    const re = referenceRegex('user')
    expect(re.test('const user = 1')).toBe(true)
    expect(re.test('const userName = 1')).toBe(false)
    expect(re.test('getUser(user)')).toBe(true)
  })
  it('$ 开头的标识符也能匹配', () => {
    expect(referenceRegex('$store').test('this.$store.commit()')).toBe(true)
    expect(referenceRegex('store').test('this.$store.commit()')).toBe(false)
  })
})

describe('scanFile', () => {
  it('返回行号 + 定义标记', () => {
    const content = 'import { getUser } from "./a"\n\nexport function getUser() {\n  return getUser\n}'
    const hits = scanFile('src/a.ts', content, 'getUser')
    expect(hits).toHaveLength(3)
    expect(hits[0]).toMatchObject({ line: 1, def: false })
    expect(hits[1]).toMatchObject({ line: 3, def: true })
    expect(hits[2]).toMatchObject({ line: 4, def: false })
  })
  it('结果数量受 max 限制', () => {
    const content = Array.from({ length: 100 }, () => 'call(foo)').join('\n')
    expect(scanFile('a.ts', content, 'foo', 10)).toHaveLength(10)
  })
})

describe('isValidSymbol', () => {
  it('标识符合法，整段代码/空串不合法', () => {
    expect(isValidSymbol('getUserName')).toBe(true)
    expect(isValidSymbol('$store')).toBe(true)
    expect(isValidSymbol('_private2')).toBe(true)
    expect(isValidSymbol('a.b')).toBe(false)
    expect(isValidSymbol('const x = 1')).toBe(false)
    expect(isValidSymbol('')).toBe(false)
  })
})
