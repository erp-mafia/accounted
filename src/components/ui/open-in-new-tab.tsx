'use client'

import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'

/**
 * Escape hatch out of a list without losing it.
 *
 * Working a filtered list (kontoavstämning, granskning) means opening one
 * record, fixing it, and coming back to the same list. Navigating in place
 * throws away the filter, the page and the scroll position, so the only way
 * to keep them is to open the record in a second tab. Most of our row links
 * are plain anchors, so cmd-click already works, but nothing on screen ever
 * says so and a few call sites are buttons where it does not work at all.
 *
 * Sits next to the record's own link rather than replacing it: the primary
 * click keeps navigating in place, which is what people expect. Hover-revealed
 * per the row-control convention, and always visible on coarse pointers.
 */
export function OpenInNewTab({
  href,
  label,
  className,
}: {
  href: string
  /** Overrides the default "Öppna i ny flik" for a more specific target. */
  label?: string
  className?: string
}) {
  const t = useTranslations('common')
  const text = label ?? t('open_in_new_tab')

  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // Named by the visually-hidden text below rather than aria-label, so the
      // title renders a tooltip for sighted users without screen readers
      // announcing the same string twice.
      title={text}
      onClick={(e) => e.stopPropagation()}
      // Rows that own this control are themselves interactive: JournalEntryList
      // gives its <tr> an Enter/Space handler that calls preventDefault() and
      // expands the row. Without this, Enter on a focused link would expand the
      // row instead of opening the voucher, so the control would be usable with
      // a mouse but not a keyboard.
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        HOVER_REVEAL_CLASS,
        'relative inline-flex shrink-0 items-center rounded-sm p-1 text-muted-foreground',
        // The icon stays 14px so the row keeps its density, but the pointer
        // target is padded out to the 40px the design rules require.
        'before:absolute before:left-1/2 before:top-1/2 before:h-10 before:w-10',
        'before:-translate-x-1/2 before:-translate-y-1/2 before:content-[""]',
        'transition-colors duration-150 hover:text-foreground',
        className,
      )}
    >
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="sr-only">{text}</span>
    </Link>
  )
}
