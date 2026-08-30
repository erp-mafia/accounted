'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowLeftCircle,
  Download,
  Eye,
  FileDown,
  Loader2,
  MoreHorizontal,
  Send,
  Trash2,
  Undo2,
} from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { periodLabelOf, type RunDetail } from './types'

// Same chip vocabulary as the Löner list (chips mark exceptions): in-flight
// states wear the quiet beige chip, paid is sage, corrected the outline
// exception, and booked renders as muted text.
const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'> = {
  draft: 'secondary',
  review: 'secondary',
  approved: 'secondary',
  paid: 'success',
  booked: 'success',
  corrected: 'outline',
}

const STATUS_RANK: Record<string, number> = {
  draft: 0,
  review: 1,
  approved: 2,
  paid: 3,
  booked: 4,
  corrected: 4,
}

interface RunHeaderProps {
  run: RunDetail
  canWrite: boolean
  actionLoading: string | null
  employeeCount: number
  isCalculated: boolean
  // The single "forward" step for the current status (Beräkna, Till
  // granskning, Godkänn, Markera utbetald, Bokför): the one default button
  // in the header. Everything else lives behind the ⋯ menu, except the
  // payslip send, which is a rail step of its own and stays visible.
  primaryAction?: { key: string; label: string; onClick: () => void } | null
  onPreview: () => void
  onRevert: () => void
  onUnapprove: () => void
  onSendPayslips: () => void
  onDownloadPayslips: () => void
  onDownloadAgi: () => void
  onDelete: () => void
  onCorrect: () => void
  // Draft-only: payment_date is frozen once the run leaves draft (it becomes
  // the booking entry date), so the header only offers the editor there.
  // Resolves false when the save failed, so the input can snap back.
  onUpdatePaymentDate: (date: string) => Promise<boolean>
}

