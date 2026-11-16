'use client'

import { useState, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import {
  BuildingLibraryIcon,
  DocumentTextIcon,
  MagnifyingGlassIcon,
  SpinnerIcon,
} from '@/components/icons'
import { useCompany } from '@/contexts/CompanyContext'
import type { Invoice, Customer, SupplierInvoice, Supplier } from '@/types'
import { DEDUCTION_TYPE_LABEL_KEYS } from '@/lib/bookkeeping/rot-rut-rules'
import type { PotentialRotRutPayoutRequest, TransactionWithInvoice } from './transaction-types'
import {
  DOMESTIC_CURRENCY,
  normalizeCurrency,
  rankInvoicesByAmountProximity,
} from './invoice-candidate-ranking'
import { expectedRotRutPayoutAmount } from '@/lib/invoices/rot-rut-payout-matching'
import { loadOpenRotRutPayoutRequests } from '@/lib/invoices/open-rot-rut-payout-requests'
import { PICKER_LIMIT, loadOpenInvoicesForMatch } from '@/lib/invoices/open-invoice-search'
import { invoiceStatusDisplay } from '@/lib/invoices/status-display'
import { effectiveInvoiceStatus } from '@/lib/invoices/overdue'
import { supplierInvoiceStatusDisplay } from '@/lib/supplier-invoices/status-display'
import { statusChipTextClass } from '@/lib/status-display'
import { planPickedAllocations } from '@/lib/transactions/split-match'
import type { BatchAllocationPrefill } from '@/lib/transactions/parts-read'

/** Pause after the last keystroke before the search goes to the database. */
const SEARCH_DEBOUNCE_MS = 250

export type OpenInvoice = Invoice & { customer?: Customer }
export type OpenSupplierInvoice = SupplierInvoice & { supplier?: Supplier }

/**
 * The one picker for matching a bank transaction to an open invoice, in
 * either direction: customer invoices for money in, supplier invoices for
 * money out. The rows, the search (in the database, via
 * loadOpenInvoicesForMatch) and the amount ranking are the same for both; only
 * the customer side offers Skatteverket's ROT/RUT payouts.
 *
 * A row click matches that one invoice. With onSelectSeveral, the invoices in
 * the row's currency also carry a checkbox: one payment for several invoices
 * (PH 192) is ticked here and handed over, planned by the batch rules
 * (planPickedAllocations), to the batch allocation dialog.
 */
type InvoicePickerProps =
  | {
      kind?: 'customer'
      transaction: TransactionWithInvoice
      onSelect: (invoice: OpenInvoice) => void
      /** Pay several ticked invoices with this one row (POST match-batch). */
      onSelectSeveral?: (allocations: BatchAllocationPrefill[]) => void
      /** Pick one or several open ROT/RUT begäran instead of an invoice
       *  (Skatteverkets utbetalning). A row click hands over that begäran alone;
       *  the checkboxes build a bundle for a transfer that paid several beslut,
       *  which the automatic set matcher refuses when two begäran carry the same
       *  amount (#2425). The section only renders when the company has one. */
      onSelectRotRutPayout?: (requests: PotentialRotRutPayoutRequest[]) => void
    }
  | {
      kind: 'supplier'
      transaction: TransactionWithInvoice
      onSelect: (invoice: OpenSupplierInvoice) => void
      onSelectSeveral?: (allocations: BatchAllocationPrefill[]) => void
      onSelectRotRutPayout?: never
    }

type PickerRow = OpenInvoice | OpenSupplierInvoice

function rowNumber(row: PickerRow): string | null {
  return 'supplier_invoice_number' in row ? row.supplier_invoice_number : row.invoice_number
}

function rowCounterparty(row: PickerRow): string | null {
  return 'supplier_invoice_number' in row ? (row.supplier?.name ?? null) : (row.customer?.name ?? null)
}

export default function InvoicePicker(props: InvoicePickerProps) {
  const { transaction, onSelectRotRutPayout, onSelectSeveral } = props
  const kind = props.kind ?? 'customer'
  const isSupplier = kind === 'supplier'
  const t = useTranslations('tx_invoice_picker')
  const tCommon = useTranslations('common')
  const tInvoices = useTranslations('invoices')
  const tSupplierInvoices = useTranslations('supplier_invoices')
  const { company } = useCompany()
  const supabase = useMemo(() => createClient(), [])
  // Rows for the applied search term (the newest open invoices without one).
  const [invoices, setInvoices] = useState<PickerRow[]>([])
  // Whether the request came back full: older rows exist past the limit.
  const [capped, setCapped] = useState(false)
  // Whether the company has any open invoice at all (the unsearched load):
  // decides between the empty state and the search box.
  const [hasOpenInvoices, setHasOpenInvoices] = useState(false)
  const [rotRutRequests, setRotRutRequests] = useState<PotentialRotRutPayoutRequest[]>([])
  const [isLoading, setIsLoading] = useState(true)
  // The invoices could not be read: said in place of the rows (never "no
  // open invoices"), with "Försök igen".
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [isSearching, setIsSearching] = useState(false)
  const [search, setSearch] = useState('')
  // The term the database was asked for, trailing the input by a short pause.
  const [appliedSearch, setAppliedSearch] = useState('')
  // Begäran ticked for a bundled handoff; empty until the user ticks one.
  const [pickedRequestIds, setPickedRequestIds] = useState<ReadonlySet<string>>(() => new Set())
  // Invoices ticked for one payment of several, kept with their row so a
  // later search never drops one from the sum.
  const [pickedInvoices, setPickedInvoices] = useState<ReadonlyMap<string, PickerRow>>(() => new Map())
  // Boolean, not the callback: a fresh function identity per parent render
  // must not refetch the list.
  const wantRotRutRequests = !!onSelectRotRutPayout

  useEffect(() => {
    const handle = setTimeout(() => setAppliedSearch(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [search])

  useEffect(() => {
    if (!company) return
    // Capture the company id once so the async closure below never
    // dereferences a `company` that has flipped to null between renders.
    // The earlier non-null assertions allowed a stale render to query
    // against an undefined company_id; pinning the value avoids that.
    const companyId = company.id
    let cancelled = false
    async function load() {
      if (appliedSearch) setIsSearching(true)
      else setIsLoading(true)
      try {
        // The search runs in the database across every open invoice: the
        // newest-first list is capped, so filtering it here could never find
        // an older open invoice. The matchable statuses and the status-leak
        // guard (an unpaid status on a row that already has a payment
        // voucher) live there too (lib/invoices/open-invoice-search).
        const { rows, capped: full } = await loadOpenInvoicesForMatch<PickerRow>(
          supabase,
          companyId,
          kind,
          appliedSearch,
        )
        if (cancelled) return
        setInvoices(rows)
        setCapped(full)
        if (!appliedSearch) setHasOpenInvoices(rows.length > 0)
        setLoadFailed(false)
      } catch {
        if (cancelled) return
        setInvoices([])
        setCapped(false)
        setLoadFailed(true)
      } finally {
        if (!cancelled) {
          setIsLoading(false)
          setIsSearching(false)
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [company, supabase, appliedSearch, kind, attempt])

  useEffect(() => {
    // Open ROT/RUT begäran: the manual fallback when the SKV payout got no
    // auto-hint (amount differs from the request, or the row predates the
    // hint). Non-fatal: the invoice list renders either way.
    if (!company || !wantRotRutRequests || isSupplier) return
    const companyId = company.id
    let cancelled = false
    async function loadRotRutRequests() {
      const { requests } = await loadOpenRotRutPayoutRequests(supabase, companyId)
      if (cancelled) return
      setRotRutRequests(requests)
    }
    loadRotRutRequests()
    return () => {
      cancelled = true
    }
  }, [company, supabase, wantRotRutRequests, isSupplier])

  const sorted = useMemo(
    () =>
      // Amount proximity is only meaningful between comparable amounts: ranking
      // a 1 000 EUR invoice as a perfect hit for a 1 000 SEK deposit put the
      // wrong row first. Foreign invoices stay in the list either way; see
      // ./invoice-candidate-ranking. A ticked invoice the search no longer
      // returns stays listed, so it can be unticked.
      rankInvoicesByAmountProximity(
        [...invoices, ...[...pickedInvoices.values()].filter((row) => !invoices.some((i) => i.id === row.id))],
        {
          amount: transaction.amount,
          currency: transaction.currency,
          amountSek: transaction.amount_sek,
        },
      ),
    [invoices, pickedInvoices, transaction.amount, transaction.currency, transaction.amount_sek],
  )

  const invoicePlan = useMemo(
    () =>
      planPickedAllocations(
        transaction.amount,
        [...pickedInvoices.values()].map((row) => ({
          kind: isSupplier ? ('supplier_invoice' as const) : ('customer_invoice' as const),
          id: row.id,
          remaining: Number(row.remaining_amount ?? row.total ?? 0),
          dueDate: row.due_date ?? null,
        })),
      ),
    [pickedInvoices, transaction.amount, isSupplier],
  )

  if (isLoading) {
    return (
      <LateReveal aria-label={isSupplier ? t('loading_supplier') : t('loading')} className="space-y-2 py-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </LateReveal>
    )
  }

  const txAmount = roundOre(transaction.amount)
  // Skatteverket pays out in kronor only; the match route refuses other
  // currencies, so a foreign-currency row must not be offered a begäran.
  const txIsSek = (transaction.currency || 'SEK').toUpperCase() === 'SEK'
  const pickedRequests = rotRutRequests.filter((request) => pickedRequestIds.has(request.id))
  const pickedTotal = roundOre(
    pickedRequests.reduce((sum, request) => sum + expectedRotRutPayoutAmount(request), 0),
  )
  const pickedDiff = roundOre(Math.abs(pickedTotal - txAmount))
  const pickedExact = pickedRequests.length > 0 && pickedDiff < 0.005
  const togglePicked = (id: string, checked: boolean) => {
    setPickedRequestIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }
  // The settle service books a bundle largest first (the matcher's order):
  // hand the manual pick over in the same order so the voucher reads alike.
  const handOverPicked = () => {
    if (!onSelectRotRutPayout || pickedRequests.length === 0) return
    onSelectRotRutPayout(
      [...pickedRequests].sort(
        (a, b) => expectedRotRutPayoutAmount(b) - expectedRotRutPayoutAmount(a),
      ),
    )
  }
  const rotRutSection =
    onSelectRotRutPayout && !isSupplier && txIsSek && rotRutRequests.length > 0 ? (
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">
          {t('rot_rut_section_title')}
        </p>
        {rotRutRequests.map((request) => {
          const expected = expectedRotRutPayoutAmount(request)
          const exact = Math.abs(expected - txAmount) < 0.005
          const picked = pickedRequestIds.has(request.id)
          return (
            <div
              key={request.id}
              className={cn(
                'flex items-stretch rounded-lg transition-colors bg-control shadow-raised',
                exact && 'bg-success/9',
                picked && 'ring-1 ring-foreground/40 bg-secondary/40',
              )}
            >
              <label className="flex cursor-pointer items-center pl-3 pr-1">
                <Checkbox
                  checked={picked}
                  onCheckedChange={(checked) => togglePicked(request.id, checked === true)}
                  aria-label={t('rot_rut_pick_aria', { name: request.name })}
                />
              </label>
              <button
                type="button"
                onClick={() => onSelectRotRutPayout([request])}
                className={cn(
                  'min-w-0 flex-1 rounded-r-lg py-2.5 pl-2 pr-3 text-left transition-colors',
                  'hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <BuildingLibraryIcon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="font-medium text-sm">{request.name}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {t('rot_rut_request_meta', {
                        type: tInvoices(DEDUCTION_TYPE_LABEL_KEYS[request.deduction_type] ?? 'rot_rut_type_rot'),
                        count: request.invoices.length,
                      })}
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className={cn('text-sm font-medium tabular-nums', exact && 'text-success')}>
                      {formatCurrency(expected, DOMESTIC_CURRENCY)}
                    </p>
                    {exact && <p className="text-xs text-success">{t('exact_match')}</p>}
                  </div>
                </div>
              </button>
            </div>
          )
        })}
        {pickedRequests.length > 0 && (
          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="min-w-0 text-xs">
              <p className={cn('tabular-nums', pickedExact ? 'text-success' : 'text-muted-foreground')}>
                {t('rot_rut_picked_sum', {
                  count: pickedRequests.length,
                  amount: formatCurrency(pickedTotal, DOMESTIC_CURRENCY),
                })}
              </p>
              {!pickedExact && (
                <p className="text-attn tabular-nums">
                  {t('rot_rut_picked_diff', { amount: formatCurrency(pickedDiff, DOMESTIC_CURRENCY) })}
                </p>
              )}
            </div>
            <Button type="button" onClick={handOverPicked}>
              {t('rot_rut_match_picked', { count: pickedRequests.length })}
            </Button>
          </div>
        )}
      </div>
    ) : null

  const txCurrency = normalizeCurrency(transaction.currency)
  const invoicePicked = [...pickedInvoices.values()]
  const toggleInvoice = (row: PickerRow, checked: boolean) => {
    setPickedInvoices((prev) => {
      const next = new Map(prev)
      if (checked) next.set(row.id, row)
      else next.delete(row.id)
      return next
    })
  }
  // The batch has no line for a gap: the row must be covered (short) and
  // every ticked invoice must get something (over) before it books.
  const invoiceHandOverBlocked = invoicePlan.outcome === 'short' || invoicePlan.outcome === 'over'
  const gap = formatCurrency(Math.abs(invoicePlan.difference), txCurrency)
  const partialRow = invoicePlan.partiallyPaidId ? pickedInvoices.get(invoicePlan.partiallyPaidId) : undefined
  const invoicePlanLine =
    invoicePlan.outcome === 'exact'
      ? t('invoices_picked_exact')
      : invoicePlan.outcome === 'ore_rounding'
        ? t('invoices_picked_ore_rounding', { amount: gap })
        : invoicePlan.outcome === 'partial'
          ? t('invoices_picked_partial', {
              amount: gap,
              number: (partialRow && rowNumber(partialRow)) ?? t('no_number'),
            })
          : invoicePlan.outcome === 'over'
            ? t('invoices_picked_over', { amount: gap })
            : t('invoices_picked_short', { amount: gap })
  const handOverInvoices = () => {
    if (!onSelectSeveral || invoiceHandOverBlocked || invoicePlan.allocations.length === 0) return
    onSelectSeveral(invoicePlan.allocations)
  }

  if (loadFailed && !hasOpenInvoices) {
    return (
      <div className="space-y-3">
        {rotRutSection}
        <LoadError onRetry={() => setAttempt((n) => n + 1)} />
      </div>
    )
  }

  if (!hasOpenInvoices) {
    return (
      <div className="space-y-3">
        {rotRutSection}
        <EmptyState title={isSupplier ? t('empty_supplier') : t('empty')} />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {rotRutSection}
      <div className="relative">
        {isSearching ? (
          <SpinnerIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        )}
        <Input
          placeholder={isSupplier ? t('search_placeholder_supplier') : t('search_placeholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
          autoFocus
        />
      </div>

      <div className="space-y-1.5 max-h-[55vh] overflow-y-auto pr-1">
        {sorted.map(({ invoice, proximity }) => {
          const remaining = invoice.remaining_amount ?? invoice.total
          const { exact, close, candidateSek } = proximity
          const invoiceCurrency = normalizeCurrency(invoice.currency)
          // The currency earns a marker only when it deviates from the bank
          // row's: the same marker on every row would say nothing (design.md,
          // "chips mark exceptions"). It is what explains why a row is or is
          // not ranked as close.
          const foreignCurrency = proximity.basis !== 'same_currency'
          // The invoice's own status (lib/invoices/status-display.ts or
          // lib/supplier-invoices/status-display.ts), shown only when it
          // deviates; the tone follows its chip.
          // A customer invoice past its due date reads overdue (lib/invoices/overdue.ts).
          const statusDisplay = isSupplier
            ? supplierInvoiceStatusDisplay(invoice.status)
            : invoiceStatusDisplay(effectiveInvoiceStatus(invoice as OpenInvoice))

          // Only invoices in the row's own currency are ticked into one
          // payment: a foreign invoice's share is the SEK the bank took, which
          // the batch dialog in the row's menu asks for.
          const pickable = !!onSelectSeveral && proximity.basis === 'same_currency'
          const picked = pickedInvoices.has(invoice.id)
          const selectRow = () =>
            props.kind === 'supplier'
              ? props.onSelect(invoice as OpenSupplierInvoice)
              : props.onSelect(invoice as OpenInvoice)
          const rowContent = (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <DocumentTextIcon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="font-medium text-sm">
                    {rowNumber(invoice) ?? t('no_number')}
                  </span>
                  {statusDisplay?.chip && (
                    <span className={cn('text-xs', statusChipTextClass(statusDisplay.chip))}>
                      {isSupplier ? tSupplierInvoices(statusDisplay.labelKey) : tInvoices(statusDisplay.labelKey)}
                    </span>
                  )}
                  {foreignCurrency && (
                    <span className="text-xs text-muted-foreground">
                      {invoiceCurrency}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {rowCounterparty(invoice) || (isSupplier ? t('unknown_supplier') : t('unknown_customer'))} ·{' '}
                  {t('due_short', { date: formatDate(invoice.due_date) })}
                </p>
              </div>
              <div className="text-right flex-shrink-0">
                <p
                  className={cn(
                    'text-sm font-medium tabular-nums',
                    exact && 'text-success'
                  )}
                >
                  {formatCurrency(remaining, invoiceCurrency)}
                </p>
                {exact && <p className="text-xs text-success">{t('exact_match')}</p>}
                {candidateSek != null && (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    ≈ {formatCurrency(candidateSek, DOMESTIC_CURRENCY)}
                  </p>
                )}
              </div>
            </div>
          )

          if (!pickable) {
            return (
              <button
                key={invoice.id}
                type="button"
                onClick={selectRow}
                className={cn(
                  'w-full text-left rounded-lg px-3 py-2.5 transition-colors bg-control shadow-raised',
                  'hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  exact && 'bg-success/9',
                  close && 'ring-1 ring-foreground/30'
                )}
              >
                {rowContent}
              </button>
            )
          }

          return (
            <div
              key={invoice.id}
              className={cn(
                'flex items-stretch rounded-lg transition-colors bg-control shadow-raised',
                exact && 'bg-success/9',
                close && 'ring-1 ring-foreground/30',
                picked && 'ring-1 ring-foreground/40 bg-secondary/40',
              )}
            >
              <label className="flex cursor-pointer items-center pl-3 pr-1">
                <Checkbox
                  checked={picked}
                  onCheckedChange={(checked) => toggleInvoice(invoice, checked === true)}
                  aria-label={t('invoice_pick_aria', { number: rowNumber(invoice) ?? t('no_number') })}
                />
              </label>
              <button
                type="button"
                onClick={selectRow}
                className={cn(
                  'min-w-0 flex-1 rounded-r-lg py-2.5 pl-2 pr-3 text-left transition-colors',
                  'hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
              >
                {rowContent}
              </button>
            </div>
          )
        })}
        {sorted.length === 0 &&
          (loadFailed ? (
            <LoadError onRetry={() => setAttempt((n) => n + 1)} />
          ) : (
            // No hits: one muted line in the list.
            <div className="flex flex-wrap items-center gap-x-3 py-3 text-[13px] text-muted-foreground">
              <span data-ph-mask="">{t('no_search_results', { term: appliedSearch })}</span>
              <Button variant="link" onClick={() => setSearch('')}>
                {tCommon('clear_search')}
              </Button>
            </div>
          ))}
        {capped && (
          <p className="text-center text-xs text-muted-foreground py-2">
            {appliedSearch
              ? t('capped_search_hint', { limit: PICKER_LIMIT })
              : t('capped_hint', { limit: PICKER_LIMIT })}
          </p>
        )}
      </div>
      {invoicePicked.length > 0 && (
        <div className="flex items-center justify-between gap-3 border-t pt-3">
          <div className="min-w-0 text-xs">
            <p className="tabular-nums text-muted-foreground">
              {t('invoices_picked_sum', {
                count: invoicePicked.length,
                amount: formatCurrency(invoicePlan.pickedTotal, txCurrency),
              })}
            </p>
            <p
              className={cn(
                'tabular-nums',
                invoicePlan.outcome === 'exact'
                  ? 'text-success'
                  : invoicePlan.outcome === 'ore_rounding'
                    ? 'text-muted-foreground'
                    : 'text-attn',
              )}
            >
              {invoicePlanLine}
            </p>
          </div>
          <Button type="button" onClick={handOverInvoices} disabled={invoiceHandOverBlocked}>
            {t('invoices_match_picked', { count: invoicePicked.length })}
          </Button>
        </div>
      )}
    </div>
  )
}
