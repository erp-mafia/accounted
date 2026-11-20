'use client'

import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { Input } from '@/components/ui/input'
import { TOOLBAR_FIELD_CLASS } from '@/components/ui/toolbar-search'
import { cn } from '@/lib/utils'
import { todayIsoStockholm } from '@/lib/dates/iso'

/**
 * The top bar every Bolaget page shares (product call 2026-10-30): the title
 * with one short subtitle line, the long explanation behind the "?" and the
 * page's one primary. The pages are rows in the Företaget sidebar (they
 * shared a tab bar until 2026-11-15). What scopes the page sits in one
 * toolbar row under the bar, at every width (V7 list toolbars): a dated
 * register (the aktiebok, the roles) is read as of a day, with the date and
 * its label on the left, a year picker goes in `toolbar`, and the export or
 * "more" menu is the last thing on the right (`toolbarEnd`).
 */
export function BolagetHeader({
  title,
  subtitle,
  help,
  asOf,
  onAsOfChange,
  asOfLabel,
  toolbar,
  toolbarEnd,
  action,
}: {
  title: string
  subtitle: string
  help: string
  /** Empty means today: the field then shows today's date. */
  asOf?: string
  onAsOfChange?: (value: string) => void
  asOfLabel?: string
  toolbar?: React.ReactNode
  toolbarEnd?: React.ReactNode
  action?: React.ReactNode
}) {
  const dated = asOf !== undefined && onAsOfChange !== undefined
  const today = todayIsoStockholm()
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
        action={action}
      />
      {(dated || toolbar || toolbarEnd) && (
        <div className="flex flex-wrap items-center gap-2">
          {dated && (
            <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
              {asOfLabel}
              <Input
                type="date"
                value={asOf || today}
                onChange={(e) => onAsOfChange(e.target.value === today ? '' : e.target.value)}
                className={cn(TOOLBAR_FIELD_CLASS, 'date-figures w-36')}
              />
            </label>
          )}
          {toolbar}
          {toolbarEnd && <div className="ml-auto flex items-center gap-2">{toolbarEnd}</div>}
        </div>
      )}
    </>
  )
}
