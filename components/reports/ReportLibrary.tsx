'use client'

import { useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import {
  DataList,
  DataListMeta,
  DataListPrimary,
  DataListRow,
} from '@/components/ui/data-list'
import { Badge } from '@/components/ui/badge'
import { getLibrarySections, type ReportDescriptor } from '@/lib/reports/catalog'
import type { EntityType } from '@/types'

/**
 * The report library — the calm landing for /reports. Reports grouped by
 * accounting taxonomy, each section a single DataList. One report = one row =
 * one destination; no data preview, so the landing stays a fast index.
 */
export function ReportLibrary({
  entityType,
  hasEmployees,
  dimensionsEnabled,
  onOpen,
}: {
  entityType?: EntityType
  hasEmployees?: boolean
  dimensionsEnabled?: boolean
  onOpen: (slug: string) => void
}) {
  const t = useTranslations('reports')
  const sections = getLibrarySections(entityType, hasEmployees, dimensionsEnabled)

  return (
    <div className="space-y-8">
      {sections.map((section) => (
        <div key={section.category} className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            {t(section.labelKey)}
          </h2>
          <DataList>
            {section.items.map((item) => (
              <DataListRow
                key={item.slug}
                onClick={() => onOpen(item.slug)}
                trailing={
                  <>
                    <EntityBadge item={item} />
                    {item.params === 'calendar' && (
                      <Badge variant="secondary">{t('calendar_badge')}</Badge>
                    )}
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </>
                }
              >
                <DataListPrimary>{t(item.labelKey)}</DataListPrimary>
                <DataListMeta>{t(item.descKey)}</DataListMeta>
              </DataListRow>
            ))}
          </DataList>
        </div>
      ))}
    </div>
  )
}

function EntityBadge({ item }: { item: ReportDescriptor }) {
  if (item.entityType === 'enskild_firma')
    return <span className="text-xs text-muted-foreground">EF</span>
  if (item.entityType === 'aktiebolag')
    return <span className="text-xs text-muted-foreground">AB</span>
  return null
}
