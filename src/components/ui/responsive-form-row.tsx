import { Children, isValidElement, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** One set of form controls, with labelled fields when the row becomes narrow. */
export function ResponsiveFormRow({ labels, children, className }: {
  labels: string[]
  children: ReactNode
  className?: string
}) {
  return (
    <div className="responsive-form-row min-w-0 flex-1">
      <div className={cn('responsive-form-row-grid', className)}>
        {Children.toArray(children).map((child, index) => (
          <div key={isValidElement(child) ? child.key : index} className="responsive-form-cell" data-label={labels[index] ?? ''}>
            {child}
          </div>
        ))}
      </div>
    </div>
  )
}
