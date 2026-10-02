import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface EditorSectionProps {
  /** The uppercase hairline label: Kund, Rader, Betalning ... */
  label: ReactNode
  /** Right side of the label row: a count, where a value comes from, a quiet action. */
  aside?: ReactNode
  id?: string
  className?: string
  children: ReactNode
}

/**
 * One section of the editor's form column: an 11px uppercase label over a
 * hairline, an optional muted aside on the right, then the content. Flat,
 * no card: the hairline carries the hierarchy (design convention: surfaces
 * sit flat on the panel).
 */
export function EditorSection({ label, aside, id, className, children }: EditorSectionProps) {
  return (
    <section id={id} className={cn('scroll-mt-4', className)}>
      <div className="mb-3 flex items-center justify-between gap-2 border-b border-border pb-2">
        {/* The section kicker (as DetailSection): font-sans because h2 takes
            the display serif from the global heading style. */}
        <h2 className="font-sans text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</h2>
        {aside ? <div className="min-w-0 truncate text-[12.5px] text-muted-foreground">{aside}</div> : null}
      </div>
      {children}
    </section>
  )
}
