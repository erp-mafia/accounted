'use client'

import { useState, useEffect, useCallback, useId } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { FyPicker } from '@/components/common/FyPicker'
import { KPIPanes, KPIBreakdown } from '@/components/kpi/KPIStory'
import { KPIMonthsTable } from '@/components/kpi/KPIMonthsTable'
import { KPISettingsDialog } from '@/components/kpi/KPISettingsDialog'
import { saveKPIPreferences } from '@/components/kpi/save-preferences'
import { loadKPIPreferences } from '@/components/kpi/load-preferences'
import { failureDescription, type ActionFailure } from '@/lib/browser/action-failure'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import type { KPIReport, KPIPreferences } from '@/types'

/**
 * Nyckeltal in the founder-picked "Instrumentbrädan" layout: a grid of
 * bordered instrument panes (monthly result bars + the preference-driven
 * KPIs) with the cost story as quiet rows below. Plain SVG bars: no
 * charting bundle on this page anymore.
 */
export default function KpiPage() {
  const t = useTranslations('kpi')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [selectedPeriod, setSelectedPeriod] = useState<string>('')
  const [report, setReport] = useState<KPIReport | null>(null)
  // null = the stored layout is not known: still loading, or the read failed
  // (prefsError). It never holds a fabricated value.
  const [preferences, setPreferences] = useState<KPIPreferences | null>(null)
  const [prefsError, setPrefsError] = useState<ActionFailure | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [isLoadingReport, setIsLoadingReport] = useState(false)
  const [isSavingPrefs, setIsSavingPrefs] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const prefsStatusId = useId()

  // A page that could not read the stored layout must not render one, and above
  // all must not let the user save over it. The previous version fell back to
  // getDefaultPreferences() on any failed read, silently: the grid presented
  // the defaults as though they were the user's, the settings dialog seeded
  // its draft from them, and the next save PUT a complete defaults-based
  // object over the stored row (the route merges key by key, so a payload
  // carrying every key replaces the row outright). A transient read failure
  // became permanent loss of the user's layout.
  //
  // So the unknown stays unknown: preferences stays null, the preference-driven
  // panes do not render, "Anpassa" is disabled, and one AttnLine says the
  // layout could not be read. An expired session (401/403) is the only case
  // where the reason changes what the user must do, so there the status-map
  // sentence replaces the retry; everything else is transient and the retry is
  // the whole answer.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setPrefsError(null)
      const result = await loadKPIPreferences({ locale })
      if (cancelled) return
      if (result.ok) {
        setPreferences(result.preferences)
      } else {
        setPreferences(null)
        setPrefsError(result)
      }
    })()
    return () => { cancelled = true }
  }, [reloadKey, locale])

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

  /**
   * Resolves true only when the row was written. The dialog keeps itself open on
   * false, so the draft the user assembled survives a failed save.
   *
   * The previous version swallowed both the `!res.ok` throw and every thrown
   * fetch behind "Silently fail: user can retry": the dialog closed, this grid
   * went on rendering the layout the user had just picked, and the next page
   * load read the untouched row back and reverted it. Exactly one toast per
   * outcome, since TOAST_LIMIT is 1.
   */
  async function handleSavePreferences(prefs: KPIPreferences): Promise<boolean> {
    let result
    setIsSavingPrefs(true)
    try {
      result = await saveKPIPreferences({ preferences: prefs, locale })
    } finally {
      // The busy state covers the save and nothing else. The report refetch
      // below is unbounded and has its own skeleton, and holding `saving` open
      // across it would keep the dialog locked on a request that is not the save.
      setIsSavingPrefs(false)
    }

    if (!result.ok) {
      toast({
        title: t('save_failed_title'),
        description: failureDescription(result, {
          // A timeout on a write is genuinely ambiguous: the row may have been
          // written. Say that instead of claiming the save failed.
          timeout: t('save_timeout'),
          network: t('save_network'),
        }),
        variant: 'destructive',
      })
      return false
    }

    setPreferences(result.preferences)
    // Not awaited: the layout is stored, so the dialog closes now. A failing
    // refetch reports itself through the `error` surface below.
    if (selectedPeriod) void fetchReport(selectedPeriod)
    return true
  }

  const isLoadingPrefs = preferences === null && prefsError === null

  return (
    <div className="space-y-8">
      {/* Header and read-status share one flow child so the always-mounted
          live region adds no vertical rhythm while it is empty. */}
      <div>
        <PageHeader
          title={t('title')}
          help={
            <HelpPopover>
              <p>{t('help_text')}</p>
            </HelpPopover>
          }
          action={
            <div className="flex items-center gap-2">
              {preferences ? (
                <KPISettingsDialog
                  preferences={preferences}
                  onSave={handleSavePreferences}
                  saving={isSavingPrefs}
                />
              ) : (
                // The dialog seeds its draft from `preferences` and saves the
                // complete draft, so while the stored layout is unknown the
                // control that opens it must not exist: a save from here would
                // overwrite the row with a layout the user never chose.
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled
                  aria-describedby={prefsError ? prefsStatusId : undefined}
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  {t('customize')}
                </Button>
              )}
              <FyPicker
                value={selectedPeriod || null}
                onChange={(id) => setSelectedPeriod(id || '')}
                includeAllOption={false}
                hideFuturePeriods
              />
            </div>
          }
        />

        {/* Live region always mounted so a failed read is announced when it
            appears, not merely inserted. Inline, never a toast: TOAST_LIMIT is
            1 and a toast here could evict a save failure's toast. */}
        <div id={prefsStatusId} role="status" aria-live="polite">
          {prefsError && (
            <AttnLine
              className="mt-3"
              action={
                prefsError.reason === 'server' &&
                (prefsError.status === 401 || prefsError.status === 403)
                  ? undefined
                  : { label: t('load_retry'), onClick: () => setReloadKey((k) => k + 1) }
              }
            >
              {failureDescription(prefsError, {
                timeout: t('load_timeout'),
                network: t('load_network'),
              })}
            </AttnLine>
          )}
        </div>
      </div>

      {error && (
        <p className="py-8 text-center text-sm text-muted-foreground">{error}</p>
      )}

      {(isLoadingReport || (!error && report !== null && isLoadingPrefs)) && (
        <LoadingSkeleton />
      )}

      {!isLoadingReport && !error && report && !isLoadingPrefs && (
        <div className="stagger-enter space-y-10">
          {/* The panes are the preference-driven surface: with the layout
              unknown they stay off rather than render defaults as if they
              were the user's. The cost story below reads only the report. */}
          {preferences && <KPIPanes report={report} preferences={preferences} />}
          {/* Same rule as the panes: a layout flag is only honoured once the
              stored layout is known. */}
          {preferences?.showMonthlyTable && <KPIMonthsTable report={report} />}
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
