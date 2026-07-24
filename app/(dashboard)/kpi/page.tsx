'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { FyPicker } from '@/components/common/FyPicker'
import { KPIPanes, KPIBreakdown } from '@/components/kpi/KPIStory'
import { KPISettingsDialog } from '@/components/kpi/KPISettingsDialog'
import { getDefaultPreferences } from '@/lib/reports/kpi-definitions'
import type { KPIReport, KPIPreferences } from '@/types'

/**
 * Nyckeltal in the founder-picked "Instrumentbrädan" layout: a grid of
 * bordered instrument panes (monthly result bars + the preference-driven
 * KPIs) with the cost story as quiet rows below. Plain SVG bars: no
 * charting bundle on this page anymore.
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
          <KPIPanes report={report} preferences={preferences} />
          <KPIBreakdown report={report} />
        </div>
      )}
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {[1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className="h-40 w-full rounded-lg" />
      ))}
    </div>
  )
}
