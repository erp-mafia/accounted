'use client'

import { useTranslations } from 'next-intl'
import { getReport } from '@/lib/reports/catalog'
import type { EntityType } from '@/types'

/**
 * "Senast öppnade": compact beige chips for the reports the user opened most
 * recently. One tap reopens a report straight from the library landing.
 * Renders nothing when there is no history (first visit).
 */
export function RecentReportsShelf({
  slugs,
  entityType,
  hasEmployees,
  onOpen,
}: {
  slugs: string[]
  entityType?: EntityType
  hasEmployees?: boolean
  onOpen: (slug: string) => void
}) {
  const t = useTranslations('reports')

  const items = slugs
    .map((slug) => getReport(slug))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .filter((r) => !r.entityType || r.entityType === entityType)
    .filter((r) => !r.needsEmployees || hasEmployees)

  if (items.length === 0) return null

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        {t('recent_heading')}
      </h2>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <button
            key={item.slug}
            type="button"
            onClick={() => onOpen(item.slug)}
            className="inline-flex items-center rounded-md bg-secondary px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary/70"
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>
    </div>
  )
}
