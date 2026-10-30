'use client'

import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { Input } from '@/components/ui/input'
import { TOOLBAR_FIELD_CLASS } from '@/components/ui/toolbar-search'
import { cn } from '@/lib/utils'
import { BolagetTabs } from './BolagetTabs'

/**
 * The top bar every Bolaget page shares (founder call 2026-10-30): the title
 * with one short subtitle line, the long explanation behind the "?", the
 * page's own actions, and under it the Bolaget tab bar. A dated register
 * (the aktiebok, the roles) adds its as-of date before the actions: it is
 * read as of a day, empty means today.
 */
export function BolagetHeader({
  title,
  subtitle,
  help,
  asOf,
  onAsOfChange,
  asOfLabel,
  action,
}: {
  title: string
  subtitle: string
  help: string
  asOf?: string
  onAsOfChange?: (value: string) => void
  asOfLabel?: string
  action?: React.ReactNode
}) {
  const dated = asOf !== undefined && onAsOfChange !== undefined
  return (
    <>
      <PageHeader
        title={title}
        meta={subtitle}
        help={
          <HelpPopover>
            <p>{help}</p>
          </HelpPopover>
        }
        action={
          dated ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Input
                type="date"
                aria-label={asOfLabel}
                value={asOf}
                onChange={(e) => onAsOfChange(e.target.value)}
                className={cn(TOOLBAR_FIELD_CLASS, 'w-40 tabular-nums')}
              />
              {action}
            </div>
          ) : (
            action
          )
        }
      />
      <BolagetTabs />
    </>
  )
}
