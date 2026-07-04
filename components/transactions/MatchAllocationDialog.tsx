'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate, cn, isValidExchangeRate } from '@/lib/utils'
import { Loader2, Search, X, Plus, Check, AlertTriangle } from 'lucide-react'
import type { Invoice, Customer, SupplierInvoice, Supplier } from '@/types'
import type { TransactionWithInvoice } from './transaction-types'

interface MatchAllocationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  onSuccess: () => void
}

/**
 * Direction-aware allocation candidate. The dialog normalizes customer and
 * supplier invoices to the same shape so the row renderer + tally math stay
 * a single code path. The `kind` discriminator drives the underlying API
 * payload at submit time.
 *
 * `remaining` is in the invoice's own `currency` (USD, EUR, etc.).
 * `exchangeRate` is the invoice's SEK-per-foreign-unit at invoicing time:
 * used to compute the default SEK amount for cross-currency rows so the
 * user doesn't have to mental-math the FX (PR #607).
 */
interface AllocationCandidate {
  kind: 'customer_invoice' | 'supplier_invoice'
  id: string
  label: string
  counterpartyName: string
  remaining: number
  total: number
  currency: string
  exchangeRate: number | null
  dueDate: string
}

type AllocationDraft = {
  candidateId: string
  amount: string
}

type CustomerInvoiceRow = Invoice & { customer?: Customer | null }
type SupplierInvoiceRow = SupplierInvoice & { supplier?: Supplier | null }

