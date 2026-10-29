'use client'

import { PageHeader } from '@/components/ui/page-header'
import { Input } from '@/components/ui/input'
import { TOOLBAR_FIELD_CLASS } from '@/components/ui/toolbar-search'
import { cn } from '@/lib/utils'

/**
 * The top bar both Bolaget pages share: the title, the help behind the "?",
 * the as-of date (the register and the roles are read as of a day; empty
 * means today) and the page's own actions.
 */
export function BolagetHeader({
  title,
  help,
  asOf,
  onAsOfChange,
  asOfLabel,
  children,
}: {
  title: string
  help: string
  asOf: string
  onAsOfChange: (value: string) => void
  asOfLabel: string
  children?: React.ReactNode
}) {
  return (
    <PageHeader
      title={title}
      help={<p className="text-sm">{help}</p>}
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Input
            type="date"
            aria-label={asOfLabel}
            value={asOf}
            onChange={(e) => onAsOfChange(e.target.value)}
            className={cn(TOOLBAR_FIELD_CLASS, 'w-40 tabular-nums')}
          />
          {children}
        </div>
      }
    />
  )
}
