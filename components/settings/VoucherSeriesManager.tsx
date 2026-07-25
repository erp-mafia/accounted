'use client'

import { useTranslations } from 'next-intl'
import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { Skeleton } from '@/components/ui/skeleton'
import { SettingsGroup, SettingsRowNote } from '@/components/settings/SettingsRows'

interface VoucherSeries {
  voucher_series: string
  last_number: number
  fiscal_period_id: string
}

interface VoucherSeriesManagerProps {
  defaultSeries?: string
}

/** Read-only list of the series that have actually been used. */
export function VoucherSeriesManager({ defaultSeries }: VoucherSeriesManagerProps) {
  const t = useTranslations('settings_voucher_series')
  const { company } = useCompany()
  const [series, setSeries] = useState<VoucherSeries[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchSeries = useCallback(async () => {
    if (!company?.id) { setIsLoading(false); return }
    const supabase = createClient()
    const { data } = await supabase
      .from('voucher_sequences')
      .select('voucher_series, last_number, fiscal_period_id')
      .eq('company_id', company.id)
      .order('voucher_series')
    setSeries(data || [])
    setIsLoading(false)
  }, [company?.id])

  useEffect(() => { fetchSeries() }, [fetchSeries])

  // Group by series letter, show the highest last_number
  const grouped = series.reduce<Record<string, number>>((acc, s) => {
    const existing = acc[s.voucher_series] || 0
    acc[s.voucher_series] = Math.max(existing, s.last_number)
    return acc
  }, {})

  const seriesEntries = Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b))

  return (
    <SettingsGroup label={t('heading')} help={t('footnote')}>
      {isLoading ? (
        <div className="space-y-2 px-1 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
      ) : seriesEntries.length === 0 ? (
        <p className="px-1 py-3 text-sm text-muted-foreground">
          {t('empty_state', { series: defaultSeries || 'A' })}
        </p>
      ) : (
        seriesEntries.map(([letter, lastNum]) => (
          <div key={letter} className="flex items-center gap-3 border-b border-border px-1 py-3">
            <span className="text-sm font-medium tabular-nums">
              {t('series_prefix')} {letter}
            </span>
            {/* The default marker is a normal state: muted text, not a chip. */}
            {letter === (defaultSeries || 'A') && (
              <SettingsRowNote>{t('default_badge')}</SettingsRowNote>
            )}
            <span className="ml-auto shrink-0 text-sm text-muted-foreground tabular-nums">
              {t('latest_number')}: {lastNum}
            </span>
          </div>
        ))
      )}
    </SettingsGroup>
  )
}
