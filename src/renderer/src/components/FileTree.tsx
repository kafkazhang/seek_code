import { useState } from 'react'
import { FileNode } from '@shared/types'

function Node({ node, depth, onOpen }: { node: FileNode; depth: number; onOpen: (p: string) => void }): JSX.Element {
  const [open, setOpen] = useState(depth < 1)
  const pad = { paddingLeft: 8 + depth * 14 }
  if (node.type === 'dir') {
    return (
      <>
        <div className="row" style={pad} onClick={() => setOpen(!open)}>
          <span className="fi dir">{open ? '▾' : '▸'}</span>
          <span>{node.name}</span>
        </div>
        {open && node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} onOpen={onOpen} />)}
      </>
    )
  }
  return (
    <div className="row" style={pad} onClick={() => onOpen(node.path)}>
      <span className="fi">◈</span>
      <span>{node.name}</span>
    </div>
  )
}

export default function FileTree({
  nodes,
  onOpen
}: {
  nodes: FileNode[]
  onOpen: (p: string) => void
}): JSX.Element {
  return (
    <>
      {nodes.map((n) => (
        <Node key={n.path} node={n} depth={0} onOpen={onOpen} />
      ))}
    </>
  )
}
