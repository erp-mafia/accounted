import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Stil v3 count tile: a 16px tile with a number, after a segment or filter
 * label ("Att bokföra 12"). Quiet wash at rest; inside the selected segment
 * or a pressed chip it turns to the control surface with a hairline so it
 * stays legible on the selected fill. The number is data: data-ph-mask.
 */
export function CountTile({ value, className }: { value: React.ReactNode; className?: string }) {
  return (
    <span
      data-ph-mask=""
      className={cn(
        'inline-grid h-4 min-w-4 place-items-center rounded-sm bg-secondary/90 px-1 text-[11px] font-medium leading-4 tabular-nums text-muted-foreground transition-colors duration-150',
        'group-aria-selected/seg:bg-control group-aria-selected/seg:text-foreground group-aria-selected/seg:shadow-[0_0_0_0.5px_hsl(var(--line))]',
        'group-aria-pressed/seg:bg-control group-aria-pressed/seg:text-foreground group-aria-pressed/seg:shadow-[0_0_0_0.5px_hsl(var(--line))]',
        className,
      )}
    >
      {value}
    </span>
  )
}

/** A keyboard hint tile ("/", "⌘K", "Esc"). Decorative: the action is labelled elsewhere. */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        'inline-grid h-4.5 min-w-4.5 place-items-center rounded-sm bg-secondary/80 px-1 font-sans text-[11px] font-medium leading-4 text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  )
}
