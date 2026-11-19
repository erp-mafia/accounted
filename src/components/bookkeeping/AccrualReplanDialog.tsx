'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { isAccruedBalanceAccount } from '@/lib/bookkeeping/accruals/account-suggestions'
import type {
  AccrualReplanMonth,
  AccrualReplanResult,
  AccrualSchedule,
  AccrualScheduleInstallment,
} from '@/types'

export type ReplannableSchedule = Pick<
  AccrualSchedule,
  'id' | 'status' | 'direction' | 'balance_account' | 'description' | 'period_start' | 'period_end' | 'release_day'
> & { installments: Pick<AccrualScheduleInstallment, 'status'>[] }

/**
 * True when "Ändra periodisering" can act on the schedule: active, a
 * deferral (an upplupen kostnad or intäkt books each month end before its
 * invoice) and with a month left that is not yet booked. The server holds the same
 * rules (replanRemainingInstallments); this only decides whether to offer it.
 */
export function canReplanSchedule(schedule: ReplannableSchedule | null | undefined): boolean {
  if (!schedule || schedule.status !== 'active') return false
  if (isAccruedBalanceAccount(schedule.direction, schedule.balance_account)) return false
  return schedule.installments.some((i) => i.status === 'pending')
}

// '' is the default, the first of the month; then the 2nd to the 28th, and 31
// for the last day of every month.
const DAY_OPTIONS = ['', ...Array.from({ length: 27 }, (_, i) => String(i + 2)), '31']

function dayValue(releaseDay: number | null | undefined): string {
  return releaseDay === null || releaseDay === undefined ? '' : String(releaseDay)
}

interface AccrualReplanDialogProps {
  schedule: ReplannableSchedule | null
  onOpenChange: (open: boolean) => void
  /** After a committed re-plan, to reload what the page shows. */
  onReplanned: () => void
}

/**
 * "Ändra periodisering": a new period end and/or the day each month books
 * on, for the months not yet booked. Every change is previewed by the
 * server's dry run (PATCH /api/bookkeeping/accruals/{id}, the same rules
 * the commit runs), shown as the months now and after the change, and
 * committed only on confirm. One dialog for the periodiseringar page and the
 * invoice pages.
 */
export function AccrualReplanDialog({ schedule, onOpenChange, onReplanned }: AccrualReplanDialogProps) {
  const t = useTranslations('accruals')
  const locale: ErrorLocale = useLocale().startsWith('sv') ? 'sv' : 'en'
  const { toast } = useToast()
  const [periodEnd, setPeriodEnd] = useState('')
  const [day, setDay] = useState('')
  const [preview, setPreview] = useState<AccrualReplanResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!schedule) return
    setPeriodEnd(schedule.period_end)
    setDay(dayValue(schedule.release_day))
    setPreview(null)
    setPreviewError(null)
  }, [schedule])

  const changed =
    !!schedule && (periodEnd !== schedule.period_end || day !== dayValue(schedule.release_day))
  const body = useMemo(
    () =>
      schedule
        ? {
            ...(periodEnd !== schedule.period_end ? { period_end: periodEnd } : {}),
            ...(day !== dayValue(schedule.release_day) ? { release_day: day === '' ? null : Number(day) } : {}),
          }
        : {},
    [schedule, periodEnd, day],
  )

  // The dry run answers what the commit would do; debounced so typing a
  // date asks once.
  useEffect(() => {
    if (!schedule || !changed || !periodEnd) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/bookkeeping/accruals/${schedule.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, dry_run: true }),
        })
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setPreview(null)
          setPreviewError(getErrorMessage(json, { locale, context: 'journal_entry' }))
        } else {
          setPreview(json.data as AccrualReplanResult)
          setPreviewError(null)
        }
      } catch (error) {
        if (!cancelled) setPreviewError(getErrorMessage(error, { locale, context: 'journal_entry' }))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [schedule, changed, periodEnd, body, locale])

  async function handleConfirm() {
    if (!schedule) return
    try {
      const res = await fetch(`/api/bookkeeping/accruals/${schedule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(getErrorMessage(json, { locale, context: 'journal_entry' }))
      const result = json.data as AccrualReplanResult
      const postedNow = result.posted_now ?? 0
      toast({
        title: t('replan_success_title'),
        description: [
          t('replan_success_description', { months: result.after.length }),
          postedNow > 0 ? t('replan_success_posted', { posted: postedNow }) : null,
        ]
          .filter(Boolean)
          .join(' '),
      })
      onReplanned()
    } catch (error) {
      toast({
        title: t('replan_failed_title'),
        description: getErrorMessage(error, { locale, context: 'journal_entry' }),
        variant: 'destructive',
      })
    }
  }

  const rows = useMemo(() => {
    if (!preview) return []
    const now = new Map(preview.before.map((m) => [m.period_month, m]))
    const after = new Map(preview.after.map((m) => [m.period_month, m]))
    return [...new Set([...now.keys(), ...after.keys()])]
      .sort()
      .map((month) => ({ month, now: now.get(month), after: after.get(month) }))
  }, [preview])

  const cell = (m: AccrualReplanMonth | undefined) =>
    m ? (
      <span className="tabular-nums">
        {formatCurrency(m.amount)}
        <span className="ml-2 text-xs text-muted-foreground">{formatDate(m.booking_date)}</span>
      </span>
    ) : (
      <span className="text-muted-foreground">-</span>
    )

  return (
    <ConfirmDialog
      open={schedule !== null}
      onOpenChange={onOpenChange}
      title={t('replan_title')}
      description={
        schedule?.description
          ? `${schedule.description}. ${t('replan_description', {
              remaining: formatCurrency(preview?.remaining_amount ?? 0),
            })}`
          : t('replan_description', { remaining: formatCurrency(preview?.remaining_amount ?? 0) })
      }
      confirmLabel={t('replan_confirm')}
      confirmDisabled={!preview || loading}
      onConfirm={handleConfirm}
    >
      {schedule && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="accrual-replan-end" className="text-xs">
                {t('end_label')}
              </Label>
              <Input
                id="accrual-replan-end"
                type="date"
                className="h-9"
                value={periodEnd}
                min={schedule.period_start}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('replan_day_label')}</Label>
              <Select value={day === '' ? 'default' : day} onValueChange={(v) => setDay(v === 'default' ? '' : v)}>
                <SelectTrigger className="h-9" aria-label={t('replan_day_label')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_OPTIONS.map((option) => (
                    <SelectItem key={option || 'default'} value={option || 'default'}>
                      {option === ''
                        ? t('replan_day_default')
                        : option === '31'
                          ? t('replan_day_last')
                          : t('replan_day_option', { day: option })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {!changed ? (
            <p className="text-xs text-muted-foreground">{t('replan_unchanged')}</p>
          ) : previewError ? (
            <p className="text-xs text-destructive">{previewError}</p>
          ) : loading && !preview ? (
            <p className="text-xs text-muted-foreground">{t('replan_loading')}</p>
          ) : preview ? (
            <div className={cn('max-h-64 overflow-y-auto', loading && 'opacity-60')}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-medium text-muted-foreground">
                    <th className="pb-2">{t('replan_col_month')}</th>
                    <th className="pb-2 text-right">{t('replan_col_now')}</th>
                    <th className="pb-2 text-right">{t('replan_col_after')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.month} className="border-t-hairline">
                      <td className="py-1.5 tabular-nums">{row.month.slice(0, 7)}</td>
                      <td className="py-1.5 text-right">{cell(row.now)}</td>
                      <td className="py-1.5 text-right">{cell(row.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </ConfirmDialog>
  )
}
