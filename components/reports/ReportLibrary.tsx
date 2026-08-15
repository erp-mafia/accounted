'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Search, X } from 'lucide-react'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { cn, formatDate } from '@/lib/utils'
import {
  getLibrarySections,
  reportMatchesQuery,
  type ReportDescriptor,
} from '@/lib/reports/catalog'
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
  const [query, setQuery] = useState('')
  const allSections = getLibrarySections(entityType, hasEmployees, dimensionsEnabled)

  // Matched against the translated name and description plus the descriptor's
  // synonyms, so the vocabulary someone arrives with ("verifikat per konto")
  // reaches the report even when we named it something else ("Huvudbok").
  const sections = useMemo(() => {
    if (!query.trim()) return allSections
    return allSections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) =>
          reportMatchesQuery(
            `${t(item.labelKey)} ${t(item.descKey)} ${item.searchTerms ?? ''}`,
            query,
          ),
        ),
      }))
      .filter((section) => section.items.length > 0)
  }, [allSections, query, t])

  const lastOpenedLabel = (slug: string): string => {
    const at = openedAt[slug]
    if (!at) return ''
    const days = Math.floor((Date.now() - at) / 86_400_000)
    if (days === 0) return t('opened_today')
    if (days === 1) return t('opened_yesterday')
    return formatDate(new Date(at))
  }

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          // Deliberately not type="search": WebKit adds its own cancel button,
          // which would sit next to the X below as a second clear affordance.
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search_placeholder')}
          aria-label={t('search_placeholder')}
          className="h-9 pl-9 pr-9 text-[13px]"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label={t('search_clear')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {sections.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t('search_no_results', { query: query.trim() })}
        </p>
      ) : (
        <div className="overflow-x-auto" role="region" aria-label={t('title')}>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={cn(TH_CLASS, 'w-[240px]')}>{t('col_report')}</th>
                <th className={TH_CLASS}>{t('col_description')}</th>
                <th className={cn(TH_CLASS, 'w-[130px] text-right')}>{t('col_last_opened')}</th>
              </tr>
            </thead>
            {/* Stagger is the entry animation for the library as it loads. It
                must not re-run per keystroke while filtering, or every widening
                edit replays a 360ms cascade under the user's eyes. */}
            <tbody className={query.trim() ? undefined : 'stagger-enter'}>
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
      )}
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
