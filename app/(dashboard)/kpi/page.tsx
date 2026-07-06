'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from "@/components/ui/skeleton"
import { FiscalYearSelector } from '@/components/common/FiscalYearSelector'
import dynamic from 'next/dynamic'
import { KPIHeroCards } from '@/components/kpi/KPIHeroCards'

// Recharts is ~180KB: defer the chart components so the KPI page shell and
// hero cards render without waiting for the charting bundle.
const chartFallback = () => <Skeleton className="h-[300px] w-full" />
const KPITrendChart = dynamic(
  () => import('@/components/kpi/KPITrendChart').then((m) => m.KPITrendChart),
  { ssr: false, loading: chartFallback },
)
const KPIExpenseMixChart = dynamic(
  () => import('@/components/kpi/KPIExpenseMixChart').then((m) => m.KPIExpenseMixChart),
  { ssr: false, loading: chartFallback },
)
const KPITopSuppliersChart = dynamic(
  () => import('@/components/kpi/KPITopSuppliersChart').then((m) => m.KPITopSuppliersChart),
  { ssr: false, loading: chartFallback },
)
import { KPISettingsDialog } from '@/components/kpi/KPISettingsDialog'
import { getDefaultPreferences } from '@/lib/reports/kpi-definitions'
import type { KPIReport, KPIPreferences } from '@/types'

export default function KpiPage() {
  const t = useTranslations('kpi')
  const [selectedPeriod, setSelectedPeriod] = useState<string>('')
  const [report, setReport] = useState<KPIReport | null>(null)
  const [preferences, setPreferences] = useState<KPIPreferences>(getDefaultPreferences())
  const [isLoadingReport, setIsLoadingReport] = useState(false)
  const [isSavingPrefs, setIsSavingPrefs] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/kpi/preferences')
        const { data } = await res.json()
        if (!cancelled && data) setPreferences(data)
      } catch {
        // Silently fall back to defaults
      }
    })()
    return () => { cancelled = true }
  }, [])

  const fetchReport = useCallback(async (periodId: string) => {
    setIsLoadingReport(true)
    setError(null)
    try {
      const res = await fetch(`/api/reports/kpi?period_id=${periodId}`)
      if (!res.ok) throw new Error(t('fetch_failed'))
      const { data } = await res.json()
      setReport(data)
    } catch {
      setError(t('fetch_failed'))
    } finally {
      setIsLoadingReport(false)
    }
  }, [t])

  useEffect(() => {
    if (!selectedPeriod) return
    let cancelled = false
    fetchReport(selectedPeriod).then(() => {
      if (cancelled) setReport(null)
    })
    return () => { cancelled = true }
  }, [selectedPeriod, fetchReport])

  async function handleSavePreferences(prefs: KPIPreferences) {
    setIsSavingPrefs(true)
    try {
      const res = await fetch('/api/kpi/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      })
      if (!res.ok) throw new Error()
      const { data } = await res.json()
      setPreferences(data)
      if (selectedPeriod) await fetchReport(selectedPeriod)
    } catch {
      // Silently fail: user can retry
    } finally {
      setIsSavingPrefs(false)
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl md:text-3xl tracking-tight">{t('title')}</h1>
        <div className="flex gap-2">
          <KPISettingsDialog
            preferences={preferences}
            onSave={handleSavePreferences}
            saving={isSavingPrefs}
          />
        </div>
      </div>

      <FiscalYearSelector
        value={selectedPeriod || null}
        onChange={(id) => setSelectedPeriod(id || '')}
        includeAllOption={false}
        hideFuturePeriods
      />

      {error && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <p>{error}</p>
          </CardContent>
        </Card>
      )}

      {isLoadingReport && <LoadingSkeleton />}

      {!isLoadingReport && !error && report && (
        <>
          <KPIHeroCards report={report} preferences={preferences} />
          {report.months.length > 0 && <KPITrendChart months={report.months} />}
          <div className="grid gap-4 md:grid-cols-2">
            <KPIExpenseMixChart composition={report.expenseComposition} />
            <KPITopSuppliersChart suppliers={report.topSuppliers} />
          </div>
        </>
      )}
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i}>
            <CardContent className="p-6 space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-3 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="p-6 space-y-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-56" />
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        {[1, 2].map((i) => (
          <Card key={i}>
            <CardContent className="p-6 space-y-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-40" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
