import type { ReactNode } from 'react'
import { ChevronRightIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

/**
 * The parts every Inkorg list shares: the view's heading, and a row's
 * frame, its name over its meta line, and the chevron that says it opens.
 * Feedback comes on the press (:active), not on the release.
 */
export const ROW_CLASS = cn(
  'grid w-full items-center gap-x-3 border-b-hairline px-2 py-3 text-left text-[13px] transition-colors duration-150 sm:gap-x-4',
  'hover:bg-secondary/35 active:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
)

/**
 * The heading of a view with its one line under it; what is aside (a
 * portal's actions) sits to its right, and under it on a phone. The two
 * views the toolbar's segments already name pass `titleHidden`: the title
 * stays for screen readers and only the lead line shows.
 */
export function ViewHeading({
  id,
  title,
  lead,
  aside,
  titleHidden = false,
}: {
  id: string
  title: string
  lead?: string
  aside?: ReactNode
  titleHidden?: boolean
}) {
  return (
    <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h2 id={id} className={titleHidden ? 'sr-only' : 'text-[15px] font-medium leading-[22px] text-strong'}>
          {title}
        </h2>
        {lead && <p className={cn('text-[13px] text-muted-foreground', !titleHidden && 'mt-1')}>{lead}</p>}
      </div>
      {aside}
    </div>
  )
}

/** A row's name over its meta line (where it came from, when). */
export function RowTitle({ name, meta, muted = false }: { name: ReactNode; meta?: ReactNode; muted?: boolean }) {
  return (
    <span className="min-w-0">
      <span data-ph-mask="" className={cn('block truncate font-medium', muted && 'text-muted-foreground')}>
        {name}
      </span>
      {meta && (
        <span data-ph-mask="" className="block truncate text-xs text-muted-foreground">
          {meta}
        </span>
      )}
    </span>
  )
}

export function RowChevron() {
  return (
    <ChevronRightIcon aria-hidden="true" className="hidden h-4 w-4 text-muted-foreground sm:block" />
  )
}
