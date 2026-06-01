import { useRef } from 'react'

// 通用竖向拖拽分隔条：上报相对拖拽起点的累计位移 dx（px）。
// 调用方在 onStart 中快照起始宽度，在 onResize 中按 起始宽度 + dx 计算新宽度。
export default function DragHandle({
  className,
  onStart,
  onResize
}: {
  className?: string
  onStart?: () => void
  onResize: (dx: number) => void
}): JSX.Element {
  const startX = useRef(0)
  function down(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    startX.current = e.clientX
    onStart?.()
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const move = (ev: PointerEvent): void => onResize(ev.clientX - startX.current)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return <div className={'drag-h' + (className ? ' ' + className : '')} onPointerDown={down} />
}
