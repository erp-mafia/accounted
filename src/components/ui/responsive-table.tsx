import * as React from 'react'
import { cn } from '@/lib/utils'

/** Read static labels and column roles through native and shared table headers. */
function headerColumns(children: React.ReactNode): { label: string; primary: boolean; selection: boolean }[] {
  const text = (node: React.ReactNode): string => React.Children.toArray(node).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    if (!React.isValidElement<{ children?: React.ReactNode; label?: React.ReactNode; 'aria-label'?: string }>(child)) return ''
    return text(child.props.children) || text(child.props.label) || child.props['aria-label'] || ''
  }).join('')
  const hasSelection = (node: React.ReactNode): boolean => React.Children.toArray(node).some(child => {
    if (!React.isValidElement<{ children?: React.ReactNode; type?: string; role?: string }>(child)) return false
    const name = typeof child.type === 'string' ? child.type : (child.type as { displayName?: string }).displayName
    return child.props.type === 'checkbox' || child.props.role === 'checkbox' || name === 'Checkbox' || hasSelection(child.props.children)
  })
  const cells = (nodes: React.ReactNode): React.ReactNode[] => React.Children.toArray(nodes).flatMap(node =>
    React.isValidElement<{ children?: React.ReactNode }>(node) && node.type === React.Fragment ? cells(node.props.children) : [node],
  )
  let columns: { label: string; primary: boolean; selection: boolean }[] = []
  const visit = (nodes: React.ReactNode) => {
    React.Children.forEach(nodes, node => {
      if (columns.length || !React.isValidElement<{ children?: React.ReactNode }>(node)) return
      const name = typeof node.type === 'string' ? node.type : (node.type as { displayName?: string }).displayName
      if (name === 'thead' || name === 'TableHeader') {
        const row = React.Children.toArray(node.props.children).find(React.isValidElement)
        if (row && React.isValidElement<{ children?: React.ReactNode }>(row)) {
          columns = cells(row.props.children).map(cell => ({
            label: text(cell),
            primary: React.isValidElement<{ className?: string }>(cell) && !!cell.props.className?.split(/\s+/).includes('w-full'),
            selection: hasSelection(cell),
          }))
        }
      } else visit(node.props.children)
    })
  }
  visit(children)
  return columns
}

/** Keep one native table and present its rows as labelled cards in narrow containers. */
export function ResponsiveTable({ children, className, primaryColumn, actionsColumn, ...props }: Omit<React.ComponentPropsWithoutRef<'div'>, 'style'> & {
  /** One-based column to give the full row width on narrow screens. */
  primaryColumn?: number
  /** Put a final action/status column in a separate full-width mobile footer. */
  actionsColumn?: 'last'
}) {
  const columns = headerColumns(children)
  const labels = columns.map(column => column.label)
  const leadingControl = !!columns.length && (!columns[0].label || columns[0].selection)
  const inferredPrimary = columns.findIndex(column => column.primary)
  const firstValue = columns.findIndex((column, index) => !!column.label && !(leadingControl && index === 0))
  const primary = primaryColumn ?? (inferredPrimary >= 0 ? inferredPrimary + 1 : firstValue >= 0 ? firstValue + 1 : undefined)
  const actionsLast = actionsColumn === 'last' || (columns.length > 1 && !columns[columns.length - 1].label)
  const style: Record<string, string> = { containerType: 'inline-size', containerName: 'responsive-table' }
  labels.forEach((label, index) => {
    style[`--table-column-${index + 1}`] = JSON.stringify(label)
    style[`--table-last-column-${labels.length - index}`] = JSON.stringify(label)
  })
  return (
    <div {...props} className={cn('responsive-table min-w-0 w-full overflow-x-auto', className)} style={style} data-primary-column={primary} data-leading-control={leadingControl || undefined} data-actions-last={actionsLast || undefined}>
      {children}
    </div>
  )
}
