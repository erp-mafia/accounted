'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { BATCH_CONFIRMATION_WORD, type BatchCommitResult, type BatchItem } from '@/lib/collections/batch'
import {
  batchCanSend,
  batchItemKey,
  excludedLine,
  groupBatchItems,
  parseBatchResult,
  removalInvoiceIds,
  skipLines,
  sortExcluded,
  tickedItems,
  tickedTotal,
  toggleUnticked,
  type BatchView,
} from '@/lib/collections/batch-dialog'
import type { CollectionsAvailability } from '@/lib/collections/availability'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { useCaseWords } from './case-client'
import type { Locale } from './collections-client'

/**
 * The daily collections batch (build spec 3.6): the overdue invoices and
 * waiting case steps the morning's run proposes, per kind, with the ones
 * left out and why. An owner or administrator unticks what should not go,
 * types the confirmation word and approves; nothing reaches a customer
 * before that. Unticked items are taken out of the batch (removal only)
 * right before the approval, and the commit decides every remaining item
 * again (eligibility, a fresh bank check, the amount) and says which it
 * skipped and why.
 */

/**
 * Mount it per batch (key it by the operation id) while it is open: it reads
 * the batch when it mounts and starts with nothing unticked.
 */
interface Props {
  /** The pending collections_daily_batch operation. */
  operationId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** After the approval ran (whatever it sent): refresh the list behind the dialog. */
  onCommitted?: () => void
}

type Write<T> = { ok: true; data: T } | { ok: false; message: string }

