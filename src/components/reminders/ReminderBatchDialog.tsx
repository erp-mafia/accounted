'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { ExclamationTriangleIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toggleUnticked } from '@/lib/collections/batch-dialog'
import type { ReminderBatchCommitResult, ReminderBatchItem } from '@/lib/reminders/batch'
import {
  REMINDER_EXCLUDED_REASON_KEY,
  bankWarnings,
  parseReminderBatchResult,
  reminderBatchCanSend,
  reminderLevelKey,
  reminderRemovalIds,
  reminderSkipLines,
  sortReminderExcluded,
  sortReminderItems,
  tickedReminderItems,
  tickedReminderTotals,
  type ReminderBatchView,
} from '@/lib/reminders/batch-dialog'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { AutomaticRemindersControl } from './AutomaticRemindersControl'
import { cn, formatCurrency, formatDate } from '@/lib/utils'

/**
 * The daily reminder batch (accounted#104, phase 2): the overdue invoices
 * whose reminder is due today, with the ones left out and why. An owner or
 * administrator unticks what should not go and approves; nothing reaches a
 * customer before that. Unticked invoices are taken out of the batch
 * (removal only) right before the approval, and the send decides every
 * remaining invoice again against the books and the bank, then says which
 * it skipped and why. No typed confirmation word: a reminder is lighter
 * than an inkasso step.
 *
 * Mount it per batch (key it by the operation id) while it is open: it reads
 * the batch when it mounts and starts with everything ticked.
 */
interface Props {
  /** The pending reminder_daily_batch operation. */
  operationId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** After the approval ran (whatever it sent): refresh what lists the batch. */
  onCommitted?: () => void
}

type Answer<T> = { ok: true; json: T } | { ok: false; message: string }

/** One call to the batch's routes; a refusal reads as the structured message the API answered, in the person's language. */
async function callBatch<T>(
  operationId: string,
  route: 'items' | 'commit',
  method: 'GET' | 'PATCH' | 'POST',
  locale: 'sv' | 'en',
  body?: unknown,
): Promise<Answer<T>> {
  const init: RequestInit = { method, cache: 'no-store' }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  try {
    const res = await fetch(`/api/pending-operations/${encodeURIComponent(operationId)}/${route}`, init)
    const json: unknown = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, message: getErrorMessage(json, { statusCode: res.status, locale }) }
    return { ok: true, json: json as T }
  } catch (error) {
    return { ok: false, message: getErrorMessage(error, { locale }) }
  }
}

const HEAD = 'h-8 px-2'
const CELL = 'px-2 py-2 align-top text-[13px]'
const LABEL = 'text-[11px] font-medium uppercase tracking-wider text-muted-foreground'

/** One invoice under the table (left out today, or skipped at the send): its number, the customer, and why. */
function InvoiceWithReason({ invoiceId, number, customer, reason }: { invoiceId: string; number: string; customer: string | null; reason: string }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-4 py-2">
      <span className="min-w-0 truncate">
        <Link
          href={`/invoices/${encodeURIComponent(invoiceId)}`}
          className="tabular-nums underline decoration-border underline-offset-4 transition-colors duration-150 hover:decoration-foreground"
        >
          {number}
        </Link>
        {customer && <span className="text-muted-foreground"> {customer}</span>}
      </span>
      <span className="text-muted-foreground">{reason}</span>
    </li>
  )
}

