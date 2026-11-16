'use client'

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { SettingsGroup, SettingsRow, SettingsSelect } from '@/components/settings/SettingsRows'
import { addDaysIso, addMonthsIso, todayIsoStockholm } from '@/lib/dates/iso'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

/** The last day of each of the twelve months before the current one, newest first. */
function recentMonthEnds(today: string): string[] {
  const firstOfMonth = `${today.slice(0, 7)}-01`
  return Array.from({ length: 12 }, (_, i) => addDaysIso(addMonthsIso(firstOfMonth, -i), -1))
}

/**
 * "Omvärdera per månadsskifte": books the month-end currency revaluation and
 * its storno on the next day (#523) through
 * POST /api/bookkeeping/currency-revaluation/monthly. Shown on the bookkeeping
 * settings beside the choice of monthly revaluation, only once the company
 * has chosen it. The balansdag stays with the year-end close.
 */
export function MonthlyFxRevaluationAction() {
  const t = useTranslations('settings_bookkeeping')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite, lockedTitle } = useViewerLock()
  const monthEnds = useMemo(() => recentMonthEnds(todayIsoStockholm()), [])
  const [monthEnd, setMonthEnd] = useState(monthEnds[0])
  const [confirming, setConfirming] = useState(false)
  const nextDay = addDaysIso(monthEnd, 1)

  async function revalue() {
    const res = await fetch('/api/bookkeeping/currency-revaluation/monthly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month_end: monthEnd }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast({
        title: t('fx_monthly_failed'),
        description: getErrorMessage(body, { locale, fallback: t('fx_monthly_failed') }),
        variant: 'destructive',
      })
      return
    }
    toast({
      title: body.data
        ? t('fx_monthly_done', { voucher: formatVoucher(body.data), date: nextDay })
        : t('fx_monthly_nothing', { date: monthEnd }),
    })
  }

  return (
    <SettingsGroup label={t('fx_monthly_heading')}>
      <SettingsRow label={t('fx_monthly_label')} htmlFor="fx_monthly_month_end" help={t('fx_monthly_help')}>
        <SettingsSelect
          id="fx_monthly_month_end"
          value={monthEnd}
          onChange={(e) => setMonthEnd(e.target.value)}
          className="tabular-nums"
        >
          {monthEnds.map((date) => (
            <option key={date} value={date}>
              {date}
            </option>
          ))}
        </SettingsSelect>
        <Button type="button" variant="outline" onClick={() => setConfirming(true)} disabled={!canWrite} title={lockedTitle}>
          {t('fx_monthly_action')}
        </Button>
      </SettingsRow>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('fx_monthly_confirm_title', { date: monthEnd })}
        description={t('fx_monthly_confirm_description', { date: monthEnd, next: nextDay })}
        confirmLabel={t('fx_monthly_action')}
        onConfirm={revalue}
      />
    </SettingsGroup>
  )
}
