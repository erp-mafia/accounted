import * as React from 'react'
import { cn } from '@/lib/utils'

/** Read static header labels through native table elements and shared table primitives. */
function headerLabels(children: React.ReactNode): string[] {
  const text = (node: React.ReactNode): string => React.Children.toArray(node).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    if (!React.isValidElement<{ children?: React.ReactNode; label?: React.ReactNode; 'aria-label'?: string }>(child)) return ''
    return text(child.props.children) || text(child.props.label) || child.props['aria-label'] || ''
  }).join('')
  let labels: string[] = []
  const visit = (nodes: React.ReactNode) => {
    React.Children.forEach(nodes, node => {
      if (labels.length || !React.isValidElement<{ children?: React.ReactNode }>(node)) return
      const name = typeof node.type === 'string' ? node.type : (node.type as { displayName?: string }).displayName
      if (name === 'thead' || name === 'TableHeader') {
        const row = React.Children.toArray(node.props.children).find(React.isValidElement)
        if (row && React.isValidElement<{ children?: React.ReactNode }>(row)) {
          labels = React.Children.toArray(row.props.children).map(cell => text(cell))
        }
      } else visit(node.props.children)
    })
  }
  visit(children)
  return labels
}

/** Keep desktop tables intact and stack labelled cells when their own container becomes narrow. */
export function ResponsiveTable({ children, className, primaryColumn }: {
  children: React.ReactNode
  className?: string
  /** One-based column to give the full row width on narrow screens. */
  primaryColumn?: number
}) {
  const labels = headerLabels(children)
  const style: Record<string, string> = { containerType: 'inline-size', containerName: 'responsive-table' }
  labels.forEach((label, index) => {
    style[`--table-column-${index + 1}`] = JSON.stringify(label)
    style[`--table-last-column-${labels.length - index}`] = JSON.stringify(label)
  })
  return (
    <div className={cn('responsive-table min-w-0 w-full overflow-x-auto', className)} style={style} data-primary-column={primaryColumn}>
      {children}
    </div>
  )
}
