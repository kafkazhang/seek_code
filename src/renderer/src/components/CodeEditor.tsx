import { useEffect, useRef } from 'react'
import Editor, { DiffEditor, OnMount, BeforeMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { langOf, applyMonacoTheme, registerFim, SEEK_THEME } from '../monaco'

const COMMON_OPTS: editor.IStandaloneEditorConstructionOptions = {
  fontSize: 12.5,
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontLigatures: true,
  lineHeight: 20,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  renderWhitespace: 'selection',
  cursorBlinking: 'smooth',
  padding: { top: 10, bottom: 14 },
  tabSize: 2,
  automaticLayout: true,
  scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 }
}

// 监听 <html data-theme> 变化，换肤时重定义 Monaco 主题
function useThemeSync(): void {
  useEffect(() => {
    const obs = new MutationObserver(() => applyMonacoTheme())
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
}

export function CodeEditor({
  path,
  value,
  onChange,
  onSave,
  readOnly = false
}: {
  /** 文件相对路径：用作 model key，切 tab 时保留光标/撤销历史 */
  path: string
  /** 已保存内容（外部改动时更新；编辑期间应保持稳定） */
  value: string
  onChange?: (v: string) => void
  onSave?: () => void
  readOnly?: boolean
}): JSX.Element {
  useThemeSync()
  const saveRef = useRef(onSave)
  saveRef.current = onSave

  const beforeMount: BeforeMount = () => {
    applyMonacoTheme()
    registerFim()
  }
  const handleMount: OnMount = (ed, monaco) => {
    // Ctrl/Cmd+S 保存：用 ref 取最新回调，避免闭包过期
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.())
  }

  return (
    <Editor
      key={readOnly ? 'ro' : 'rw'}
      path={path}
      language={langOf(path)}
      value={value}
      theme={SEEK_THEME}
      beforeMount={beforeMount}
      onMount={handleMount}
      onChange={(v) => onChange?.(v ?? '')}
      loading={<div className="dock-empty">编辑器加载中…</div>}
      options={{ ...COMMON_OPTS, readOnly, inlineSuggest: { enabled: !readOnly } }}
    />
  )
}

// 只读 Diff 视图：替换手写 DiffView，获得语法高亮 + 行内/并排切换
export function CodeDiff({
  path,
  original,
  modified
}: {
  path: string
  original: string
  modified: string
}): JSX.Element {
  useThemeSync()
  const beforeMount: BeforeMount = () => applyMonacoTheme()
  return (
    <DiffEditor
      original={original}
      modified={modified}
      language={langOf(path)}
      theme={SEEK_THEME}
      beforeMount={beforeMount}
      loading={<div className="dock-empty">差异加载中…</div>}
      options={{
        ...COMMON_OPTS,
        readOnly: true,
        renderSideBySide: false,
        renderOverviewRuler: false,
        lineNumbers: 'on'
      }}
    />
  )
}
