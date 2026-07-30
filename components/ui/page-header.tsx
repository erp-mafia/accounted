import * as React from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface PageHeaderProps {
  title: string
  description?: string
  action?: React.ReactNode
  /**
   * Page help content, rendered as a small "?" popover right after the H1
   * (UI-migration convention 7). Pass a <HelpPopover>...</HelpPopover>.
   */
  help?: React.ReactNode
  /**
   * Detail pages: a ghost icon button back to the list, left of the title.
   * One treatment app-wide; the counterparty detail pages used to disagree
   * (stacked text link on two of them, ghost icon button on the other two).
   */
  backHref?: string
  /** Accessible name for the back button. Required whenever backHref is set. */
  backLabel?: string
  /**
   * Status chips beside the title. Chips mark exceptions only (convention 5):
   * a normal state belongs in muted text, not here.
   */
  badges?: React.ReactNode
}

export function PageHeader({
  title,
  description,
  action,
  help,
  backHref,
  backLabel,
  badges,
}: PageHeaderProps) {
  return (
    // No bottom margin: every page root is `space-y-8`, so the gap below the
    // header is already the section token. Carrying mb-8 here as well doubled
    // it to 64px on every page built from this primitive.
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {backHref && (
            <Button asChild variant="ghost" size="icon" className="-ml-2 shrink-0">
              <Link href={backHref} aria-label={backLabel}>
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
          )}
          {/* Locked at exactly 24px/32px (UI-migration convention 2) */}
          <h1 className="font-display text-2xl leading-8 tracking-tight">{title}</h1>
          {help}
          {badges}
        </div>
        {description && (
          <p className="text-muted-foreground mt-1 text-balance">{description}</p>
        )}
      </div>
      {action && <div className="w-full sm:w-auto [&>*]:w-full [&>*]:sm:w-auto">{action}</div>}
    </div>
  )
}