export function RunHeader({
  run,
  canWrite,
  actionLoading,
  employeeCount,
  isCalculated,
  primaryAction,
  onPreview,
  onRevert,
  onUnapprove,
  onSendPayslips,
  onDownloadPayslips,
  onDownloadAgi,
  onDelete,
  onCorrect,
  onUpdatePaymentDate,
}: RunHeaderProps) {
  const t = useTranslations('salary_run')
  const tSalary = useTranslations('salary')
  const [correctOpen, setCorrectOpen] = useState(false)
  const periodLabel = periodLabelOf(run)
  const hasEmailSend = useCapability(CAPABILITY.email_send)

  const statusKey = `status_${run.status}`
  const rank = STATUS_RANK[run.status] ?? 0
  const busy = !!actionLoading
  const deliveries = run.payslip_deliveries_summary

  // Payslips are a parallel obligation from `approved` onwards. Email send is
  // a paid capability (server 403s without it); the PDF download alternative
  // in the menu stays free.
  const payslipsAvailable = rank >= 2
  const showPayslipSend = payslipsAvailable && canWrite

  const showPreview = canWrite && (run.status === 'draft' || run.status === 'review')
  const showRevert = canWrite && run.status === 'review'
  const showUnapprove = canWrite && run.status === 'approved'
  const showDownloadPayslips = payslipsAvailable && canWrite
  const showDownloadAgi = canWrite && run.status === 'booked'
  const showDelete = canWrite && run.status === 'draft'
  const showCorrect = canWrite && run.status === 'booked'
  const hasMenu =
    showPreview ||
    showRevert ||
    showUnapprove ||
    showDownloadPayslips ||
    showDownloadAgi ||
    showDelete ||
    showCorrect
  const menuBusy =
    actionLoading === 'delete' ||
    actionLoading === 'correct' ||
    actionLoading === 'preview' ||
    actionLoading === 'bulk_payslip' ||
    actionLoading === 'agi-download'

  // Editable while draft: prefilled with the effective value, committed on
  // blur/Enter so half-typed dates never fire a PATCH. The draft state resyncs
  // whenever the server value changes (save reconcile, status transitions),
  // via the adjust-state-during-render pattern rather than an effect.
  const paymentDateEditable = canWrite && run.status === 'draft'
  const [paymentDateDraft, setPaymentDateDraft] = useState(run.payment_date)
  const [lastServerPaymentDate, setLastServerPaymentDate] = useState(run.payment_date)
  if (run.payment_date !== lastServerPaymentDate) {
    setLastServerPaymentDate(run.payment_date)
    setPaymentDateDraft(run.payment_date)
  }

  async function commitPaymentDate() {
    if (!paymentDateDraft || paymentDateDraft === run.payment_date) {
      // Empty or unchanged: snap back to the server value instead of saving.
      setPaymentDateDraft(run.payment_date)
      return
    }
    const saved = await onUpdatePaymentDate(paymentDateDraft)
    if (!saved) setPaymentDateDraft(run.payment_date)
  }

  // The payment date must stay within the run's period month: the AGI is
  // declared per payment month (kontantprincipen), so the API refuses dates
  // outside it. min/max keeps the native picker inside the month; typed
  // values outside it still get the server's 400 toast.
  const periodMonthPrefix = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  const periodMonthLastDay = new Date(run.period_year, run.period_month, 0).getDate()

  const metaParts: React.ReactNode[] = [
    <span key="payment" className="inline-flex items-center gap-2">
      {t('payment_date_label')}{' '}
      {paymentDateEditable ? (
        <Input
          type="date"
          value={paymentDateDraft}
          min={`${periodMonthPrefix}-01`}
          max={`${periodMonthPrefix}-${String(periodMonthLastDay).padStart(2, '0')}`}
          onChange={(e) => setPaymentDateDraft(e.target.value)}
          onBlur={commitPaymentDate}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          disabled={busy}
          aria-label={t('payment_date_edit_aria')}
          className="h-8 w-fit px-2 py-0 text-sm tabular-nums"
        />
      ) : (
        <span className="tabular-nums">{formatDate(run.payment_date)}</span>
      )}
    </span>,
    <span key="count">{t('header_employees', { count: employeeCount })}</span>,
  ]
  if (run.is_correction && run.corrects_run_id) {
    metaParts.push(
      <Link
        key="corrects"
        href={`/salary/runs/${run.corrects_run_id}`}
        className="underline underline-offset-2 hover:text-foreground"
      >
        {t('corrects_link', { period: periodLabel })}
      </Link>,
    )
  }
  if (run.status === 'corrected' && run.corrected_by_run_id) {
    metaParts.push(
      <Link
        key="corrected-by"
        href={`/salary/runs/${run.corrected_by_run_id}`}
        className="underline underline-offset-2 hover:text-foreground"
      >
        {t('corrected_by_link')}
      </Link>,
    )
  }

  return (
    <>
      {/* Back link on its own quiet row, so the title below keeps a stable
          position across runs. */}
      <div>
        <Link
          href="/salary"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back_to_salary')}
        </Link>
      </div>

      {/* Header: serif title with one status element, a quiet meta line, and
          the next step on the right. Everything else lives in the ⋯ menu. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-2xl leading-8 tracking-tight">
              {t('title', { period: periodLabel })}
            </h1>
            {run.status === 'booked' ? (
              <span className="text-sm text-muted-foreground">{tSalary(statusKey)}</span>
            ) : (
              <Badge variant={STATUS_VARIANTS[run.status] || 'secondary'}>
                {tSalary(statusKey)}
              </Badge>
            )}
            {run.is_correction && run.corrects_run_id && (
              <Badge variant="outline">{t('correction_badge')}</Badge>
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            {metaParts.map((part, i) => (
              <span key={i} className="inline-flex items-center gap-x-2">
                {i > 0 && <span aria-hidden>·</span>}
                {part}
              </span>
            ))}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {showPayslipSend && (
            // The span carries the tooltip: browsers suppress `title` on
            // disabled elements, and hover events don't fire on them.
            <span title={!hasEmailSend ? t('payslips_send_requires_subscription') : undefined}>
              <Button
                variant="outline"
                onClick={onSendPayslips}
                disabled={busy || !hasEmailSend}
              >
                {actionLoading === 'payslips-send' ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                {deliveries && deliveries.sent > 0
                  ? t('action_send_payslips_again')
                  : t('action_send_payslips')}
              </Button>
            </span>
          )}

          {primaryAction && (
            <Button onClick={primaryAction.onClick} disabled={busy}>
              {actionLoading === primaryAction.key && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {primaryAction.label}
            </Button>
          )}

          {hasMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('more_actions')}>
                  {menuBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <MoreHorizontal className="h-4 w-4" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[240px]">
                {showPreview && (
                  <DropdownMenuItem
                    onSelect={onPreview}
                    disabled={busy || (run.status === 'draft' && !isCalculated)}
                  >
                    <Eye className="h-4 w-4" />
                    {t('action_preview')}
                  </DropdownMenuItem>
                )}
                {showDownloadPayslips && (
                  <DropdownMenuItem onSelect={onDownloadPayslips} disabled={busy}>
                    <FileDown className="h-4 w-4" />
                    {t('action_download_payslips')}
                  </DropdownMenuItem>
                )}
                {showDownloadAgi && (
                  <DropdownMenuItem onSelect={onDownloadAgi} disabled={busy}>
                    <Download className="h-4 w-4" />
                    {t('action_download_agi')}
                  </DropdownMenuItem>
                )}
                {(showRevert || showUnapprove) && (
                  <>
                    <DropdownMenuSeparator />
                    {showRevert && (
                      <DropdownMenuItem onSelect={onRevert} disabled={busy}>
                        <ArrowLeftCircle className="h-4 w-4" />
                        {t('action_revert')}
                      </DropdownMenuItem>
                    )}
                    {/* Approval is an internal control point, not a legal
                        event: the run can be unlocked again as long as nothing
                        has been paid, booked, or filed. The API refuses once
                        the AGI has reached Skatteverket. */}
                    {showUnapprove && (
                      <DropdownMenuItem onSelect={onUnapprove} disabled={busy}>
                        <ArrowLeftCircle className="h-4 w-4" />
                        {t('action_unapprove')}
                      </DropdownMenuItem>
                    )}
                  </>
                )}
                {(showDelete || showCorrect) && (
                  <>
                    <DropdownMenuSeparator />
                    {showDelete && (
                      <DropdownMenuItem
                        onSelect={onDelete}
                        disabled={busy}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                        {t('action_delete_draft')}
                      </DropdownMenuItem>
                    )}
                    {showCorrect && (
                      <DropdownMenuItem onSelect={() => setCorrectOpen(true)} disabled={busy}>
                        <Undo2 className="h-4 w-4" />
                        {t('action_correct')}
                      </DropdownMenuItem>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Correction confirm: storno per BFL 5 kap. 5 §, nothing is deleted. */}
      <Dialog open={correctOpen} onOpenChange={setCorrectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('correct_dialog_title')}</DialogTitle>
            <DialogDescription className="space-y-3 pt-2 text-left">
              <span className="block">{t('correct_dialog_body', { period: periodLabel })}</span>
              {run.agi_generated_at && (
                <span className="flex items-start gap-2 rounded-lg border border-border p-3 text-xs">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>{t('correct_dialog_agi_warning')}</span>
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCorrectOpen(false)}>
              {t('correct_dialog_cancel')}
            </Button>
            <Button
              onClick={() => {
                setCorrectOpen(false)
                onCorrect()
              }}
            >
              {t('correct_dialog_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