export function ReminderBatchDialog({ operationId, open, onOpenChange, onCommitted }: Props) {
  const t = useTranslations('reminders')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const [view, setView] = useState<ReminderBatchView | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [unticked, setUnticked] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ outcome: ReminderBatchCommitResult; shown: ReminderBatchItem[] } | null>(null)

  /** The batch as it stands now. */
  const readView = useCallback(() => callBatch<{ data: ReminderBatchView }>(operationId, 'items', 'GET', locale), [operationId, locale])

  const showView = useCallback((answer: Answer<{ data: ReminderBatchView }>) => {
    if (answer.ok) setView(answer.json.data)
    setLoadFailed(!answer.ok)
    setLoading(false)
  }, [])

  useEffect(() => {
    let live = true
    void readView().then((answer) => {
      if (live) showView(answer)
    })
    return () => {
      live = false
    }
  }, [readView, showView])

  function retry() {
    setLoading(true)
    setLoadFailed(false)
    void readView().then(showView)
  }

  const items = useMemo(() => sortReminderItems(view?.items ?? []), [view])
  const warnings = useMemo(() => bankWarnings(items), [items])
  const ticked = tickedReminderItems(items, unticked)
  const pending = view?.status === 'pending'
  const canSend = !!view && !sending && reminderBatchCanSend({ status: view.status, ticked: ticked.length })
  const totals = tickedReminderTotals(items, unticked)
    .map((total) => formatCurrency(total.amount, total.currency))
    .join(' + ')

  async function send() {
    if (!view) return
    setSending(true)
    setError(null)
    const shown = ticked
    const removals = reminderRemovalIds(items, unticked)
    if (removals.length > 0) {
      // Removal is final, so it goes only together with the approval.
      const narrowed = await callBatch<{ data: ReminderBatchView }>(operationId, 'items', 'PATCH', locale, { remove_invoice_ids: removals })
      if (!narrowed.ok) {
        setSending(false)
        setError(narrowed.message)
        return
      }
      setView(narrowed.json.data)
      setUnticked([])
    }
    const committed = await callBatch<unknown>(operationId, 'commit', 'POST', locale)
    setSending(false)
    if (!committed.ok) {
      // Approved elsewhere, withdrawn, reminders turned off since the morning: show where the batch stands now.
      setError(committed.message)
      void readView().then(showView)
      return
    }
    const outcome = parseReminderBatchResult(committed.json) ?? {
      batch_date: view.batch_date,
      sent: [],
      skipped: [],
      sent_count: 0,
      skipped_count: 0,
    }
    setResult({ outcome, shown })
    onCommitted?.()
  }

  // After the approval the title says what happened; before it, what the click sends.
  const title = result
    ? t('batch_result', { sent: result.outcome.sent_count, skipped: result.outcome.skipped_count }).trim()
    : t('batch_title', { count: ticked.length })

  return (
    <Dialog open={open} onOpenChange={(next) => !sending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="font-display text-lg tracking-tight">{title}</DialogTitle>
          {!result && pending && <DialogDescription>{t('batch_intro')}</DialogDescription>}
        </DialogHeader>

        {loading && !view && (
          <div className="space-y-2" role="status" aria-label={t('batch_loading')}>
            <Skeleton className="h-4 w-3/4 rounded-sm" />
            <Skeleton className="h-4 w-2/3 rounded-sm" />
            <Skeleton className="h-4 w-1/2 rounded-sm" />
          </div>
        )}
        {loadFailed && (
          <p className="text-[13px] text-muted-foreground">
            {t('batch_load_failed')}{' '}
            <Button type="button" variant="link" className="h-auto p-0" onClick={retry}>
              {t('batch_retry')}
            </Button>
          </p>
        )}

        {result && result.outcome.skipped.length > 0 && (
          <section>
            <h3 className={LABEL}>{t('batch_skip_heading')}</h3>
            <ul className="mt-2 divide-y divide-border border-y border-border text-[13px]" data-ph-mask="">
              {reminderSkipLines(result.outcome, result.shown).map((line) => (
                <InvoiceWithReason
                  key={line.invoice_id}
                  invoiceId={line.invoice_id}
                  number={line.invoice_number ?? t('batch_col_invoice')}
                  customer={line.customer_name}
                  reason={t(line.reasonKey)}
                />
              ))}
            </ul>
          </section>
        )}

        {/* Phase 4: after a clean approval, the offer to let the batch send itself. */}
        {result && <AutomaticRemindersControl offerOnly />}

        {!result && view && (
          <div className="space-y-6">
            {!pending && <p className="text-[13px] text-muted-foreground">{t('batch_not_pending')}</p>}
            {pending && items.length === 0 && <p className="text-[13px] text-muted-foreground">{t('batch_empty')}</p>}

            {items.length > 0 && (
              <section className="space-y-2">
                {warnings.allKey && (
                  <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                    <ExclamationTriangleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {t(warnings.allKey)}
                  </div>
                )}
                {/* Customer data throughout: names, invoice numbers, the addresses the reminders go to. */}
                <Table className="min-w-[44rem] border-y border-border" data-ph-mask="">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8 px-2" aria-hidden />
                      <TableHead className={HEAD}>{t('batch_col_customer')}</TableHead>
                      <TableHead className={HEAD}>{t('batch_col_invoice')}</TableHead>
                      <TableHead className={HEAD}>{t('batch_col_due')}</TableHead>
                      <TableHead className={HEAD}>{t('batch_col_level')}</TableHead>
                      <TableHead className={cn(HEAD, 'text-right')}>{t('batch_col_amount')}</TableHead>
                      <TableHead className={HEAD}>{t('batch_col_recipient')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => {
                      const isTicked = !unticked.includes(item.invoice_id)
                      const warningKey = warnings.rowKeys.get(item.invoice_id)
                      const rowClass = cn(!isTicked && 'text-muted-foreground')
                      return (
                        <Fragment key={item.invoice_id}>
                          <TableRow className={cn(rowClass, warningKey && 'border-b-0')}>
                            <TableCell className={cn(CELL, 'w-8')}>
                              <Checkbox
                                checked={isTicked}
                                disabled={!pending || sending}
                                onCheckedChange={() => setUnticked((current) => toggleUnticked(current, item.invoice_id))}
                                aria-label={t('batch_item_aria', { number: item.invoice_number ?? '' })}
                              />
                            </TableCell>
                            <TableCell className={cn(CELL, 'max-w-[12rem] truncate')}>{item.customer_name ?? ''}</TableCell>
                            <TableCell className={cn(CELL, 'tabular-nums')}>{item.invoice_number ?? ''}</TableCell>
                            <TableCell className={cn(CELL, 'tabular-nums')}>{formatDate(item.due_date)}</TableCell>
                            <TableCell className={CELL}>{t(reminderLevelKey(item.level))}</TableCell>
                            <TableCell className={cn(CELL, 'text-right tabular-nums')}>
                              {formatCurrency(item.remaining_amount, item.currency)}
                            </TableCell>
                            <TableCell className={cn(CELL, 'max-w-[14rem] truncate')}>{item.recipient}</TableCell>
                          </TableRow>
                          {/* The bank could not show this invoice is unpaid, and approving sends it anyway: say so on the row. */}
                          {warningKey && (
                            <TableRow className={rowClass}>
                              <TableCell className="px-2 pb-2 pt-0" aria-hidden />
                              <TableCell colSpan={6} className="px-2 pb-2 pt-0 text-[12.5px] text-muted-foreground">
                                <div className="flex items-center gap-2">
                                  <ExclamationTriangleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                                  {t(warningKey)}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      )
                    })}
                  </TableBody>
                </Table>
              </section>
            )}

            {view.removed_invoice_ids.length > 0 && (
              <p className="text-[12.5px] text-muted-foreground">{t('batch_removed_note', { count: view.removed_invoice_ids.length })}</p>
            )}

            {view.excluded.length > 0 && (
              <section>
                <h3 className={LABEL}>{t('batch_excluded_heading')}</h3>
                <ul className="mt-2 divide-y divide-border border-y border-border text-[13px]" data-ph-mask="">
                  {sortReminderExcluded(view.excluded).map((row) => (
                    <InvoiceWithReason
                      key={row.invoice_id}
                      invoiceId={row.invoice_id}
                      number={row.invoice_number ?? t('batch_col_invoice')}
                      customer={row.customer_name}
                      reason={t(REMINDER_EXCLUDED_REASON_KEY[row.reason])}
                    />
                  ))}
                </ul>
              </section>
            )}

            {pending && items.length > 0 && (
              <p className={cn('text-[13px] tabular-nums', ticked.length === 0 && 'text-attn')}>
                {ticked.length > 0 ? t('batch_total', { count: ticked.length, amount: totals }) : t('batch_none_ticked')}
              </p>
            )}
          </div>
        )}

        {error && <p className="text-[13px] text-destructive">{error}</p>}

        <DialogFooter>
          {result ? (
            <Button onClick={() => onOpenChange(false)}>{t('batch_close')}</Button>
          ) : (
            <>
              <Button variant="outline" disabled={sending} onClick={() => onOpenChange(false)}>
                {t('batch_cancel')}
              </Button>
              {pending && (
                <Button loading={sending} disabled={!canSend} onClick={() => void send()}>
                  {t('batch_confirm', { count: ticked.length })}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
