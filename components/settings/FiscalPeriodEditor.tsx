'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { Loader2, Info, Lock } from 'lucide-react'
import { parseDateParts } from '@/lib/bookkeeping/validate-period-duration'
import {
  FiscalPeriodDateFields,
  validateFirstPeriod,
} from '@/components/bookkeeping/FiscalPeriodDateFields'
import type { FiscalPeriod } from '@/types'

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

  useEffect(() => {
    if (!company) return
    let cancelled = false

    async function load() {
      setIsLoading(true)
      setLoadError(null)
      try {
        const res = await fetch('/api/bookkeeping/fiscal-periods')
        if (!res.ok) throw new Error(t('fp_load_error_periods'))
        const { data } = (await res.json()) as { data: FiscalPeriod[] }
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
          setLoadError(err instanceof Error ? err.message : t('fp_load_error_unknown'))
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [company, t])

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
      toast({
        title: t('fp_updated_title'),
        description: `${formatSwedishDate(body.data.period_start)}: ${formatSwedishDate(body.data.period_end)}`,
      })
    } catch (err) {
      toast({
        title: t('fp_update_failed_title'),
        description: err instanceof Error ? err.message : t('fp_try_again'),
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
      <section className="space-y-4 border-t border-border pt-8">
        <div className="space-y-1">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            {t('fp_heading')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('fp_intro')}
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('fp_loading')}
          </div>
        ) : loadError ? (
          <p className="text-sm text-destructive">{loadError}</p>
        ) : !period ? (
          <p className="text-sm text-muted-foreground">{t('fp_none')}</p>
        ) : isBlocked ? (
          <BlockedState
            period={period}
            postedCount={postedCount ?? 0}
          />
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-warning/20 bg-warning/5 p-3 text-sm flex gap-2">
              <Info className="h-4 w-4 text-warning flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-medium">{t('fp_warning_title')}</p>
                <p className="text-muted-foreground">
                  {t('fp_warning_body')}
                  {isEF && t('fp_warning_ef_suffix')}
                </p>
              </div>
            </div>

            <FiscalPeriodDateFields
              startDate={startDate}
              onStartDateChange={setStartDate}
              endDate={endDate}
              entityType={company?.entity_type}
              summaryTitle={t('fp_summary_title')}
              endDateSlot={
                <div className="space-y-2">
                  <Label htmlFor="fp_end">{t('fp_end_date_label')}</Label>
                  <Input
                    id="fp_end"
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('fp_end_date_help')}
                  </p>
                </div>
              }
            />

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleReset}
                disabled={!isDirty || isSaving}
              >
                {t('fp_reset')}
              </Button>
              <Button
                type="button"
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
          </div>
        )}
      </section>
      <DestructiveConfirmDialog {...dialogProps} />
    </>
  )
}

function BlockedState({
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
    <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
      <div className="flex gap-2">
        <Lock className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{t('fp_blocked_title')}</p>
          <p className="text-sm text-muted-foreground">{reason}</p>
        </div>
      </div>
      <div className="text-sm text-muted-foreground space-y-1">
        <p>
          {t('fp_blocked_first_year')}{' '}
          <span className="font-medium text-foreground">
            {formatSwedishDate(period.period_start)} &ndash; {formatSwedishDate(period.period_end)}
          </span>
          {isCalendarYear(period) ? t('fp_blocked_calendar_year') : t('fp_blocked_broken_year')}
        </p>
        <p>
          {t('fp_blocked_explainer')}
        </p>
      </div>
    </div>
  )
}
