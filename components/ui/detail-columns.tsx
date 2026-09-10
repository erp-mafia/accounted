'use client'

import { cn } from '@/lib/utils'
import { useShell } from '@/components/dashboard/ShellProvider'

/**
 * The register-detail document, laid out for the width it has.
 *
 * A register detail is a handful of short fact groups (detail-section.tsx).
 * Stacked in one column on a wide screen they leave two thirds of the page
 * empty and push the last group under the fold. Flowed into columns they
 * read as one page, and a group is never split across a column boundary.
 *
 * v1 keeps the narrow measure it was designed for.
 */
export function DetailColumns({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const shell = useShell()
  if (shell !== 'v2') {
    return <div className={cn('max-w-2xl space-y-8', className)}>{children}</div>
  }
  return (
    <div
      className={cn(
        'gap-x-14 lg:columns-2 2xl:columns-3 [&>section]:mb-9 [&>section]:break-inside-avoid',
        className,
      )}
    >
      {children}
    </div>
  )
}
