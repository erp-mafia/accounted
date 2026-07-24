'use client'

import { useTranslations } from 'next-intl'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { Badge } from '@/components/ui/badge'
import { cn, formatDate } from '@/lib/utils'
import { getLibrarySections, type ReportDescriptor } from '@/lib/reports/catalog'
import type { EntityType } from '@/types'

/**
 * The report catalog as one dry table (concept "Tabellen"): band rows carry
 * the accounting taxonomy, each report is a single clickable line with its
 * description in muted ink and a "Senast öppnad" column fed from the
 * per-company recents. One report = one row = one destination.
 */
export function ReportLibrary({
  entityType,
  hasEmployees,
  dimensionsEnabled,
  openedAt,
  onOpen,
}: {
  entityType?: EntityType
  hasEmployees?: boolean
  dimensionsEnabled?: boolean
  /** slug -> epoch ms for the "Senast öppnad" column. */
  openedAt: Record<string, number>
  onOpen: (slug: string) => void
}) {
  const t = useTranslations('reports')
  const sections = getLibrarySections(entityType, hasEmployees, dimensionsEnabled)

  const lastOpenedLabel = (slug: string): string => {
    const at = openedAt[slug]
    if (!at) return ''
    const days = Math.floor((Date.now() - at) / 86_400_000)
    if (days === 0) return t('opened_today')
    if (days === 1) return t('opened_yesterday')
    return formatDate(new Date(at))
  }

  return (
    <div className="overflow-x-auto" role="region" aria-label={t('title')}>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={cn(TH_CLASS, 'w-[240px]')}>{t('col_report')}</th>
            <th className={TH_CLASS}>{t('col_description')}</th>
            <th className={cn(TH_CLASS, 'w-[130px] text-right')}>{t('col_last_opened')}</th>
          </tr>
        </thead>
        <tbody className="stagger-enter">
          {sections.map((section) => (
            <SectionRows
              key={section.category}
              label={t(section.labelKey)}
              items={section.items}
              lastOpenedLabel={lastOpenedLabel}
              onOpen={onOpen}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SectionRows({
  label,
  items,
  lastOpenedLabel,
  onOpen,
}: {
  label: string
  items: ReportDescriptor[]
  lastOpenedLabel: (slug: string) => string
  onOpen: (slug: string) => void
}) {
  const t = useTranslations('reports')
  return (
    <>
      <tr className="bg-muted/30">
        <td
          colSpan={3}
          className="px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"
        >
          {label}
        </td>
      </tr>
      {items.map((item) => (
        <tr
          key={item.slug}
          className="group cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
          onClick={() => onOpen(item.slug)}
        >
          <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
            <span className="flex items-center gap-2">
              {t(item.labelKey)}
              <EntityMark item={item} />
              {item.params === 'calendar' && (
                <Badge variant="secondary" className="font-normal">
                  {t('calendar_badge')}
                </Badge>
              )}
            </span>
          </td>
          <td className={cn(TD_CLASS, 'text-muted-foreground')}>{t(item.descKey)}</td>
          <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums text-muted-foreground')}>
            {lastOpenedLabel(item.slug)}
          </td>
        </tr>
      ))}
    </>
  )
}

function EntityMark({ item }: { item: ReportDescriptor }) {
  if (item.entityType === 'enskild_firma')
    return <span className="text-xs text-muted-foreground">EF</span>
  if (item.entityType === 'aktiebolag')
    return <span className="text-xs text-muted-foreground">AB</span>
  return null
}
