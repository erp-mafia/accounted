import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/** Keep every step visible and tappable without a sideways rail on phones. */
export function WorkflowSteps({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      {...props}
      role="tablist"
      className={cn(
        'grid w-full min-w-0 grid-cols-2 items-start gap-3 px-1 lg:flex lg:flex-wrap lg:items-center [&>[aria-hidden=true]]:hidden lg:[&>[aria-hidden=true]]:block [&>[role=tab]]:min-w-0 [&>[role=tab]]:max-w-full [&>[role=tab]]:min-h-10 [&>[role=tab]>span]:min-w-0 [&>[role=tab]>span]:[overflow-wrap:anywhere]',
        className,
      )}
    />
  )
}
