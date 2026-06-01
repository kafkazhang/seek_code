import { PermissionMode } from '@shared/types'

export interface ModeMeta {
  id: PermissionMode
  label: string
  desc: string
  key: string
}

// 顺序即循环顺序（Shift+Ctrl+M / 数字键）
export const MODES: ModeMeta[] = [
  { id: 'ask', label: '询问授权', desc: '每次写文件 / 执行命令都需确认', key: '1' },
  { id: 'acceptEdits', label: '接受编辑', desc: '自动写文件，命令仍需确认', key: '2' },
  { id: 'plan', label: '计划模式', desc: '只读分析，先产出实施方案', key: '3' },
  { id: 'auto', label: '全自动', desc: '写入与命令全部自动放行', key: '4' }
]

export const modeLabel = (m: PermissionMode): string => MODES.find((x) => x.id === m)?.label ?? m
export const nextMode = (m: PermissionMode): PermissionMode => {
  const i = MODES.findIndex((x) => x.id === m)
  return MODES[(i + 1) % MODES.length].id
}
