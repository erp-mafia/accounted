'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { FyPicker } from '@/components/common/FyPicker'
import { KPIStoryHero, KPIRail, KPIBreakdown } from '@/components/kpi/KPIStory'
import { KPISettingsDialog } from '@/components/kpi/KPISettingsDialog'
import { getDefaultPreferences } from '@/lib/reports/kpi-definitions'
import type { KPIReport, KPIPreferences } from '@/types'

// Recharts is ~180KB: defer the chart so the page shell, hero and rail render
// without waiting for the charting bundle.
const KPIResultChart = dynamic(
  () => import('@/components/kpi/KPIResultChart').then((m) => m.KPIResultChart),
  { ssr: false, loading: () => <Skeleton className="mt-8 h-[200px] w-full" /> },
)

/**
 * Nyckeltal in the founder-picked "Berättelsen" layout: the month's result
 * as a serif hero + trend area on the left, the preference-driven metric
 * rail on the right, and the cost story as quiet rows below.
 */
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
      <PageHeader
        title={t('title')}
        help={
          <HelpPopover>
            <p>{t('help_text')}</p>
          </HelpPopover>
        }
        action={
          <div className="flex items-center gap-2">
            <KPISettingsDialog
              preferences={preferences}
              onSave={handleSavePreferences}
              saving={isSavingPrefs}
            />
            <FyPicker
              value={selectedPeriod || null}
              onChange={(id) => setSelectedPeriod(id || '')}
              includeAllOption={false}
              hideFuturePeriods
            />
          </div>
        }
      />

      {error && (
        <p className="py-8 text-center text-sm text-muted-foreground">{error}</p>
      )}

      {isLoadingReport && <LoadingSkeleton />}

      {!isLoadingReport && !error && report && (
        <div className="stagger-enter space-y-10">
          <div className="grid items-start gap-x-11 gap-y-10 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <section>
              <KPIStoryHero report={report} />
              {report.months.length > 0 && <KPIResultChart months={report.months} />}
            </section>
            <aside className="lg:border-l lg:border-border lg:pl-7">
              <KPIRail report={report} preferences={preferences} />
            </aside>
          </div>
          <KPIBreakdown report={report} />
        </div>
      )}
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="grid items-start gap-x-11 gap-y-10 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-3 w-40" />
        <Skeleton className="mt-6 h-[200px] w-full" />
      </div>
      <div className="space-y-6 lg:border-l lg:border-border lg:pl-7">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-6 w-32" />
          </div>
        ))}
      </div>
    </div>
  )
}
