'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { FiscalYearSelector } from '@/components/common/FiscalYearSelector'
import { KPISettingsDialog } from '@/components/kpi/KPISettingsDialog'
import { KpiDashboard } from '@/components/kpi/KpiDashboard'
import { getDefaultPreferences } from '@/lib/reports/kpi-definitions'
import type { KPIPreferences } from '@/types'

export default function KpiPage() {
  const t = useTranslations('kpi')
  const [selectedPeriod, setSelectedPeriod] = useState<string>('')
  const [preferences, setPreferences] = useState<KPIPreferences>(getDefaultPreferences())
  const [isSavingPrefs, setIsSavingPrefs] = useState(false)

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
      // New reference → KpiDashboard refetches the report with updated prefs.
      setPreferences(data)
    } catch {
      // Silently fail — user can retry
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

      <KpiDashboard periodId={selectedPeriod} preferences={preferences} />
    </div>
  )
}
