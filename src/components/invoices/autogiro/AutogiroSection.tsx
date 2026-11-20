import type { ReactNode } from 'react'

/**
 * One section of the Autogiro page: the page's uppercase section heading
 * (the section divider header inside a page), an optional count and
 * "?" help, and the section's own action on the right.
 */
export function AutogiroSection({
  title,
  count,
  help,
  action,
  children,
}: {
  title: string
  count?: number
  help?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <span>
            {title}
            {count !== undefined && <span className="tabular-nums"> ({count})</span>}
          </span>
          {help}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}
