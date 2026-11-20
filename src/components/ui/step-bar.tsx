import * as React from 'react'
import { PAGE_BOTTOM_BAR_PROPS } from '@/components/ui/fab-clearance'
import { cn } from '@/lib/utils'

/**
 * The bar of a guided step (V7 long processes: a VAT declaration, a salary
 * run, an annual report): pinned to the bottom of the page, one sentence
 * about the step on the left and the step's one primary last on the right.
 * The top bar of such a page carries no filled button; rare actions stay in
 * its "more" menu. On a phone the bar sits above the bottom nav and its
 * buttons share the width. Same geometry as the step bar on Att göra.
 */
export function StepBar({
  note,
  children,
  className,
}: {
  /** One muted sentence about what the primary does or what comes next. */
  note?: React.ReactNode
  /** Secondary buttons first, the primary last. */
  children: React.ReactNode
  className?: string
}) {
  return (
    <>
      {/* On a phone the bar is fixed over the page: this keeps the step's last
          rows clear of it. */}
      <div className="h-20 md:hidden" aria-hidden="true" />
      <div
      {...PAGE_BOTTOM_BAR_PROPS}
      className={cn(
        'z-10 flex flex-wrap items-center gap-x-4 gap-y-2 border-t-hairline bg-background py-3',
        'max-md:fixed max-md:inset-x-0 max-md:bottom-[var(--bottom-nav-h)] max-md:px-4',
        'md:sticky md:bottom-0',
        className,
      )}
    >
      {note ? (
        <div className="min-w-0 flex-1 text-xs text-muted-foreground max-md:basis-full">{note}</div>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2 max-md:w-full max-md:[&>*]:flex-1">
        {children}
      </div>
      </div>
    </>
  )
}