function parseAmount(s: string): number {
  // Accept Swedish-style decimal comma + thousand spaces. Empty string → 0.
  const cleaned = s.replace(/\s+/g, '').replace(',', '.')
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : 0
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export default function MatchAllocationDialog({
  open,
  onOpenChange,
  transaction,
  onSuccess,
}: MatchAllocationDialogProps) {
  const { toast } = useToast()
  const { company } = useCompany()
  const supabase = useMemo(() => createClient(), [])
  const t = useTranslations('tx_match_allocation')

  const kind: 'customer_invoice' | 'supplier_invoice' = useMemo(() => {
    // Strict > 0 (was >= 0): a zero-amount tx would otherwise load customer
    // candidates and the RPC would reject with BATCH_TX_ZERO_AMOUNT after
    // the user has already filled in allocations. PR #603 review fix.
    return transaction && transaction.amount > 0 ? 'customer_invoice' : 'supplier_invoice'
  }, [transaction])

  const [candidates, setCandidates] = useState<AllocationCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [drafts, setDrafts] = useState<Record<string, AllocationDraft>>({})
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open || !transaction || !company) return
    const companyId = company.id
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        if (kind === 'customer_invoice') {
          // Mirror InvoicePicker's filter: only true invoices (no proformas)
          // in an open state with a positive remaining balance.
          const { data } = await supabase
            .from('invoices')
            .select('*, customer:customers(id, name)')
            .eq('company_id', companyId)
            .eq('document_type', 'invoice')
            .in('status', ['sent', 'overdue', 'partially_paid'])
            .gt('remaining_amount', 0)
            .order('due_date', { ascending: true })
          if (cancelled) return
          const rows = (data ?? []) as CustomerInvoiceRow[]
          setCandidates(
            rows.map((r) => ({
              kind: 'customer_invoice',
              id: r.id,
              label: r.invoice_number ?? r.id.slice(0, 8),
              counterpartyName: r.customer?.name ?? t('unknown_customer'),
              remaining: Number(r.remaining_amount ?? r.total ?? 0),
              total: Number(r.total ?? 0),
              currency: r.currency,
              exchangeRate: r.exchange_rate != null ? Number(r.exchange_rate) : null,
              dueDate: r.due_date,
            })),
          )
        } else {
          const { data } = await supabase
            .from('supplier_invoices')
            .select('*, supplier:suppliers(id, name)')
            .eq('company_id', companyId)
            .in('status', ['registered', 'approved', 'overdue', 'partially_paid'])
            .gt('remaining_amount', 0)
            .order('due_date', { ascending: true })
          if (cancelled) return
          const rows = (data ?? []) as SupplierInvoiceRow[]
          setCandidates(
            rows.map((r) => ({
              kind: 'supplier_invoice',
              id: r.id,
              label: r.supplier_invoice_number ?? `LF-${r.arrival_number}`,
              counterpartyName: r.supplier?.name ?? t('unknown_supplier'),
              remaining: Number(r.remaining_amount ?? r.total ?? 0),
              total: Number(r.total ?? 0),
              currency: r.currency,
              exchangeRate: r.exchange_rate != null ? Number(r.exchange_rate) : null,
              dueDate: r.due_date,
            })),
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [open, transaction, company, kind, supabase, t])

  // Reset state every time the dialog re-opens for a new tx.
  useEffect(() => {
    if (!open) {
      setDrafts({})
      setSearch('')
    }
  }, [open])

  const txAmountAbs = transaction ? Math.abs(transaction.amount) : 0
  const txCurrency = transaction?.currency ?? 'SEK'

  // Each draft's `amount` is the allocation in TRANSACTION currency (SEK
  // for a Swedish bank import). For cross-currency invoices the FX
  // rounding lives inside per-row FX diff lines (Dr 7960 / Cr 3960): NOT
  // in the tolerance. So the sum must equal tx_abs exactly: anything
  // unallocated would leave the bank line on 1930 short of the actual
  // bank receipt and break reconciliation. (PR #607 round-1 review.)
  const allocated = useMemo(() => {
    return Object.values(drafts).reduce((sum, d) => sum + parseAmount(d.amount), 0)
  }, [drafts])

  const leftover = round2(txAmountAbs - allocated)
  // 0.005 SEK matches the RPC's BATCH_AMOUNT_EXCEEDS_TX guard so the
  // "balanced ✓" indicator never lies to the user about what the server
  // will accept.
  const TOLERANCE = 0.005
  const overshoot = leftover < -TOLERANCE
  const balanced =
    Math.abs(leftover) < TOLERANCE && Object.keys(drafts).length > 0
  const undershoot = leftover > TOLERANCE

  const filteredCandidates = useMemo(() => {
    const selectedIds = new Set(Object.keys(drafts))
    const sorted = [...candidates].sort((a, b) => {
      const aSel = selectedIds.has(a.id)
      const bSel = selectedIds.has(b.id)
      if (aSel !== bSel) return aSel ? -1 : 1
      return a.dueDate.localeCompare(b.dueDate)
    })
    if (!search.trim()) return sorted
    const needle = search.trim().toLowerCase()
    return sorted.filter((c) => {
      const haystack = `${c.label} ${c.counterpartyName}`.toLowerCase()
      return haystack.includes(needle)
    })
  }, [candidates, drafts, search])

  function addAllocation(candidate: AllocationCandidate) {
    setDrafts((prev) => {
      if (prev[candidate.id]) return prev
      const remainingTxBudget = Math.max(0, round2(txAmountAbs - allocated))
      const sameCurrency = candidate.currency === txCurrency

      // Same-currency: partial allowed, default to min(remaining, budget).
      // Cross-currency: full-payment-only, default to booked SEK (rate
      // sanity-checked). NOT capped to remainingTxBudget: the cross-
      // currency RPC guard requires the amount to be within ±10% of
      // booked_sek, so capping a USD invoice's default at the leftover
      // budget would silently trigger BATCH_FX_DEVIATION_TOO_LARGE on
      // submit. Instead, let the row default to the right amount and
      // the user re-balances the other rows to fit. PR #607 review fix.
      let defaultAmount: number
      if (sameCurrency) {
        defaultAmount = Math.min(candidate.remaining, remainingTxBudget)
      } else if (isValidExchangeRate(candidate.exchangeRate)) {
        defaultAmount = round2(candidate.remaining * candidate.exchangeRate)
      } else {
        // No (or out-of-range) FX rate. Leave the amount blank rather
        // than guessing a misleading default; the user must enter the
        // SEK amount the bank converted to manually. Blocked from
        // confirm via the per-row warning below.
        defaultAmount = 0
      }

      return {
        ...prev,
        [candidate.id]: {
          candidateId: candidate.id,
          amount: defaultAmount > 0 ? defaultAmount.toFixed(2).replace('.', ',') : '',
        },
      }
    })
  }

  function removeAllocation(candidateId: string) {
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[candidateId]
      return next
    })
  }

  function setDraftAmount(candidateId: string, amount: string) {
    setDrafts((prev) => ({
      ...prev,
      [candidateId]: { candidateId, amount },
    }))
  }

  async function handleConfirm() {
    if (!transaction) return
    // PR #607 round-1 review: require balanced. Undershoot is no longer
    // allowed because it leaves the bank line short of tx_abs and breaks
    // reconciliation.
    if (!balanced || overshoot) return

    setSubmitting(true)
    try {
      const allocations = Object.values(drafts)
        .map((d) => {
          const cand = candidates.find((c) => c.id === d.candidateId)
          if (!cand) return null
          const amount = parseAmount(d.amount)
          if (amount <= 0) return null
          return cand.kind === 'customer_invoice'
            ? { kind: 'customer_invoice' as const, invoice_id: cand.id, amount }
            : { kind: 'supplier_invoice' as const, supplier_invoice_id: cand.id, amount }
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)

      if (allocations.length === 0) {
        toast({
          title: t('error_no_allocations_title'),
          description: t('error_no_allocations_description'),
          variant: 'destructive',
        })
        setSubmitting(false)
        return
      }

      const response = await fetch(`/api/transactions/${transaction.id}/match-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allocations }),
      })

      if (!response.ok) {
        const body = await response.json().catch(() => null)
        toast({
          title: t('error_submit_title'),
          description: getErrorMessage(body, {
            context: kind === 'customer_invoice' ? 'invoice' : 'supplier_invoice',
            statusCode: response.status,
          }),
          variant: 'destructive',
        })
        return
      }

      toast({
        title: t('success_title'),
        description: t('success_description', { count: allocations.length }),
        variant: 'success',
      })
      onSuccess()
      onOpenChange(false)
    } catch (err) {
      toast({
        title: t('error_submit_title'),
        description: getErrorMessage(err, {
          context: kind === 'customer_invoice' ? 'invoice' : 'supplier_invoice',
        }),
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
          <DialogDescription>
            {kind === 'customer_invoice' ? t('description_customer') : t('description_supplier')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Transaction summary */}
          <div className="rounded-lg border bg-card p-3">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              {t('transaction_label')}
            </p>
            <p className="mt-1 text-sm font-medium">{transaction.description}</p>
            <div className="mt-1 flex items-center justify-between text-sm">
              <span className="tabular-nums text-muted-foreground">
                {formatDate(transaction.date)}
              </span>
              <span
                className={cn(
                  'font-medium tabular-nums',
                  transaction.amount > 0 && 'text-success',
                )}
              >
                {transaction.amount > 0 ? '+' : ''}
                {formatCurrency(transaction.amount, transaction.currency)}
              </span>
            </div>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('search_placeholder')}
              className="pl-9"
            />
          </div>

          {/* Candidate list */}
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : filteredCandidates.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center">
              <p className="text-sm font-medium">{t('empty_title')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('empty_description')}</p>
            </div>
          ) : (
            <ul className="space-y-2 max-h-[320px] overflow-y-auto">
              {filteredCandidates.map((c) => {
                const draft = drafts[c.id]
                const isSelected = !!draft
                return (
                  <li
                    key={c.id}
                    className={cn(
                      'rounded-lg border bg-card p-3 transition-colors',
                      isSelected ? 'border-foreground' : 'border-border',
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium tabular-nums">{c.label}</span>
                          {isSelected && (
                            <Badge variant="secondary" className="gap-1">
                              <Check className="h-3 w-3" />
                              {t('selected_badge')}
                            </Badge>
                          )}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {c.counterpartyName}
                        </p>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {t('remaining_label', {
                            amount: formatCurrency(c.remaining, c.currency),
                          })}
                        </p>
                      </div>
                      {isSelected ? (
                        <div className="flex flex-col items-end gap-1">
                          <div className="flex items-center gap-2">
                            <Input
                              type="text"
                              inputMode="decimal"
                              value={draft.amount}
                              onChange={(e) => setDraftAmount(c.id, e.target.value)}
                              className="h-9 w-28 font-mono text-right tabular-nums"
                              aria-label={t('amount_input_aria', { label: c.label })}
                            />
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              onClick={() => removeAllocation(c.id)}
                              aria-label={t('remove_aria', { label: c.label })}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                          {/* FX hint: appears only for cross-currency rows
                              so the user can see what their tx-currency
                              input translates to in invoice currency.
                              When the rate is missing or out of range, we
                              warn instead of silently defaulting to a
                              misleading number. PR #607 round-1 review. */}
                          {c.currency !== txCurrency && (
                            isValidExchangeRate(c.exchangeRate) ? (
                              <p className="text-[11px] tabular-nums text-muted-foreground">
                                ≈ {formatCurrency(parseAmount(draft.amount) / c.exchangeRate, c.currency)}
                              </p>
                            ) : (
                              <p className="text-[11px] tabular-nums text-warning-foreground">
                                {t('fx_rate_missing_warning', { currency: c.currency })}
                              </p>
                            )
                          )}
                        </div>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => addAllocation(c)}
                        >
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

          {/* Tally */}
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t('allocated_label')}</span>
              <span
                className={cn(
                  'font-mono tabular-nums',
                  overshoot && 'text-destructive',
                  balanced && 'text-success',
                )}
              >
                {formatCurrency(allocated, transaction.currency)} /{' '}
                {formatCurrency(txAmountAbs, transaction.currency)}
              </span>
            </div>
            {overshoot ? (
              <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                <p>
                  {t('overshoot_warning', {
                    excess: formatCurrency(Math.abs(leftover), transaction.currency),
                  })}
                </p>
              </div>
            ) : balanced ? (
              <div className="flex items-center gap-2 rounded-lg bg-success/10 p-3 text-sm text-success">
                <Check className="h-4 w-4 flex-shrink-0" />
                <p>{t('balanced_message')}</p>
              </div>
            ) : undershoot && Object.keys(drafts).length > 0 ? (
              // Undershoot is now a blocking state: the JE's 1930 line
              // must equal the bank's actual receipt or reconciliation
              // breaks. The user must allocate the full amount or remove
              // selections. PR #607 round-1 review fix.
              <div className="flex items-start gap-2 rounded-lg bg-warning/10 p-3 text-sm text-warning-foreground">
                <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <p>
                  {t('undershoot_warning', {
                    amount: formatCurrency(leftover, transaction.currency),
                  })}
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button
            onClick={handleConfirm}
            // Confirm requires sum == tx_abs exactly (within rounding).
            // Anything else lets the JE diverge from the bank line and
            // breaks reconciliation. PR #607 round-1 review fix.
            disabled={submitting || !balanced || overshoot}
          >
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
