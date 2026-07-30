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
      aria-label={text}
      title={text}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        HOVER_REVEAL_CLASS,
        'inline-flex shrink-0 items-center rounded p-1 text-muted-foreground',
        'transition-colors duration-150 hover:text-foreground',
        className,
      )}
    >
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
    </Link>
  )
}
