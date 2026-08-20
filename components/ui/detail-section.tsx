import { cn } from '@/lib/utils'

/**
 * Register-detail document grammar (customers, suppliers, articles).
 *
 * A detail page is one flowing document, not a pile of cards: each group of
 * facts is introduced by an uppercase hairline kicker and set as aligned
 * label/value rows. The kicker's hairline is the only rule; groups are
 * separated by whitespace, never borders (Living Paper, design.md).
 */

export function DetailSection({
  kicker,
  help,
  aside,
  children,
  className,
}: {
  kicker: string
  /** Section help behind a "?" right after the kicker (convention 7). Pass a <HelpPopover>. */
  help?: React.ReactNode
  /** Optional right-aligned element on the kicker line: a count, a quiet action. */
  aside?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={className}>
      <div className="flex items-baseline justify-between gap-4 border-b border-border pb-2">
        {/* data-ph-unmask: kickers are static i18n chrome in session replays. */}
        <h2 data-ph-unmask="" className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {kicker}
          {help}
        </h2>
        {aside}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

export function DefRow({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-[8rem_1fr] gap-x-6 py-2 text-sm sm:grid-cols-[10rem_1fr]',
        className,
      )}
    >
      {/* data-ph-unmask on the label only: values (children) are user data
          and stay masked in session replays. */}
      <div data-ph-unmask="" className="text-muted-foreground">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/**
 * Muted placeholder for a value that matters but is not filled in. The en dash
 * is the literal rendered value (same vocabulary as the orders list), which is
 * why it is allowed to be a dash at all.
 */
export function DefEmpty() {
  return <span className="text-muted-foreground">{'–'}</span>
}
