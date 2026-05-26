'use client'

import { useTranslations } from 'next-intl'
import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { Label } from '@/components/ui/label'
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from '@/components/ui/badge'

interface VoucherSeries {
  voucher_series: string
  last_number: number
  fiscal_period_id: string
}

interface VoucherSeriesManagerProps {
  defaultSeries?: string
}

export function VoucherSeriesManager({ defaultSeries }: VoucherSeriesManagerProps) {
  const t = useTranslations('settings_voucher_series')
  const { company } = useCompany()
  const [series, setSeries] = useState<VoucherSeries[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchSeries = useCallback(async () => {
    if (!company?.id) return
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
    <section className="space-y-4">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        {t('heading')}
      </h2>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
      ) : seriesEntries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('empty_state', { series: defaultSeries || 'A' })}
        </p>
      ) : (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t('active_series_label')}</Label>
          <div className="divide-y divide-border/8">
            {seriesEntries.map(([letter, lastNum]) => (
              <div key={letter} className="flex items-center justify-between py-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium tabular-nums">{t('series_prefix')} {letter}</span>
                  {letter === (defaultSeries || 'A') && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">{t('default_badge')}</Badge>
                  )}
                </div>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {t('latest_number')}: {lastNum}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {t('footnote')}
      </p>
    </section>
  )
}