async function request<T>(path: string, method: 'GET' | 'PATCH' | 'POST', body: unknown, locale: Locale): Promise<Write<T>> {
  try {
    const res = await fetch(path, {
      method,
      cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const json = (await res.json().catch(() => null)) as unknown
    if (res.ok) return { ok: true, data: json as T }
    return { ok: false, message: getErrorMessage(json, { statusCode: res.status, locale }) }
  } catch (error) {
    return { ok: false, message: getErrorMessage(error, { locale }) }
  }
}

const TH = 'px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground'
const TD = 'px-2 py-2 align-top text-[13px]'

export function HandoverBatchDialog({ operationId, open, onOpenChange, onCommitted }: Props) {
  const [availability, setAvailability] = useState<CollectionsAvailability | null>(null)
  const { tp, locale } = useCaseWords(availability?.displayName ?? null)
  const [view, setView] = useState<BatchView | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [unticked, setUnticked] = useState<string[]>([])
  const [typed, setTyped] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ outcome: BatchCommitResult; items: BatchItem[] } | null>(null)

  /** Read the batch as it stands now, and the provider's name. */
  const fetchBatch = useCallback(
    () =>
      Promise.all([
        request<{ data: BatchView }>(`/api/pending-operations/${encodeURIComponent(operationId)}/items`, 'GET', undefined, locale),
        request<{ data: CollectionsAvailability }>('/api/collections/availability', 'GET', undefined, locale),
      ]),
    [operationId, locale],
  )

  const apply = useCallback(([batch, avail]: Awaited<ReturnType<typeof fetchBatch>>) => {
    if (avail.ok) setAvailability(avail.data.data)
    if (batch.ok) setView(batch.data.data)
    setLoadFailed(!batch.ok)
    setLoading(false)
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchBatch().then((answers) => {
      if (!cancelled) apply(answers)
    })
    return () => {
      cancelled = true
    }
  }, [fetchBatch, apply])

  function load() {
    void fetchBatch().then(apply)
  }

  function retry() {
    setLoading(true)
    setLoadFailed(false)
    load()
  }

  const items = view?.items ?? []
  const ticked = tickedItems(items, unticked)
  const canSend = !!view && !sending && batchCanSend({ status: view.status, ticked: ticked.length, typed })

  async function send() {
    if (!view) return
    setSending(true)
    setError(null)
    const sentItems = ticked
    const removals = removalInvoiceIds(items, unticked)
    if (removals.length > 0) {
      const narrowed = await request<{ data: BatchView }>(
        `/api/pending-operations/${encodeURIComponent(operationId)}/items`,
        'PATCH',
        { remove_invoice_ids: removals },
        locale,
      )
      if (!narrowed.ok) {
        setSending(false)
        setError(narrowed.message)
        return
      }
      setView(narrowed.data.data)
      setUnticked([])
    }
    const committed = await request<unknown>(`/api/pending-operations/${encodeURIComponent(operationId)}/commit`, 'POST', undefined, locale)
    setSending(false)
    if (!committed.ok) {
      setError(committed.message)
      // The batch may have moved on (approved elsewhere, withdrawn): show where it stands now.
      load()
      return
    }
    const outcome = parseBatchResult(committed.data)
    setResult({
      outcome: outcome ?? { batch_date: view.batch_date, done: [], skipped: [], done_count: 0, skipped_count: 0 },
      items: sentItems,
    })
    onCommitted?.()
  }

  function stepLabel(item: BatchItem): string {
    if (item.kind === 'approve_step') {
      return item.decision_kind ? tp(`batch_step_${item.decision_kind}`) : ''
    }
    return item.start_step ? tp(`batch_step_${item.start_step}`) : ''
  }

  function feeLabel(item: BatchItem): string {
    if (item.reminder_fee_agreed === null) return ''
    return tp(item.reminder_fee_agreed ? 'batch_fee_yes' : 'batch_fee_no')
  }

  // After the approval the title says what happened; before it, what the click will send.
  const title = result
    ? tp('batch_result', { done: result.outcome.done_count, skipped: result.outcome.skipped_count }).trim()
    : tp('batch_title', { count: ticked.length })

  return (
    <Dialog open={open} onOpenChange={(next) => !sending && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-display text-lg tracking-tight">{title}</DialogTitle>
          {!result && view?.status === 'pending' && <DialogDescription>{tp('batch_intro')}</DialogDescription>}
          {availability?.sandbox && <DialogDescription>{tp('sandbox_note')}</DialogDescription>}
        </DialogHeader>

        {loading && !view && (
          <div className="space-y-2" aria-label={tp('batch_loading')}>
            <Skeleton className="h-4 w-2/3 rounded-sm" />
            <Skeleton className="h-4 w-1/2 rounded-sm" />
            <Skeleton className="h-4 w-3/4 rounded-sm" />
          </div>
        )}
        {loadFailed && (
          <p className="text-[13px] text-muted-foreground">
            {tp('batch_load_failed')}{' '}
            <button type="button" onClick={retry} className="text-foreground underline underline-offset-2">
              {tp('card_retry')}
            </button>
          </p>
        )}

        {result && (
          <div className="space-y-4">
            {result.outcome.skipped.length > 0 && (
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{tp('batch_skip_heading')}</p>
                <ul className="mt-2 divide-y divide-border border-y border-border" data-ph-mask="">
                  {skipLines(result.outcome, result.items).map((line) => (
                    <li key={line.invoice_id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-4 py-2 text-[13px]">
                      <span className="min-w-0 truncate">
                        <span className="tabular-nums">{line.invoice_number ?? ''}</span>
                        {line.customer_name && <span className="text-muted-foreground"> {line.customer_name}</span>}
                      </span>
                      <span>{tp(line.reasonKey)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {!result && view && (
          <div className="space-y-5">
            {view.status !== 'pending' && <p className="text-[13px] text-muted-foreground">{tp('batch_not_pending')}</p>}

            {groupBatchItems(items).map((group) => (
              <section key={group.kind}>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{tp(group.labelKey)}</p>
                <div className="mt-1.5 overflow-x-auto">
                  <table className="w-full min-w-[34rem] border-y border-border" data-ph-mask="">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="w-8 px-2 py-1.5" aria-hidden />
                        <th className={TH}>{tp('batch_col_invoice')}</th>
                        <th className={TH}>{tp('batch_col_customer')}</th>
                        <th className={TH}>{tp('batch_col_due')}</th>
                        <th className={cn(TH, 'text-right')}>{tp('batch_col_amount')}</th>
                        <th className={TH}>{tp('batch_col_start')}</th>
                        {group.kind !== 'approve_step' && <th className={TH}>{tp('batch_col_fee')}</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {group.items.map((item) => {
                        const key = batchItemKey(item)
                        const isTicked = !unticked.includes(key)
                        return (
                          <tr key={key} className={cn('transition-colors duration-150', !isTicked && 'text-muted-foreground')}>
                            <td className={cn(TD, 'w-8')}>
                              <Checkbox
                                checked={isTicked}
                                disabled={view.status !== 'pending' || sending}
                                onCheckedChange={() => setUnticked((u) => toggleUnticked(u, key))}
                                aria-label={tp('batch_item_aria', { number: item.invoice_number ?? '' })}
                              />
                            </td>
                            <td className={cn(TD, 'tabular-nums')}>{item.invoice_number ?? ''}</td>
                            <td className={cn(TD, 'max-w-[12rem] truncate')}>{item.customer_name ?? ''}</td>
                            <td className={cn(TD, 'tabular-nums')}>{formatDate(item.due_date)}</td>
                            <td className={cn(TD, 'text-right tabular-nums')}>{formatCurrency(item.remaining_amount)}</td>
                            <td className={TD}>{stepLabel(item)}</td>
                            {group.kind !== 'approve_step' && <td className={TD}>{feeLabel(item)}</td>}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}

            {view.removed.length > 0 && (
              <p className="text-[12.5px] text-muted-foreground">{tp('batch_removed_note', { count: view.removed.length })}</p>
            )}

            {view.excluded.length > 0 && (
              <section>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{tp('batch_excluded_heading')}</p>
                <ul className="mt-1.5 divide-y divide-border border-y border-border" data-ph-mask="">
                  {sortExcluded(view.excluded).map((row) => {
                    const line = excludedLine(row)
                    return (
                      <li
                        key={`${row.kind}:${row.invoice_id}`}
                        className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-4 py-2 text-[13px]"
                      >
                        <span className="min-w-0 truncate">
                          <span className="tabular-nums">{row.invoice_number ?? ''}</span>
                          {row.customer_name && <span className="text-muted-foreground"> {row.customer_name}</span>}
                        </span>
                        <span className="text-muted-foreground">{tp(line.detailKey ?? line.reasonKey)}</span>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}

            {view.status === 'pending' && (
              <div className="space-y-3">
                <p className="text-[13px] tabular-nums">
                  {tp('batch_total', { count: ticked.length, amount: formatCurrency(tickedTotal(items, unticked)) })}
                </p>
                {ticked.length === 0 && items.length > 0 && (
                  <p className="text-attn text-[12.5px]">{tp('batch_none_ticked')}</p>
                )}
                <label className="block space-y-1.5 text-[13px]">
                  <span>{tp('batch_confirm_label', { word: BATCH_CONFIRMATION_WORD })}</span>
                  <Input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={sending}
                    className="max-w-[16rem]"
                  />
                </label>
              </div>
            )}
          </div>
        )}

        {error && <p className="text-[13px] text-destructive">{error}</p>}

        <DialogFooter>
          {result ? (
            <Button onClick={() => onOpenChange(false)}>{tp('batch_close')}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
                {tp('send_cancel')}
              </Button>
              {view?.status === 'pending' && (
                <Button onClick={() => void send()} loading={sending} disabled={!canSend}>
                  {tp('batch_confirm', { count: ticked.length })}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
