'use client'

import { useState, useEffect, useCallback } from 'react'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { KPIHeroCards } from '@/components/kpi/KPIHeroCards'
import { KPITrendChart } from '@/components/kpi/KPITrendChart'
import { KPISettingsDialog } from '@/components/kpi/KPISettingsDialog'
import { getDefaultPreferences } from '@/lib/reports/kpi-definitions'
import type { FiscalPeriod, KPIReport, KPIPreferences } from '@/types'

export default function KpiPage() {
  const [periods, setPeriods] = useState<FiscalPeriod[]>([])
  const [selectedPeriod, setSelectedPeriod] = useState('')
  const [report, setReport] = useState<KPIReport | null>(null)
  const [preferences, setPreferences] = useState<KPIPreferences>(getDefaultPreferences())
  const [isLoadingInit, setIsLoadingInit] = useState(true)
  const [isLoadingReport, setIsLoadingReport] = useState(false)
  const [isSavingPrefs, setIsSavingPrefs] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function init() {
      try {
        const [periodsRes, prefsRes] = await Promise.all([
          fetch('/api/bookkeeping/fiscal-periods'),
          fetch('/api/kpi/preferences'),
        ])
        const { data: periodsData } = await periodsRes.json()
        const { data: prefsData } = await prefsRes.json()

        const today = new Date().toISOString().split('T')[0]
        const activePeriods = (periodsData || []).filter((p: FiscalPeriod) => p.period_start <= today)
        setPeriods(activePeriods)
        if (prefsData) setPreferences(prefsData)
        if (activePeriods.length > 0) {
          setSelectedPeriod(activePeriods[0].id)
        }
      } catch {
        setError('Kunde inte hämta data')
      } finally {
        setIsLoadingInit(false)
      }
    }
    init()
  }, [])

  const fetchReport = useCallback(async (periodId: string) => {
    setIsLoadingReport(true)
    setError(null)
    try {
      const res = await fetch(`/api/reports/kpi?period_id=${periodId}`)
      if (!res.ok) throw new Error('Kunde inte hämta nyckeltal')
      const { data } = await res.json()
      setReport(data)
    } catch {
      setError('Kunde inte hämta nyckeltal')
    } finally {
      setIsLoadingReport(false)
    }
  }, [])

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

      // Re-fetch report if account overrides changed (calculations may differ)
      if (selectedPeriod) {
        await fetchReport(selectedPeriod)
      }
    } catch {
      // Silently fail — user can retry
    } finally {
      setIsSavingPrefs(false)
    }
  }

  if (isLoadingInit) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">Nyckeltal</h1>
          <p className="text-muted-foreground">Översikt av företagets ekonomiska hälsa</p>
        </div>
        <LoadingSkeleton />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">Nyckeltal</h1>
          <p className="text-muted-foreground">Översikt av företagets ekonomiska hälsa</p>
        </div>
        <KPISettingsDialog
          preferences={preferences}
          onSave={handleSavePreferences}
          saving={isSavingPrefs}
        />
      </div>

      {/* Period selector */}
      {periods.length > 0 && (
        <div>
          <Label>Räkenskapsår</Label>
          <select
            value={selectedPeriod}
            onChange={(e) => setSelectedPeriod(e.target.value)}
            className="w-full mt-1 max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.period_start} — {p.period_end})
              </option>
            ))}
          </select>
        </div>
      )}

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
        </>
      )}

      {!isLoadingReport && !error && !report && periods.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <p>Inget räkenskapsår hittades. Skapa ett räkenskapsår för att se nyckeltal.</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i}>
            <CardContent className="p-5 space-y-2">
              <div className="h-3 bg-muted rounded w-20 animate-pulse" />
              <div className="h-7 bg-muted rounded w-28 animate-pulse" />
              <div className="h-3 bg-muted rounded w-16 animate-pulse" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="h-4 bg-muted rounded w-40 animate-pulse" />
          <div className="h-56 bg-muted rounded animate-pulse" />
        </CardContent>
      </Card>
    </div>
  )
}
