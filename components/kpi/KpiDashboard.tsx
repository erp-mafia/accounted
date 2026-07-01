'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { KPIHeroCards } from '@/components/kpi/KPIHeroCards'
import { KPITrendChart } from '@/components/kpi/KPITrendChart'
import { KPIExpenseMixChart } from '@/components/kpi/KPIExpenseMixChart'
import { KPITopSuppliersChart } from '@/components/kpi/KPITopSuppliersChart'
import { getDefaultPreferences } from '@/lib/reports/kpi-definitions'
import type { KPIReport, KPIPreferences } from '@/types'

/**
 * The KPI dashboard body — hero cards + trend/expense/supplier charts for one
 * fiscal period. Period selection is owned by the caller (`periodId`) so this
 * renders both at `/kpi` (with its own selector + settings dialog, which passes
 * `preferences` as a controlled prop) and inside the Rapporter → Översikt tab
 * (uncontrolled: it fetches its own preferences).
 *
 * When `preferences` is supplied the report refetches whenever that reference
 * changes, mirroring the previous /kpi behaviour (saving preferences refreshes
 * the report so any preference-derived server figures update).
 */
export function KpiDashboard({
  periodId,
  preferences: controlledPreferences,
}: {
  periodId: string
  preferences?: KPIPreferences
}) {
  const t = useTranslations('kpi')
  const isControlled = controlledPreferences !== undefined

  const [fetchedPreferences, setFetchedPreferences] = useState<KPIPreferences>(
    getDefaultPreferences(),
  )
  const [preferencesReady, setPreferencesReady] = useState(isControlled)
  const preferences = isControlled ? controlledPreferences : fetchedPreferences

  const [report, setReport] = useState<KPIReport | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Uncontrolled callers (Översikt tab) fetch their own preferences once.
  useEffect(() => {
    if (isControlled) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/kpi/preferences')
        const { data } = await res.json()
        if (!cancelled && data) setFetchedPreferences(data)
      } catch {
        // Silently fall back to defaults
      } finally {
        if (!cancelled) setPreferencesReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isControlled])

  const fetchReport = useCallback(
    async (id: string) => {
      setIsLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/reports/kpi?period_id=${id}`)
        if (!res.ok) throw new Error(t('fetch_failed'))
        const { data } = await res.json()
        setReport(data)
      } catch {
        setError(t('fetch_failed'))
      } finally {
        setIsLoading(false)
      }
    },
    [t],
  )

  // Fetch the report once a period is chosen and preferences have settled.
  // `preferences` is a dependency so a controlled preference change refetches.
  useEffect(() => {
    if (!periodId || !preferencesReady) {
      setReport(null)
      return
    }
    let cancelled = false
    fetchReport(periodId).then(() => {
      if (cancelled) setReport(null)
    })
    return () => {
      cancelled = true
    }
  }, [periodId, preferencesReady, preferences, fetchReport])

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <p>{error}</p>
        </CardContent>
      </Card>
    )
  }

  if (isLoading) return <KpiDashboardSkeleton />

  if (!report) return null

  return (
    <div className="space-y-8">
      <KPIHeroCards report={report} preferences={preferences} />
      {report.months.length > 0 && <KPITrendChart months={report.months} />}
      <div className="grid gap-4 md:grid-cols-2">
        <KPIExpenseMixChart composition={report.expenseComposition} />
        <KPITopSuppliersChart suppliers={report.topSuppliers} />
      </div>
    </div>
  )
}

export function KpiDashboardSkeleton() {
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
