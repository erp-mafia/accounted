import type { ReactNode } from 'react'
import { HelpPopover } from '@/components/ui/help-popover'
import { cn } from '@/lib/utils'

/**
 * The record vocabulary of the canvas (artboard Avtal): a section with a
 * hairline under its title, definition rows with the label left, the value
 * right and the source page at the far edge.
 */
export function Section({ title, help, children, className }: { title: string; help?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0 space-y-2', className)}>
      <div className="flex items-center gap-2 border-b border-border pb-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {help ? <HelpPopover>{help}</HelpPopover> : null}
      </div>
      {children}
    </section>
  )
}

export function DefList({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn('m-0', className)}>{children}</dl>
}

export function DefRow({ label, children, source, muted, labelWidth = 150 }: { label: ReactNode; children: ReactNode; source?: ReactNode; muted?: boolean; labelWidth?: number }) {
  return (
    <div className="grid items-baseline gap-x-4 border-b border-border py-2 last:border-b-0" style={{ gridTemplateColumns: `${labelWidth}px minmax(0, 1fr)` }}>
      <dt className="text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className="m-0 flex items-baseline justify-between gap-3">
        <span className={cn('min-w-0 tabular-nums', muted && 'text-muted-foreground')}>{children}</span>
        {source}
      </dd>
    </div>
  )
}

/** "Hyresavtal, s. 4": the page a value was read from, opening the file there. */
export function SourceLink({ href, label }: { href: string | null; label: string }) {
  const className = 'whitespace-nowrap text-[11px] text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground'
  if (!href) return <span className={className.replace(' underline', '')}>{label}</span>
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {label}
    </a>
  )
}

export const inlineHref = (documentId: string, page: number | null | undefined) => `/api/documents/${documentId}/inline${page ? `#page=${page}` : ''}`

/** A file name short enough for a source reference: "Hyresavtal Vasagatan 12" stays, a 60-character scan name is cut. */
export function shortFileName(name: string, max = 28): string {
  const stem = name.replace(/\.[a-z0-9]{2,5}$/i, '')
  return stem.length > max ? `${stem.slice(0, max - 1)}…` : stem
}
