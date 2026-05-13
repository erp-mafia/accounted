import * as React from 'react'

interface PageHeaderProps {
  title: string
  description?: string
  action?: React.ReactNode
}

export function PageHeader({ title, description, action }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-8">
      <div>
        <h1 className="font-display text-3xl md:text-4xl tracking-tight">{title}</h1>
        {description && (
          <p className="text-muted-foreground mt-1 text-balance">{description}</p>
        )}
      </div>
      {action && <div className="w-full sm:w-auto [&>*]:w-full [&>*]:sm:w-auto">{action}</div>}
    </div>
  )
}
