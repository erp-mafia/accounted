'use client'

/**
 * Semester card on the salary dashboard (payroll gap-closure 3.5).
 *
 * Shows the open vacation-ledger totals (remaining + saved days across
 * active employees) and hosts the year-close dialog: dry-run report first,
 * a working confirm second (soft-guard convention).
 */

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Palmtree, Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency } from '@/lib/utils'

interface BalanceRow {
  employee_vacation_balance_id: string
  employee_name: string
  remaining_days: number
  saved_days_total: number
  forced_payout_days: number
}

interface CloseReportRow {
  employee_name: string
  remaining_days: number
  saveable_days: number
  untaken_below_floor_days: number
  expiring_days: number
  next_year_entitled: number
}

interface CloseReport {
  vacation_year_start: string
  vacation_year_end: string
  rows: CloseReportRow[]
  sek: {
    computed_liability: number
    booked_2920: number
    drift_2920: number
    adjustment_needed: boolean
  }
}

export function VacationBalanceCard({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations('salary')
  const { toast } = useToast()
  const [rows, setRows] = useState<BalanceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [report, setReport] = useState<CloseReport | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [closing, setClosing] = useState(false)

  async function fetchBalances(): Promise<BalanceRow[] | null> {
    const res = await fetch('/api/salary/vacation-balances')
    if (!res.ok) return null
    const { data } = await res.json()
    return (data ?? []) as BalanceRow[]
  }

  useEffect(() => {
    let cancelled = false
    fetchBalances().then((data) => {
      if (cancelled) return
      if (data) setRows(data)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const totalRemaining = rows.reduce((s, r) => s + r.remaining_days, 0)
  const totalSaved = rows.reduce((s, r) => s + r.saved_days_total, 0)

  async function openCloseDialog() {
    setDialogOpen(true)
    setPreviewing(true)
    setReport(null)
    setPreviewError(null)
    const res = await fetch('/api/salary/vacation-year-close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: true }),
    })
    const body = await res.json()
    if (res.ok) {
      setReport(body.data.report as CloseReport)
    } else {
      setPreviewError(body.error ?? t('vacation_close_preview_failed'))
    }
    setPreviewing(false)
  }

  async function confirmClose() {
    setClosing(true)
    const res = await fetch('/api/salary/vacation-year-close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_adjustment: true }),
    })
    const body = await res.json()
    if (res.ok) {
      toast({ title: t('vacation_close_done') })
      setDialogOpen(false)
      const refreshed = await fetchBalances()
      if (refreshed) setRows(refreshed)
    } else {
      toast({
        title: t('vacation_close_failed'),
        description: body.error,
        variant: 'destructive',
      })
    }
    setClosing(false)
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <Palmtree className="h-4 w-4 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">{t('card_vacation_title')}</p>
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : rows.length > 0 ? (
          <>
            <p className="font-sans text-lg font-medium tabular-nums leading-tight">
              {totalRemaining}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('card_vacation_detail', { employees: rows.length, saved: totalSaved })}
            </p>
            {canWrite && (
              <Button variant="outline" size="sm" className="mt-2" onClick={openCloseDialog}>
                {t('vacation_close_button')}
              </Button>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('card_vacation_none')}</p>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('vacation_close_title')}</DialogTitle>
            <DialogDescription>{t('vacation_close_description')}</DialogDescription>
          </DialogHeader>

          {previewing && (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('vacation_close_previewing')}
            </div>
          )}

          {previewError && <p className="text-sm text-destructive py-4">{previewError}</p>}

          {report && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {t('vacation_close_period', {
                  from: report.vacation_year_start,
                  to: report.vacation_year_end,
                })}
              </p>
              <div className="max-h-64 overflow-y-auto border border-border rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      <th className="text-left px-3 py-2">{t('vacation_close_col_employee')}</th>
                      <th className="text-right px-3 py-2">{t('vacation_close_col_saved')}</th>
                      <th className="text-right px-3 py-2">{t('vacation_close_col_flagged')}</th>
                      <th className="text-right px-3 py-2">{t('vacation_close_col_expiring')}</th>
                      <th className="text-right px-3 py-2">{t('vacation_close_col_next')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row, idx) => (
                      <tr key={idx} className="border-t border-border">
                        <td className="px-3 py-2">{row.employee_name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.saveable_days}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.untaken_below_floor_days}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.expiring_days}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.next_year_entitled}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="text-sm space-y-1">
                <p className="tabular-nums">
                  {t('vacation_close_computed', {
                    amount: formatCurrency(report.sek.computed_liability),
                  })}
                </p>
                <p className="tabular-nums">
                  {t('vacation_close_booked', { amount: formatCurrency(report.sek.booked_2920) })}
                </p>
                <p className="tabular-nums">
                  {report.sek.adjustment_needed
                    ? t('vacation_close_drift', { amount: formatCurrency(report.sek.drift_2920) })
                    : t('vacation_close_no_drift')}
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={closing}>
              {t('vacation_close_cancel')}
            </Button>
            <Button onClick={confirmClose} disabled={!report || closing}>
              {closing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('vacation_close_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
