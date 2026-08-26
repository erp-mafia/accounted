'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { Loader2, Lock } from 'lucide-react'
import { parseDateParts } from '@/lib/bookkeeping/validate-period-duration'
import { validateFirstPeriod } from '@/components/bookkeeping/FiscalPeriodDateFields'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'
import type { FiscalPeriod } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

function formatSwedishDate(dateStr: string): string {
  const months = [
    'januari', 'februari', 'mars', 'april', 'maj', 'juni',
    'juli', 'augusti', 'september', 'oktober', 'november', 'december',
  ]
  const { year, month, day } = parseDateParts(dateStr)
  return `${day} ${months[month - 1]} ${year}`
}

function isCalendarYear(period: { period_start: string; period_end: string }): boolean {
  const s = parseDateParts(period.period_start)
  const e = parseDateParts(period.period_end)
  return s.month === 1 && s.day === 1 && e.month === 12 && e.day === 31
}

export function FiscalPeriodEditor() {
  const t = useTranslations('settings_company')
  const { company, role } = useCompany()
  const { toast } = useToast()
  const { dialogProps, confirm } = useDestructiveConfirm()

  const [period, setPeriod] = useState<FiscalPeriod | null>(null)
  const [postedCount, setPostedCount] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const isEF = company?.entity_type === 'enskild_firma'
  const canEdit = role === 'owner' || role === 'admin'

  // Periods come from the session cache (lib/reference-data). The editor
  // snapshots the FIRST period once per company (a background revalidation
  // must not reset the dates the user is editing), then loads that period's
  // posted-entry count, which is what gates editing.
  const { periods, isLoading: periodsLoading, error: periodsError } = useFiscalPeriods()
  const periodsRef = useRef(periods)
  useEffect(() => {
    periodsRef.current = periods
  }, [periods])
  const initialisedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!company || periodsLoading) return
    if (initialisedForRef.current === company.id) return
    initialisedForRef.current = company.id
    let cancelled = false

    async function load() {
      setIsLoading(true)
      setLoadError(null)
      try {
        if (periodsError) throw new Error(t('fp_load_error_periods'))
        const data = periodsRef.current
        if (!data || data.length === 0) {
          if (!cancelled) {
            setPeriod(null)
            setIsLoading(false)
          }
          return
        }
        const sorted = [...data].sort((a, b) => a.period_start.localeCompare(b.period_start))
        const first = sorted[0]

        const countRes = await fetch(`/api/bookkeeping/fiscal-periods/${first.id}/entry-count`)
        if (!countRes.ok) throw new Error(t('fp_load_error_entry_count'))
        const { data: countData } = (await countRes.json()) as { data: { posted_count: number } }

        if (cancelled) return
        setPeriod(first)
        setPostedCount(countData.posted_count)
        setStartDate(first.period_start)
        setEndDate(first.period_end)
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? getUserErrorMessage(err) : t('fp_load_error_unknown'))
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [company, periodsLoading, periodsError, t])

  const validation = validateFirstPeriod(
    startDate,
    endDate,
    company?.entity_type,
  )

  const isBlocked =
    !!period && (period.locked_at || period.is_closed || (postedCount ?? 0) > 0)

  const isDirty =
    period !== null && (startDate !== period.period_start || endDate !== period.period_end)

  if (!company || !canEdit) return null

  async function handleSave() {
    if (!period || !company) return
    if (!isDirty) return

    const ok = await confirm({
      title: t('fp_confirm_title'),
      description: t('fp_confirm_description', {
        oldStart: formatSwedishDate(period.period_start),
        oldEnd: formatSwedishDate(period.period_end),
        newStart: formatSwedishDate(startDate),
        newEnd: formatSwedishDate(endDate),
      }),
      confirmLabel: t('fp_confirm_yes'),
      cancelLabel: t('fp_confirm_cancel'),
      variant: 'warning',
    })
    if (!ok) return

    setIsSaving(true)
    try {
      const startYear = parseDateParts(startDate).year
      const endYear = parseDateParts(endDate).year
      const newName =
        startYear === endYear
          ? t('fp_year_label_single', { year: startYear })
          : t('fp_year_label_range', { startYear, endYear })
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${period.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period_start: startDate,
          period_end: endDate,
          name: newName,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(body.error || t('fp_update_failed_title'))
      }
      setPeriod(body.data as FiscalPeriod)
      // Every picker reads the shared list: refresh it with the new dates.
      void invalidateReferenceData('ref:fiscal-periods')
      toast({
        title: t('fp_updated_title'),
        description: `${formatSwedishDate(body.data.period_start)}: ${formatSwedishDate(body.data.period_end)}`,
      })
    } catch (err) {
      toast({
        title: t('fp_update_failed_title'),
        description: err instanceof Error ? getUserErrorMessage(err) : t('fp_try_again'),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  function handleReset() {
    if (!period) return
    setStartDate(period.period_start)
    setEndDate(period.period_end)
  }

  return (
    <>
      <SettingsGroup label={t('fp_heading')} help={t('fp_intro')}>
        {isLoading ? (
          <div className="flex items-center gap-2 px-1 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('fp_loading')}
          </div>
        ) : loadError ? (
          <p className="px-1 py-3 text-sm text-destructive">{loadError}</p>
        ) : !period ? (
          <p className="px-1 py-3 text-sm text-muted-foreground">{t('fp_none')}</p>
        ) : isBlocked ? (
          <BlockedRow period={period} postedCount={postedCount ?? 0} />
        ) : (
          <>
            {/* Consequential warning: stays visible as one quiet ochre sentence. */}
            <p className="px-1 py-3 text-[12.5px] text-attn">
              {t('fp_warning_title')} {t('fp_warning_body')}
              {isEF ? t('fp_warning_ef_suffix') : null}
            </p>

            <SettingsRow
              label={t('fp_start_date_label')}
              htmlFor="fiscal-period-start"
              help={t('fp_start_date_help')}
              align="baseline"
            >
              <SettingsInput
                id="fiscal-period-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="max-w-44 flex-none tabular-nums"
              />
            </SettingsRow>

            <SettingsRow
              label={t('fp_end_date_label')}
              htmlFor="fp_end"
              help={t('fp_end_date_help')}
              align="baseline"
            >
              <SettingsInput
                id="fp_end"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="max-w-44 flex-none tabular-nums"
              />
            </SettingsRow>

            {validation.canSummarise && (
              <p className="px-1 pt-3 text-xs text-muted-foreground">
                {t('fp_summary_title')}:{' '}
                <span className="tabular-nums">
                  {t('fp_range', { start: formatSwedishDate(startDate), end: formatSwedishDate(endDate) })}
                </span>
                {validation.months !== null && <> · {t('fp_months', { count: validation.months })}</>}
              </p>
            )}
            {validation.error && (
              <p className="px-1 pt-1 text-xs text-destructive">{validation.error}</p>
            )}

            <div className="flex justify-end gap-2 px-1 pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleReset}
                disabled={!isDirty || isSaving}
                className="text-muted-foreground hover:text-foreground"
              >
                {t('fp_reset')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleSave}
                disabled={
                  !isDirty ||
                  isSaving ||
                  !startDate ||
                  !endDate ||
                  validation.error !== null
                }
              >
                {isSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('fp_saving')}
                  </>
                ) : (
                  t('fp_save')
                )}
              </Button>
            </div>
          </>
        )}
      </SettingsGroup>
      <DestructiveConfirmDialog {...dialogProps} />
    </>
  )
}

function BlockedRow({
  period,
  postedCount,
}: {
  period: FiscalPeriod
  postedCount: number
}) {
  const t = useTranslations('settings_company')
  const reason = period.locked_at
    ? t('fp_blocked_reason_locked')
    : period.is_closed
      ? t('fp_blocked_reason_closed')
      : t('fp_blocked_reason_posted', { count: postedCount })

  return (
    <SettingsRow
      // The key carries a trailing colon from its old inline usage; strip it
      // for the micro-label position.
      label={t('fp_blocked_first_year').replace(/:$/, '')}
      help={
        <>
          <p>
            {t('fp_blocked_title')}. {reason}
          </p>
          <p className="mt-2">{t('fp_blocked_explainer')}</p>
        </>
      }
      borderless
    >
      <Lock aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="tabular-nums">
        {t('fp_range', { start: formatSwedishDate(period.period_start), end: formatSwedishDate(period.period_end) })}
      </span>
      <SettingsRowNote>
        {(isCalendarYear(period) ? t('fp_blocked_calendar_year') : t('fp_blocked_broken_year')).trim()}
      </SettingsRowNote>
    </SettingsRow>
  )
}
