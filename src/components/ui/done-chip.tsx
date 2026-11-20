import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * The confirmation chip (Stil v3, product decision 2026-10-29): green only
 * while it confirms, in the spot of the button that did it, before the row
 * folds away or the dialog closes. The check draws itself once (check
 * draw, one of the four named motions). role="status" announces it.
 */
export function DoneChip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      role="status"
      className={cn(
        'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md bg-success/9 pl-2 pr-2.5 text-[13px] font-medium text-success animate-rise',
        className,
      )}
    >
      <svg className="check-draw shrink-0" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" className="fill-success" />
        <path
          pathLength={1}
          d="m5.3 8.2 1.8 1.8 3.6-3.8"
          fill="none"
          className="stroke-background"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {children}
    </span>
  )
}
