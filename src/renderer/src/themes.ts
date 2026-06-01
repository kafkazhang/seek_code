import { ThemeId } from '@shared/types'

export interface ThemeMeta {
  id: ThemeId
  label: string
  desc: string
  /** 选择器预览色板：[页面底, 面板, 强调, 文字] */
  swatch: [string, string, string, string]
}

// 与 styles.css 中 [data-theme] 配色保持一致
export const THEMES: ThemeMeta[] = [
  { id: 'abyss', label: '深海声呐', desc: '默认 · 暗青', swatch: ['#05080f', '#0a1322', '#27e7d4', '#d7e6f5'] },
  { id: 'midnight', label: '午夜', desc: '靛蓝 · 紫罗兰', swatch: ['#070818', '#0d0f28', '#8b7bff', '#dcdcf5'] },
  { id: 'ember', label: '余烬', desc: '暖炭 · 琥珀', swatch: ['#0d0a07', '#1a1310', '#ff9d4d', '#f0e3d5'] },
  { id: 'forest', label: '林海', desc: '墨绿 · 薄荷', swatch: ['#050f0b', '#0a1a14', '#40e0a0', '#d6f0e4'] },
  { id: 'daylight', label: '昼光', desc: '浅色', swatch: ['#eef2f7', '#ffffff', '#0c9c8e', '#16233a'] }
]

const VALID = new Set(THEMES.map((t) => t.id))

/** 将主题应用到 <html data-theme>；非法值回退默认 abyss */
export function applyTheme(theme: ThemeId | undefined | null): void {
  const id: ThemeId = theme && VALID.has(theme) ? theme : 'abyss'
  document.documentElement.dataset.theme = id
}
