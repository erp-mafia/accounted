'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
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
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { resolveAccount } from '@/lib/cash-accounts/resolve-account'
import { Loader2, Search, X, Plus, Check, AlertTriangle } from 'lucide-react'
import type { CashAccount } from '@/types'
import type { TransactionWithInvoice } from './transaction-types'

/**
 * Couple ONE bank transaction to N already-posted verifikat.
 *
 * The reported case: "jag har bokfört flera utlägg men gjort en utbetalning".
 * The verifikat exist; the bank row just cannot be attached to more than one of
 * them, so it stays unreconcilable and the account shows a differens the user
 * cannot explain away.
 *
 * Deliberately NOT a booking surface. Every candidate here is already posted,
 * and confirming writes only transaction_voucher_links rows. Splitting an
 * UNBOOKED row into several new verifikat is a different flow with different
 * risks (period locks, voucher sequence) and belongs in its own dialog.
 *
 * Modelled on MatchAllocationDialog: same running tally, same
 * must-reach-zero rule. That rule is not cosmetic here either. A remainder left
 * on the bank row reproduces exactly the differens this dialog exists to
 * remove, so the server enforces it too (BATCH_AMOUNT_BELOW_TX).
 */

interface LinkVouchersDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  /** Called after the links are written, so the caller can refresh its rows. */
  onLinked: (transactionId: string, linkCount: number) => void
}

/** A posted verifikat on the transaction's settlement account. */
interface VoucherCandidate {
  journal_entry_id: string
  line_id: string
  debit_amount: number
  credit_amount: number
  entry_date: string
  voucher_number: number
  voucher_series: string
  entry_description: string
  line_description: string | null
  source_type: string
  confidence?: number
  linked_transaction_count?: number
}

/** ±30 days around the transaction date, matching MatchVoucherDialog. */
const WINDOW_DAYS = 30

