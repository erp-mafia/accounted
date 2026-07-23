import * as React from 'react'

interface PageHeaderProps {
  title: string
  description?: string
  action?: React.ReactNode
  /**
   * Page help content, rendered as a small "?" popover right after the H1
   * (UI-migration convention 7). Pass a <HelpPopover>...</HelpPopover>.
   */
  help?: React.ReactNode
}

export function PageHeader({ title, description, action, help }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-8">
      <div>
        <div className="flex items-center gap-2">
          {/* Locked at exactly 24px/32px (UI-migration convention 2) */}
          <h1 className="font-display text-2xl leading-8 tracking-tight">{title}</h1>
          {help}
        </div>
        {description && (
          <p className="text-muted-foreground mt-1 text-balance">{description}</p>
        )}
      </div>
      {action && <div className="w-full sm:w-auto [&>*]:w-full [&>*]:sm:w-auto">{action}</div>}
    </div>
  )
}
