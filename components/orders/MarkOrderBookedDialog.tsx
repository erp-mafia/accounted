'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { WebshopOrder } from '@/types'

interface MarkOrderBookedDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  order: WebshopOrder
  onMarked: () => void
}

interface EntryCandidate {
  id: string
  entry_date: string
  description: string | null
  voucher_series?: string | null
  voucher_number?: number | null
  total_amount?: number | null
}

// ±45 days around the order date: wide enough for a manual booking done in
// the same period, narrow enough to keep the candidate list short. Typing a
// search drops the window (search over all posted entries instead).
const WINDOW_DAYS = 45
const CANDIDATE_LIMIT = 30

function shiftDate(isoDate: string, deltaDays: number): string {
  const d = new Date(isoDate)
  if (Number.isNaN(d.getTime())) return isoDate
  d.setDate(d.getDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

/**
 * Marks one order/refund row as already booked/handled outside the
 * integration (issue #1879): no verifikat is created, the row just leaves
 * the to-book list. Optionally links the existing posted verifikat that
 * covers the order, picked from a searchable candidate list.
 */
export default function MarkOrderBookedDialog({
  open,
  onOpenChange,
  order,
  onMarked,
}: MarkOrderBookedDialogProps) {
  const t = useTranslations('webshop_orders')
  const { toast } = useToast()
  const [candidates, setCandidates] = useState<EntryCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const loadCandidates = useCallback(
    async (query: string, signal: { cancelled: boolean }) => {
      setLoading(true)
      try {
        const params = new URLSearchParams()
        params.set('status', 'posted')
        params.set('exclude_draft', 'true')
        params.set('limit', String(CANDIDATE_LIMIT))
        if (query) {
          params.set('search', query)
        } else {
          const anchor = order.paid_date ?? order.order_date
          params.set('date_from', shiftDate(anchor, -WINDOW_DAYS))
          params.set('date_to', shiftDate(anchor, WINDOW_DAYS))
        }
        const res = await fetch(`/api/bookkeeping/journal-entries?${params}`)
        if (!res.ok) throw new Error(`list failed: ${res.status}`)
        const json = (await res.json()) as { data: EntryCandidate[] }
        if (!signal.cancelled) setCandidates(json.data ?? [])
      } catch {
        if (!signal.cancelled) setCandidates([])
      } finally {
        if (!signal.cancelled) setLoading(false)
      }
    },
    [order.paid_date, order.order_date],
  )

  // (Re)load when the dialog opens or the search changes (debounced).
  useEffect(() => {
    if (!open) return
    const signal = { cancelled: false }
    const timer = setTimeout(() => void loadCandidates(search.trim(), signal), 250)
    return () => {
      signal.cancelled = true
      clearTimeout(timer)
    }
  }, [open, search, loadCandidates])

  // Reset transient state when the dialog closes.
  useEffect(() => {
    if (open) return
    setCandidates([])
    setSearch('')
    setSelected('')
  }, [open])

  async function handleConfirm() {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/webshop-orders/${order.id}/mark-booked`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selected ? { journal_entry_id: selected } : {}),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        toast({
          title: t('mark_failed'),
          description: getErrorMessage(json, { context: 'transaction', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      onMarked()
    } catch {
      toast({ title: t('mark_failed'), variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  const isRefund = order.row_type === 'refund'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          {/* data-ph-mask: the order number is user data */}
          <DialogTitle data-ph-mask="">
            {isRefund
              ? t('mark_refund_title', { number: order.order_number })
              : t('mark_title', { number: order.order_number })}
          </DialogTitle>
          <DialogDescription>
            {formatDate(order.paid_date ?? order.order_date)}
            {' · '}
            {formatCurrency(order.total, order.currency)}
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">{t('mark_description')}</p>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t('mark_link_label')}</p>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('mark_link_search_placeholder')}
            aria-label={t('mark_link_search_placeholder')}
          />
          {loading ? (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-border py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('mark_link_loading')}
            </div>
          ) : candidates.length === 0 ? (
            <p className="rounded-lg border border-border px-3 py-4 text-center text-sm text-muted-foreground">
              {t('mark_link_empty')}
            </p>
          ) : (
            <div
              role="radiogroup"
              aria-label={t('mark_link_label')}
              className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border p-1"
            >
              {candidates.map((entry) => {
                const active = selected === entry.id
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setSelected(active ? '' : entry.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-sm px-2 py-2 text-left text-[13px] transition-colors duration-150',
                      active ? 'bg-secondary text-foreground' : 'hover:bg-secondary/60',
                    )}
                  >
                    <span className="w-12 shrink-0 font-medium tabular-nums">
                      {formatVoucher(entry)}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatDate(entry.entry_date)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{entry.description}</span>
                    <span className="shrink-0 text-right tabular-nums">
                      {entry.total_amount != null ? formatCurrency(entry.total_amount) : ''}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t('mark_link_optional_hint')}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('mark_submitting')}
              </>
            ) : (
              t('mark_confirm')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
