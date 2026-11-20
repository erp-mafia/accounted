'use client'

import { useTranslations } from 'next-intl'
import { ContextPicker } from '@/components/common/ContextPicker'
import { ALL_YEARS_VALUE } from '@/components/common/fiscal-year-storage'
import { useFiscalScopeChoice } from '@/components/providers/FiscalScopeProvider'
import { fiscalYearShortName } from '@/lib/bookkeeping/suggest-fiscal-period'

/**
 * The fiscal year as app-wide context, in the company row that heads the
 * sidebar (company tile, name, "2026", up-down chevron). Every page reads the same choice through
 * useFiscalScope, so no page carries a year picker of its own.
 *
 * `placement="sheet"`: the same choice in the phone's menu sheet, which has
 * no sidebar. There it is a button with its own chevron, beside the company.
 */
export function SidebarFiscalYear({ placement = 'row' }: { placement?: 'row' | 'sheet' } = {}) {
  const t = useTranslations('fiscal_year')
  const { choice, periods, ready, setChoice } = useFiscalScopeChoice()
  if (periods.length === 0) return null

  const selected = choice ? periods.find((p) => p.id === choice) : null
  const short = selected ? fiscalYearShortName(selected.name) : t('all_years_short')
  const annotationFor = (locked: boolean, closed: boolean) =>
    locked ? t('badge_locked').toLowerCase() : closed ? t('badge_closed').toLowerCase() : undefined

  return (
    <ContextPicker
      variant={placement === 'sheet' ? 'toolbar' : 'quiet'}
      // The company row it sits in carries the up-down chevron.
      hideChevron={placement === 'row'}
      items={[
        { id: ALL_YEARS_VALUE, label: t('all_years') },
        ...periods.map((p) => ({ id: p.id, label: p.name, annotation: annotationFor(!!p.locked_at, !!p.is_closed) })),
      ]}
      value={choice ?? ALL_YEARS_VALUE}
      onChange={(id) => setChoice(id === ALL_YEARS_VALUE ? null : id)}
      triggerLabel={short}
      disabled={!ready}
      ariaLabel={t('sidebar_aria', { year: short })}
    />
  )
}
