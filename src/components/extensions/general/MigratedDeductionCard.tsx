'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { AttnLine } from '@/components/ui/attn-line'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { QUIET_LINK_CLASS, VTD_CLASS, VTH_CLASS } from '@/components/ui/dry-table'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage, getResponseErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import { cn, formatCurrency, formatDate, formatRowAmount } from '@/lib/utils'
import {
  MIGRATED_DEDUCTION_ROUTE,
  useMigratedDeductionStatus,
  type DeductionBackfillInvoice,
  type DeductionBackfillMode,
  type DeductionBackfillReport,
  type DeductionBackfillReviewReason,
  type DeductionBackfillSkipReason,
} from './use-migrated-deduction'

/** The buckets that book a voucher on apply. */
const APPLY_BUCKETS = ['apply_unpaid', 'apply_partially_paid', 'apply_paid'] as const
/** The plan table, one line each; double requests are the attn line instead. */
const TABLE_BUCKETS = [...APPLY_BUCKETS, 'status_only', 'review'] as const
const SKIP_REASONS: DeductionBackfillSkipReason[] = [
  'no_deduction',
  'requested_at_provider',
  'rejected_at_provider',
  'already_applied',
  'not_open',
]
/** Invoice numbers shown per group before the rest folds behind "Visa N till". */
const VISIBLE_PER_GROUP = 12

/** Failure codes the runner and the apply RPC report, as one short label each. */
const FAILURE_LABEL_KEY: Record<string, string> = {
  FETCH_FAILED: 'failure_fetch',
  ACCOUNTS_UNAVAILABLE: 'failure_accounts',
  PERIOD_LOCKED: 'failure_period_locked',
  DRIFT: 'failure_drift',
  HELD_BY_REQUEST: 'failure_held_by_request',
  ALREADY_HAS_DEDUCTION: 'failure_already_has_deduction',
  STATUS_NOT_REPAIRABLE: 'failure_status',
}

function failureLabelKey(code: string): string {
  return FAILURE_LABEL_KEY[code] ?? (code.startsWith('WRITE_FAILED') ? 'failure_write' : 'failure_other')
}

/** Groups in first-seen order, so the list keeps the runner's invoice order. */
function groupBy<T>(items: T[], keyOf: (item: T) => string): Array<{ key: string; items: T[] }> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return [...groups.entries()].map(([key, grouped]) => ({ key, items: grouped }))
}

/**
 * The post-migration step for companies that moved from Visma (crm#1144):
 * invoices issued with a ROT, RUT or grön teknik deduction arrived without it.
 * Preview plans every invoice against Visma and writes nothing; apply books
 * one reclassification voucher per invoice after a confirm that states the
 * outcome (convention 10). A run that stops early is continued by running it
 * again: the server skips what is already done.
 */
