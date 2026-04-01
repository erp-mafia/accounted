'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { Label } from '@/components/ui/label'

interface VoucherSeries {
  voucher_series: string
  last_number: number
  fiscal_period_id: string
}

export function VoucherSeriesManager() {
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
        Verifikationsserier
      </h2>

      {isLoading ? (
        <div className="space-y-2">
          <div className="h-4 bg-muted rounded w-32 animate-pulse" />
          <div className="h-4 bg-muted rounded w-24 animate-pulse" />
        </div>
      ) : seriesEntries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Inga verifikationsserier ännu. Serie A skapas automatiskt vid första verifikationen.
        </p>
      ) : (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Aktiva serier</Label>
          <div className="divide-y divide-border/8">
            {seriesEntries.map(([letter, lastNum]) => (
              <div key={letter} className="flex items-center justify-between py-2">
                <span className="text-sm font-medium tabular-nums">Serie {letter}</span>
                <span className="text-sm text-muted-foreground tabular-nums">
                  Senaste nr: {lastNum}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
