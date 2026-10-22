'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useToast } from '@/components/ui/use-toast'
import { downloadFile } from '@/lib/browser/download-file'
import { failureDescription } from '@/lib/browser/action-failure'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { formatCurrency } from '@/lib/utils'

// The shapes GET /api/salary/fora answers (lib/salary/fora/monthly-report.ts).
interface ForaWarning {
  code: string
  message: string
  employee_name?: string
  fok_start_date?: string
  pay_amount?: number
  run_period?: string
  payment_date?: string
}

interface ForaIssue {
  code: string
  message: string
  employee_name?: string
}

interface ForaReportSummary {
  filename: string
  payrolls: Array<{ employee_id: string; employee_name: string; fok_id: string; pay_amount: number; employment_end: string | null }>
  total_pay_amount: number
  warnings: ForaWarning[]
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; report: ForaReportSummary }
  | { kind: 'incomplete'; issues: ForaIssue[] }
  | { kind: 'failed'; message: string }

/**
 * Mounted only while open (the run page renders it conditionally), so every
 * opening starts from a fresh load of the month.
 */
interface ForaReportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The payment month (the run's payment_date), which is the month Fora reports. */
  year: number
  month: number
}

/** Fora wants the month by the last day of the month after the payment month. */
function reportingDeadline(year: number, month: number): string {
  const lastDay = new Date(Date.UTC(year, month + 1, 0))
  return lastDay.toISOString().slice(0, 10)
}

const KNOWN_WARNINGS = new Set([
  'FORA_PAID_BEFORE_CODE_START',
  'FORA_NEGATIVE_PAY',
  'FORA_RUN_NOT_APPROVED',
  'FORA_ARBETARE_WITHOUT_CODE',
])
const KNOWN_ISSUES = new Set([
  'FORA_ORG_NUMBER_MISSING',
  'FORA_ADDRESS_REQUIRED',
  'FORA_NO_CODED_EMPLOYEES',
  'FORA_NOTHING_IN_MONTH',
])

export function ForaReportDialog({ open, onOpenChange, year, month }: ForaReportDialogProps) {
  const t = useTranslations('fora_report')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [downloading, setDownloading] = useState(false)
  const period = `${year}-${String(month).padStart(2, '0')}`

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch(`/api/salary/fora?year=${year}&month=${month}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null)
        if (cancelled) return
        if (res.ok) {
          setState({ kind: 'ready', report: body.data as ForaReportSummary })
        } else if (body?.error?.code === 'FORA_REPORT_INCOMPLETE' && Array.isArray(body.error.details?.issues)) {
          setState({ kind: 'incomplete', issues: body.error.details.issues as ForaIssue[] })
        } else {
          setState({ kind: 'failed', message: getErrorMessage(body, { statusCode: res.status, locale, context: 'salary' }) })
        }
      })
      .catch((err) => {
        if (!cancelled) setState({ kind: 'failed', message: getErrorMessage(err, { locale }) })
      })
    return () => {
      cancelled = true
    }
  }, [open, year, month, locale])

  function warningText(w: ForaWarning): string {
    if (!KNOWN_WARNINGS.has(w.code)) return w.message
    return t(`warning_${w.code}`, {
      name: w.employee_name ?? '',
      date: w.fok_start_date ?? '',
      amount: formatCurrency(w.pay_amount ?? 0),
      period: w.run_period ?? '',
      paymentDate: w.payment_date ?? '',
    })
  }

  function issueText(issue: ForaIssue): string {
    if (!KNOWN_ISSUES.has(issue.code)) return issue.message
    return t(`issue_${issue.code}`, { name: issue.employee_name ?? '' })
  }

  async function handleDownload() {
    if (state.kind !== 'ready') return
    setDownloading(true)
    try {
      const result = await downloadFile({
        url: `/api/salary/fora?year=${year}&month=${month}&download=1`,
        filename: state.report.filename,
        locale,
        errorContext: 'salary',
      })
      if (!result.ok) {
        toast({
          title: t('toast_failed'),
          description: failureDescription(result, {
            timeout: tCommon('download_timeout'),
            network: tCommon('download_network'),
          }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('toast_downloaded') })
      onOpenChange(false)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title', { period })}</DialogTitle>
          <DialogDescription>{t('description', { deadline: reportingDeadline(year, month) })}</DialogDescription>
        </DialogHeader>

        {state.kind === 'loading' && (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-4 w-full rounded-sm" />
            <Skeleton className="h-4 w-full rounded-sm" />
            <Skeleton className="h-4 w-2/3 rounded-sm" />
          </div>
        )}

        {state.kind === 'failed' && <p className="text-sm text-destructive">{state.message}</p>}

        {state.kind === 'incomplete' && (
          <div className="space-y-2">
            <p className="text-sm">{t('incomplete_intro')}</p>
            <ul className="space-y-2">
              {state.issues.map((issue, i) => (
                <li key={`${issue.code}-${i}`} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{issueText(issue)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {state.kind === 'ready' && (
          <div className="space-y-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('column_employee')}</TableHead>
                  <TableHead>{t('column_code')}</TableHead>
                  <TableHead className="text-right">{t('column_pay')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.report.payrolls.map((p) => (
                  <TableRow key={p.employee_id}>
                    <TableCell>
                      {p.employee_name}
                      {p.employment_end && (
                        <span className="ml-2 text-xs text-muted-foreground">{t('ends', { date: p.employment_end })}</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">{p.fok_id}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(p.pay_amount)}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell className="font-medium" colSpan={2}>
                    {t('total')}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatCurrency(state.report.total_pay_amount)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
            {state.report.warnings.length > 0 && (
              <ul className="space-y-2">
                {state.report.warnings.map((w, i) => (
                  <li key={`${w.code}-${i}`} className="flex items-start gap-2 rounded-lg border border-border p-3 text-xs">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{warningText(w)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('close')}
          </Button>
          <Button onClick={handleDownload} disabled={state.kind !== 'ready'} loading={downloading}>
            {t('download')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