export default function MigratedDeductionCard({ className }: { className?: string }) {
  const t = useTranslations('migrated_deduction')
  const locale: ErrorLocale = useLocale() === 'en' ? 'en' : 'sv'
  const { canWrite } = useCanWrite()
  const status = useMigratedDeductionStatus()
  const [running, setRunning] = useState<DeductionBackfillMode | null>(null)
  const [report, setReport] = useState<DeductionBackfillReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  if (!status?.applicable) return null

  async function run(mode: DeductionBackfillMode) {
    if (!canWrite || running) return
    setRunning(mode)
    setError(null)
    try {
      const response = await fetch(MIGRATED_DEDUCTION_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      if (!response.ok) {
        setError(await getResponseErrorMessage(response, undefined, locale))
        return
      }
      setReport(((await response.json()) as { data: DeductionBackfillReport }).data)
    } catch (failure) {
      setError(getErrorMessage(failure, { locale }))
    } finally {
      setRunning(null)
    }
  }

  // The confirm states what the preview found; apply plans again from fresh
  // Visma data, so a partial preview is never the basis for it.
  const preview = report?.mode === 'preview' && report.complete ? report : null
  const voucherCount = preview ? APPLY_BUCKETS.reduce((sum, bucket) => sum + preview.buckets[bucket].count, 0) : 0
  const voucherTotal = preview
    ? roundOre(APPLY_BUCKETS.reduce((sum, bucket) => sum + preview.buckets[bucket].amount, 0))
    : 0
  const statusCount = preview?.buckets.status_only.count ?? 0
  const canApply = voucherCount + statusCount > 0
  const canContinue = report?.mode === 'apply' && !report.complete
  const blocked = running !== null || status.importRunning

  return (
    <Card className={cn('space-y-4 p-6', className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">{t('title')}</h2>
            <HelpPopover>
              <div className="space-y-2">
                <p>{t('help_preview')}</p>
                <p>{t('help_apply')}</p>
                <p>{t('help_left_alone')}</p>
              </div>
            </HelpPopover>
          </div>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t('description')}</p>
        </div>
        {canWrite && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              variant={report ? 'outline' : 'default'}
              loading={running === 'preview'}
              disabled={blocked}
              onClick={() => void run('preview')}
            >
              {t('preview')}
            </Button>
            {canApply && (
              <Button loading={running === 'apply'} disabled={blocked} onClick={() => setConfirmOpen(true)}>
                {t('apply')}
              </Button>
            )}
            {canContinue && (
              <Button loading={running === 'apply'} disabled={blocked} onClick={() => void run('apply')}>
                {t('continue')}
              </Button>
            )}
          </div>
        )}
      </div>

      {status.importRunning && <p className="text-xs text-muted-foreground">{t('import_running')}</p>}
      {running && (
        <p className="text-xs text-muted-foreground" role="status">
          {t(running === 'preview' ? 'running_preview' : 'running_apply')}
        </p>
      )}
      {error && (
        <p className="text-[13px] text-destructive" role="alert">
          {error}
        </p>
      )}
      {report && (
        <div className="animate-fade-in space-y-4" aria-live="polite">
          {report.mode === 'preview' ? <PreviewResult report={report} /> : <ApplyResult report={report} />}
          <Failures report={report} />
          <ReviewGroups report={report} />
          <SkippedLine report={report} />
          {!report.complete && (
            <p className="text-xs text-muted-foreground">
              {t(`stop_${report.stopReason ?? 'deadline'}`)}{' '}
              {t('progress', { processed: report.processed, candidates: report.candidates })}
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('confirm_title')}
        description={[
          t('confirm_vouchers', {
            count: voucherCount,
            date: formatDate(todayIsoStockholm()),
            amount: formatCurrency(voucherTotal),
          }),
          statusCount > 0 ? t('confirm_status', { count: statusCount }) : null,
          t('confirm_recheck'),
        ]
          .filter(Boolean)
          .join(' ')}
        confirmLabel={t('apply')}
        // Closes at once: the run takes a minute or more and reports on the card.
        onConfirm={() => {
          void run('apply')
        }}
      />
    </Card>
  )
}

function PreviewResult({ report }: { report: DeductionBackfillReport }) {
  const t = useTranslations('migrated_deduction')
  const doubles = report.buckets.double_request
  const empty =
    TABLE_BUCKETS.every((bucket) => report.buckets[bucket].count === 0) &&
    doubles.count === 0 &&
    report.failures.length === 0
  if (empty) return <p className="text-[13px] text-muted-foreground">{t('preview_nothing')}</p>
  return (
    <div className="space-y-3">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={VTH_CLASS}>{t('col_outcome')}</th>
            <th className={cn(VTH_CLASS, 'text-right')}>{t('col_invoices')}</th>
            <th className={cn(VTH_CLASS, 'pr-0 text-right')}>{t('col_deduction')}</th>
          </tr>
        </thead>
        <tbody>
          {TABLE_BUCKETS.map((bucket) => {
            const { count, amount } = report.buckets[bucket]
            return (
              <tr key={bucket} className={cn(count === 0 && 'text-muted-foreground')}>
                <td className={VTD_CLASS}>{t(`bucket_${bucket}`)}</td>
                <td className={cn(VTD_CLASS, 'text-right tabular-nums')}>{count}</td>
                {/* A status repair moves no deduction: no amount to show. */}
                <td className={cn(VTD_CLASS, 'pr-0 text-right tabular-nums')}>
                  {bucket === 'status_only' ? null : formatRowAmount(amount)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {doubles.count > 0 && (
        <AttnLine>{t('double_request', { count: doubles.count, amount: formatCurrency(doubles.amount) })}</AttnLine>
      )}
    </div>
  )
}

function ApplyResult({ report }: { report: DeductionBackfillReport }) {
  const t = useTranslations('migrated_deduction')
  const { applied } = report
  return (
    <div className="space-y-1 text-[13px]">
      {applied.invoices > 0 && (
        <p className="tabular-nums">{t('result_booked', { count: applied.invoices, amount: formatCurrency(applied.amount) })}</p>
      )}
      {applied.statusRepaired > 0 && <p className="tabular-nums">{t('result_status', { count: applied.statusRepaired })}</p>}
      {applied.invoices === 0 && applied.statusRepaired === 0 && report.failures.length === 0 && (
        <p className="text-muted-foreground">{t('result_nothing')}</p>
      )}
      {applied.invoices > 0 && (
        <p>
          <Link href="/invoices/rot-rut" className={QUIET_LINK_CLASS}>
            {t('result_rot_rut_link')}
          </Link>
        </p>
      )}
    </div>
  )
}

/** What the run could not do, by cause: a fetch in preview, a write in apply. */
function Failures({ report }: { report: DeductionBackfillReport }) {
  const t = useTranslations('migrated_deduction')
  if (report.failures.length === 0) return null
  const groups = groupBy(report.failures, (failure) => failureLabelKey(failure.code))
  return (
    <div className="space-y-1 text-[13px]">
      <p className="text-destructive">{t('result_failures', { count: report.failures.length })}</p>
      {groups.map((group) => (
        <div key={group.key} className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-xs">{t(group.key)}:</span>
          <InvoiceNumbers invoices={group.items} />
        </div>
      ))}
    </div>
  )
}

/**
 * The invoices left for a person, by reason. Past the request deadline is its
 * own group: those deductions can no longer be requested at all.
 */
function ReviewGroups({ report }: { report: DeductionBackfillReport }) {
  const t = useTranslations('migrated_deduction')
  const late = report.review.filter((invoice) => invoice.reason === 'past_deadline')
  const reasons = groupBy(
    report.review.filter((invoice) => invoice.reason !== 'past_deadline'),
    (invoice) => invoice.reason,
  )
  if (late.length === 0 && reasons.length === 0 && report.doubleRequests.length === 0) return null
  return (
    <div className="space-y-4">
      {reasons.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t('bucket_review')}
          </h3>
          {reasons.map((group) => (
            <div key={group.key}>
              <p className="text-[13px]">{t(`reason_${group.key as DeductionBackfillReviewReason}`)}</p>
              <InvoiceNumbers invoices={group.items} />
            </div>
          ))}
        </section>
      )}
      {late.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t('late_title')}
          </h3>
          <p className="text-[13px]">{t('late_note')}</p>
          <InvoiceNumbers invoices={late} />
        </section>
      )}
      {report.doubleRequests.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t('bucket_double_request')}
          </h3>
          <InvoiceNumbers invoices={report.doubleRequests} />
        </section>
      )}
    </div>
  )
}

function SkippedLine({ report }: { report: DeductionBackfillReport }) {
  const t = useTranslations('migrated_deduction')
  const parts = SKIP_REASONS.filter((reason) => (report.skipped[reason] ?? 0) > 0).map((reason) =>
    t(`skipped_${reason}`, { count: report.skipped[reason] ?? 0 }),
  )
  if (parts.length === 0) return null
  return (
    <p className="text-xs tabular-nums text-muted-foreground">
      {t('skipped', { parts: parts.join(', ') })}
    </p>
  )
}

/** Invoice numbers as links (new tab, so the result stays), long lists folded. */
function InvoiceNumbers({ invoices }: { invoices: DeductionBackfillInvoice[] }) {
  const t = useTranslations('migrated_deduction')
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? invoices : invoices.slice(0, VISIBLE_PER_GROUP)
  const hidden = invoices.length - shown.length
  return (
    <p className="text-xs leading-6 tabular-nums text-muted-foreground">
      {shown.map((invoice, index) => (
        <span key={invoice.invoiceId}>
          {index > 0 && ', '}
          <Link href={`/invoices/${invoice.invoiceId}`} target="_blank" rel="noopener" className={QUIET_LINK_CLASS}>
            {invoice.invoiceNumber ?? t('invoice_unnumbered')}
          </Link>
        </span>
      ))}
      {hidden > 0 && (
        <>
          {' '}
          <Button
            variant="link"
            className="h-auto p-0 text-xs text-muted-foreground"
            onClick={() => setExpanded(true)}
          >
            {t('more', { count: hidden })}
          </Button>
        </>
      )}
    </p>
  )
}
