'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  bulkRequestBody,
  bulkRow,
  bulkSummary,
  bulkTitle,
  bulkToSend,
  runBulkSends,
  type BulkHoldReason,
  type BulkOutcome,
  type BulkRow,
} from '@/lib/collections/bulk-handover'
import type { CollectionReadinessView } from '@/lib/collections/invoice-collection'
import { toggleUnticked } from '@/lib/collections/batch-dialog'
import { formatKronor } from '@/lib/collections/amount-text'
import { cn } from '@/lib/utils'
import { fetchCollectionReadiness, postOpenCase, useCaseWords } from './case-client'
import { blockText, checkLineText } from './check-text'

/**
 * "Skicka till inkasso (N)" from the invoice list's Förfallna view: one
 * dialog listing each ticked invoice with its bank check and first step.
 * Invoices that need a person first (a possible payment in the bank, an
 * attestation, a requirement not met) are listed with the reason and a link
 * to the invoice, never sent from here. Sending runs the existing
 * per-invoice handover one at a time and reports each invoice. Decisions
 * live in lib/collections/bulk-handover.ts.
 *
 * Mount it while it is open: it reads each invoice's checks when it mounts
 * and starts with everything sendable ticked.
 */

export interface BulkHandoverInvoice {
  id: string
  invoiceNumber: string | null
  customerName: string | null
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoices: BulkHandoverInvoice[]
  /** The provider's name (catalogue, else the connection's), or null for the neutral word. */
  displayName: string | null
  sandbox: boolean
  /** After the run (whatever it sent): read the list again. */
  onDone: () => void
}

/** How many invoices are checked at once while the dialog opens. */
const CHECK_CONCURRENCY = 3

export function BulkHandoverDialog({ open, onOpenChange, invoices, displayName, sandbox, onDone }: Props) {
  const { tp, locale } = useCaseWords(displayName)
  const ids = useMemo(() => invoices.map((i) => i.id), [invoices])
  // undefined while an invoice's checks load; null when they could not be read.
  const [readiness, setReadiness] = useState<Record<string, CollectionReadinessView | null | undefined>>({})
  const [unticked, setUnticked] = useState<string[]>([])
  const [outcomes, setOutcomes] = useState<Record<string, BulkOutcome>>({})
  const [ran, setRan] = useState(false)

  useEffect(() => {
    let cancelled = false
    const queue = [...ids]
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const current = id
        const next = await fetchCollectionReadiness(current).catch(() => null)
        if (!cancelled) setReadiness((r) => ({ ...r, [current]: next }))
      }
    }
    void Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length) }, worker))
    return () => {
      cancelled = true
    }
  }, [ids])

  const rows: Record<string, BulkRow> = Object.fromEntries(ids.map((id) => [id, bulkRow(readiness[id])]))
  const toSend = bulkToSend(ids, rows, unticked)
  // The title and the button count the same invoices: what actually goes out.
  const title = bulkTitle(ids, rows, unticked)
  const summary = bulkSummary(outcomes)
  const loading = ids.some((id) => rows[id]?.state === 'loading')
  const noneSendable = !loading && ids.every((id) => rows[id]?.state !== 'sendable')

  async function send() {
    setRan(true)
    await runBulkSends(
      toSend,
      async (id) => {
        const facts = readiness[id]
        if (!facts) return { state: 'failed', message: tp('bulk_hold_unavailable') }
        const result = await postOpenCase(id, bulkRequestBody(facts), locale)
        return result.ok ? { state: 'sent', registered: result.data.registered !== false } : { state: 'failed', message: result.message }
      },
      (id, outcome) => setOutcomes((o) => ({ ...o, [id]: outcome })),
    )
    onDone()
  }

  const finished = ran && !summary.running

  return (
    <Dialog open={open} onOpenChange={(next) => !summary.running && onOpenChange(next)}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle className="text-lg">{title.key === 'bulk_title' ? tp('bulk_title', { count: title.count }) : tp('bulk_title_plain')}</DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            {sandbox ? `${tp('bulk_intro')} ${tp('sandbox_note')}` : tp('bulk_intro')}
          </DialogDescription>
        </DialogHeader>

        <ul className="divide-y divide-border border-y border-border" data-ph-mask="">
          {invoices.map((invoice) => {
            const row = rows[invoice.id]!
            const outcome = outcomes[invoice.id]
            return (
              <li key={invoice.id} className="flex min-w-0 items-start gap-3 py-3 text-[13px]">
                <span className="w-4 shrink-0 pt-0.5">
                  {row.state === 'sendable' && !ran && (
                    <Checkbox
                      checked={!unticked.includes(invoice.id)}
                      onCheckedChange={() => setUnticked((u) => toggleUnticked(u, invoice.id))}
                      aria-label={tp('bulk_item_aria', { number: invoice.invoiceNumber ?? '' })}
                    />
                  )}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                    <span className="tabular-nums">{invoice.invoiceNumber ?? ''}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{invoice.customerName ?? ''}</span>
                    {row.state !== 'loading' && row.remaining !== null && (
                      <span className="tabular-nums">{formatKronor(row.remaining)}</span>
                    )}
                  </div>
                  {row.state === 'loading' ? (
                    <Skeleton className="h-4 w-2/3 rounded-sm" />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {[
                        row.step ? tp(row.step === 'reminder' ? 'batch_step_reminder' : 'batch_step_collection') : null,
                        // A held row says why on its own line; the bank line would repeat it.
                        row.state === 'sendable' ? checkLineText(row.check, tp) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                  {row.state === 'held' && (
                    <p className="text-xs text-attn">
                      {holdText(row.reason, tp)}{' '}
                      <Link href={`/invoices/${invoice.id}`} className="text-foreground underline underline-offset-2">
                        {tp('bulk_open_invoice')}
                      </Link>
                    </p>
                  )}
                  {outcome && (
                    <p className={cn('text-xs', outcome.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
                      {outcome.state === 'sending'
                        ? tp('bulk_outcome_sending')
                        : outcome.state === 'sent'
                          ? tp(outcome.registered ? 'bulk_outcome_sent' : 'bulk_outcome_registering')
                          : tp('bulk_outcome_failed', { message: outcome.message })}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ul>

        {noneSendable && !ran && <p className="text-[13px] text-muted-foreground">{tp('bulk_none')}</p>}
        {finished && <p className="text-[13px]">{tp('bulk_done', { sent: summary.sent, failed: summary.failed })}</p>}

        <DialogFooter>
          {finished ? (
            <Button onClick={() => onOpenChange(false)}>{tp('batch_close')}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={summary.running}>
                {tp('send_cancel')}
              </Button>
              <Button onClick={() => void send()} loading={summary.running} disabled={loading || toSend.length === 0 || ran}>
                {tp('bulk_confirm', { count: toSend.length })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function holdText(reason: BulkHoldReason, tp: (key: string, values?: Record<string, string | number>) => string): string {
  switch (reason.key) {
    case 'bulk_hold_blocked':
      return blockText(reason.block, tp)
    case 'bulk_hold_candidates':
      return tp('bulk_hold_candidates', { count: reason.count })
    default:
      return tp(reason.key)
  }
}
