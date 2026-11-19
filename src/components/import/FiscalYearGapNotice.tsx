'use client'

import { useMemo } from 'react'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import { useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { HelpPopover } from '@/components/ui/help-popover'
import { findFiscalYearGaps, type FiscalYearGap, type PeriodLike } from '@/lib/bookkeeping/fiscal-year-gaps'

/**
 * After a SIE import: the years the company now has, with any hole between
 * them called out. Fortnox and friends export one räkenskapsår per file, so
 * "import the next file" is the fix and this is the moment to say it: one
 * attention line with the missing spans under it and the how behind the "?".
 * Renders nothing while loading, on failure, or when the chain is whole.
 */
export function FiscalYearGapNotice() {
  const t = useTranslations('fiscal_year_gaps')
  // Session-cached period list (lib/reference-data): refreshed by the import
  // flow's invalidation, so the notice reflects the years just imported.
  const { periods } = useFiscalPeriods()
  const gaps = useMemo<FiscalYearGap[]>(() => findFiscalYearGaps(periods as PeriodLike[]), [periods])

  if (gaps.length === 0) return null

  return (
    <div className="space-y-1">
      <AttnLine
        action={{ label: t('manage'), href: '/settings/fiscal-years' }}
        trailing={<HelpPopover className="ml-2 inline-flex align-middle">{t('hint')}</HelpPopover>}
      >
        {t('title', { count: gaps.length })}
      </AttnLine>
      {gaps.map((gap) => (
        <p key={`${gap.missing_from}-${gap.missing_to}`} className="text-xs leading-5 text-muted-foreground tabular-nums">
          {t('gap', { from: gap.missing_from, to: gap.missing_to, after: gap.after.name, before: gap.before.name })}
        </p>
      ))}
    </div>
  )
}
