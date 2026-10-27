'use client'

import { useState, type ReactNode } from 'react'
import { ChevronRightIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

/**
 * A run-page section that is reference once its step is past: the kicker
 * line itself opens and closes it, closed until asked for. The run page
 * folds Beräkning och verifikat this way once the run is approved, so the
 * step the run is in leads the page.
 */
export function RunFoldSection({ kicker, children }: { kicker: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-b border-border pb-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <ChevronRightIcon className={cn('h-3 w-3 transition-transform duration-150', open && 'rotate-90')} aria-hidden />
        <span data-ph-unmask="">{kicker}</span>
      </button>
      {open && <div className="mt-6">{children}</div>}
    </section>
  )
}