function shiftDate(isoDate: string, deltaDays: number): string {
  const d = new Date(isoDate)
  if (Number.isNaN(d.getTime())) return isoDate
  d.setDate(d.getDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

function parseAmount(s: string): number {
  // Swedish-style decimal comma + thousand spaces, same as MatchAllocationDialog.
  const cleaned = s.replace(/\s+/g, '').replace(',', '.')
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : 0
}

/** The magnitude of a voucher's movement on the settlement account. */
function voucherAmount(c: VoucherCandidate): number {
  return c.debit_amount > 0 ? c.debit_amount : c.credit_amount
}

export default function LinkVouchersDialog({
  open,
  onOpenChange,
  transaction,
  onLinked,
}: LinkVouchersDialogProps) {
  const { toast } = useToast()
  const t = useTranslations('tx_link_vouchers')

  const [candidates, setCandidates] = useState<VoucherCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [wideRange, setWideRange] = useState(false)
  const [accountNumber, setAccountNumber] = useState('1930')

  const loadCandidates = useCallback(
    async (tx: TransactionWithInvoice, wide: boolean, signal: { cancelled: boolean }) => {
      setLoading(true)
      try {
        // Resolve the settlement account the same way MatchVoucherDialog does:
        // a 1930 row must not be offered vouchers that only touch 1931.
        let account = '1930'
        try {
          const caRes = await fetch('/api/cash-accounts')
          if (caRes.ok) {
            const caJson = await caRes.json()
            if (!signal.cancelled) {
              const accounts = (caJson.data ?? []) as CashAccount[]
              account = resolveAccount(accounts, tx.cash_account_id ?? null, tx.currency ?? 'SEK').account
            }
          }
        } catch {
          // Network hiccup: fall back to 1930, the overwhelmingly common case.
        }
        if (!signal.cancelled) setAccountNumber(account)

        const params = new URLSearchParams()
        params.set('account_number', account)
        params.set('transaction_id', tx.id)
        if (!wide) {
          params.set('date_from', shiftDate(tx.date, -WINDOW_DAYS))
          params.set('date_to', shiftDate(tx.date, WINDOW_DAYS))
        }

        const res = await fetch(`/api/reconciliation/bank/unmatched-entries?${params}`)
        const json = await res.json()
        if (signal.cancelled) return
        setCandidates((json.data ?? []) as VoucherCandidate[])
      } finally {
        if (!signal.cancelled) setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (!open || !transaction) return
    const signal = { cancelled: false }
    void loadCandidates(transaction, wideRange, signal)
    return () => {
      signal.cancelled = true
    }
  }, [open, transaction, wideRange, loadCandidates])

  useEffect(() => {
    if (open) return
    setCandidates([])
    setDrafts({})
    setSearch('')
    setWideRange(false)
  }, [open])

  const txAmountAbs = transaction ? Math.abs(transaction.amount) : 0
  const txCurrency = transaction?.currency ?? 'SEK'

  const allocated = useMemo(
    () => Object.values(drafts).reduce((sum, a) => sum + parseAmount(a), 0),
    [drafts],
  )

  const leftover = roundOre(txAmountAbs - allocated)
  // Matches the RPC's 0.005 guard so the "balanserar" indicator never promises
  // something the server will reject.
  const TOLERANCE = 0.005
  const selectedCount = Object.keys(drafts).length
  const overshoot = leftover < -TOLERANCE
  const balanced = Math.abs(leftover) < TOLERANCE && selectedCount > 0
  const undershoot = leftover > TOLERANCE

  const filteredCandidates = useMemo(() => {
    const sorted = [...candidates].sort((a, b) => {
      const aSel = drafts[a.journal_entry_id] !== undefined
      const bSel = drafts[b.journal_entry_id] !== undefined
      if (aSel !== bSel) return aSel ? -1 : 1
      return 0
    })
    const needle = search.trim().toLowerCase()
    if (!needle) return sorted
    return sorted.filter((c) => {
      const haystack = `${formatVoucher(c)} ${c.entry_date} ${c.entry_description} ${c.line_description ?? ''} ${voucherAmount(c)}`
      return haystack.toLowerCase().includes(needle)
    })
  }, [candidates, drafts, search])

  function addAllocation(c: VoucherCandidate) {
    setDrafts((prev) => {
      if (prev[c.journal_entry_id] !== undefined) return prev
      // Default to the voucher's own movement, capped at what is still
      // unallocated, so the common "these three add up exactly" case is a
      // click per row with no typing.
      const budget = Math.max(0, roundOre(txAmountAbs - allocated))
      const suggested = Math.min(voucherAmount(c), budget)
      return {
        ...prev,
        [c.journal_entry_id]: suggested > 0 ? suggested.toFixed(2).replace('.', ',') : '',
      }
    })
  }

  function removeAllocation(journalEntryId: string) {
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[journalEntryId]
      return next
    })
  }

  async function handleConfirm() {
    if (!transaction || !balanced || overshoot) return

    setSubmitting(true)
    try {
      // The user types magnitudes; the sign is the bank row's and is applied
      // here rather than asked for. transaction_voucher_links.allocated_amount
      // is signed, and the RPC rejects any leg whose sign disagrees with the
      // transaction, so deriving it is both safer and less to explain.
      const sign = transaction.amount < 0 ? -1 : 1
      const links = Object.entries(drafts)
        .map(([journal_entry_id, raw]) => ({
          journal_entry_id,
          allocated_amount: roundOre(parseAmount(raw)) * sign,
        }))
        .filter((l) => l.allocated_amount !== 0)

      if (links.length === 0) {
        toast({
          title: t('error_no_links_title'),
          description: t('error_no_links_description'),
          variant: 'destructive',
        })
        return
      }

      const res = await fetch(`/api/transactions/${transaction.id}/link-vouchers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ links }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast({
          title: t('error_submit_title'),
          description: getErrorMessage(body, { context: 'transaction', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }

      toast({
        title: t('success_title'),
        description: t('success_description', { count: links.length }),
        variant: 'success',
      })
      onLinked(transaction.id, links.length)
      onOpenChange(false)
    } catch (err) {
      toast({
        title: t('error_submit_title'),
        description: getErrorMessage(err, { context: 'transaction' }),
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  if (!transaction) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Transaction summary */}
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              {t('transaction_label')}
            </p>
            <p className="mt-1 text-sm font-medium">{transaction.description}</p>
            <div className="mt-1 flex items-center justify-between text-sm">
              <span className="tabular-nums text-muted-foreground">
                {formatDate(transaction.date)}
              </span>
              <span className={cn('font-medium tabular-nums', transaction.amount > 0 && 'text-success')}>
                {transaction.amount > 0 ? '+' : ''}
                {formatCurrency(transaction.amount, transaction.currency)}
              </span>
            </div>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('search_placeholder')}
              className="pl-9"
            />
          </div>

          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : filteredCandidates.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center">
              <p className="text-sm font-medium">{t('empty_title')}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('empty_description', { account: accountNumber })}
              </p>
            </div>
          ) : (
            <ul className="max-h-[320px] space-y-2 overflow-y-auto">
              {filteredCandidates.map((c) => {
                const draft = drafts[c.journal_entry_id]
                const isSelected = draft !== undefined
                return (
                  <li
                    key={c.line_id}
                    className={cn(
                      'rounded-lg border p-3 transition-colors',
                      isSelected ? 'border-foreground' : 'border-border',
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs tabular-nums">{formatVoucher(c)}</span>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {formatDate(c.entry_date)}
                          </span>
                          {/* Chips mark exceptions only (convention 5): an
                              already-settled voucher is the deviation worth
                              flagging, a normal candidate gets no chip. */}
                          {(c.linked_transaction_count ?? 0) > 0 && (
                            <Badge variant="secondary">{t('already_matched_badge')}</Badge>
                          )}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {c.line_description || c.entry_description}
                        </p>
                        <p className="text-xs tabular-nums text-muted-foreground">
                          {t('voucher_amount_label', {
                            amount: formatCurrency(voucherAmount(c), txCurrency),
                          })}
                        </p>
                      </div>
                      {isSelected ? (
                        <div className="flex items-center gap-2">
                          <Input
                            type="text"
                            inputMode="decimal"
                            value={draft}
                            onChange={(e) =>
                              setDrafts((prev) => ({ ...prev, [c.journal_entry_id]: e.target.value }))
                            }
                            className="h-9 w-28 text-right font-mono tabular-nums"
                            aria-label={t('amount_input_aria', { voucher: formatVoucher(c) })}
                          />
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => removeAllocation(c.journal_entry_id)}
                            aria-label={t('remove_aria', { voucher: formatVoucher(c) })}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        <Button type="button" size="sm" variant="outline" onClick={() => addAllocation(c)}>
                          <Plus className="mr-1 h-3.5 w-3.5" />
                          {t('add_button')}
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {!loading && !wideRange && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setWideRange(true)}>
              {t('show_all_dates')}
            </Button>
          )}

          {/* Tally */}
          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t('allocated_label')}</span>
              <span
                className={cn(
                  'font-mono tabular-nums',
                  overshoot && 'text-destructive',
                  balanced && 'text-success',
                )}
              >
                {formatCurrency(allocated, txCurrency)} / {formatCurrency(txAmountAbs, txCurrency)}
              </span>
            </div>
            {overshoot ? (
              <p className="flex items-start gap-2 text-[12.5px] text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                {t('overshoot_warning', {
                  excess: formatCurrency(Math.abs(leftover), txCurrency),
                })}
              </p>
            ) : balanced ? (
              <p className="flex items-start gap-2 text-[12.5px] text-success">
                <Check className="mt-0.5 h-4 w-4 flex-shrink-0" />
                {t('balanced_message', { count: selectedCount })}
              </p>
            ) : undershoot && selectedCount > 0 ? (
              <p className="attn flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                {t('undershoot_warning', { amount: formatCurrency(leftover, txCurrency) })}
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={submitting || !balanced || overshoot}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
