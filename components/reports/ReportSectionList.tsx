'use client'

import { useTranslations } from 'next-intl'
import { ArrowUpRight, ChevronRight } from 'lucide-react'
import {
  DataList,
  DataListMeta,
  DataListPrimary,
  DataListRow,
} from '@/components/ui/data-list'
import { Badge } from '@/components/ui/badge'
import { isFilingReport, type ReportDescriptor } from '@/lib/reports/catalog'

export interface ReportListSection {
  key: string
  labelKey: string
  items: ReportDescriptor[]
}

/**
 * The shared report index renderer: headed sections, each a single DataList of
 * one-row-per-report. Reused by the Rapporter reading tabs and the "Alla
 * rapporter" full index (`ReportLibrary`). Filing rows are marked with an
 * out-link glyph because they open their owning Skatt & bokslut context rather
 * than a focused /reports/[slug] view.
 */
export function ReportSectionList({
  sections,
  onOpen,
}: {
  sections: ReportListSection[]
  onOpen: (slug: string) => void
}) {
  const t = useTranslations('reports')

  return (
    <div className="space-y-8">
      {sections.map((section) => (
        <div key={section.key} className="space-y-3">
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
                    {isFilingReport(item) ? (
                      <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
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
