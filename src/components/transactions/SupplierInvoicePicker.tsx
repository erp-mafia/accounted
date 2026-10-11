'use client'

import { useState, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/input'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { Search, FileText, Loader2 } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import type { SupplierInvoice, Supplier } from '@/types'
import type { TransactionWithInvoice } from './transaction-types'
import {
  DOMESTIC_CURRENCY,
  normalizeCurrency,
  rankInvoicesByAmountProximity,
} from './invoice-candidate-ranking'
import { PICKER_LIMIT, searchOpenSupplierInvoices } from '@/lib/invoices/open-invoice-search'

/** Pause after the last keystroke before the search goes to the database. */
const SEARCH_DEBOUNCE_MS = 250

type OpenSupplierInvoice = SupplierInvoice & { supplier?: Supplier }

interface SupplierInvoicePickerProps {
  transaction: TransactionWithInvoice
  onSelect: (invoice: OpenSupplierInvoice) => void
}

export default function SupplierInvoicePicker({
  transaction,
  onSelect,
}: SupplierInvoicePickerProps) {
  const t = useTranslations('tx_invoice_picker')
  const { company } = useCompany()
  const supabase = useMemo(() => createClient(), [])
  // Rows for the applied search term (the newest open invoices without one).
  const [invoices, setInvoices] = useState<OpenSupplierInvoice[]>([])
  // Whether the request came back full: older rows exist past the limit.
  const [capped, setCapped] = useState(false)
  // Whether the company has any open supplier invoice at all (the unsearched
  // load): decides between the empty state and the search box.
  const [hasOpenInvoices, setHasOpenInvoices] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isSearching, setIsSearching] = useState(false)
  const [search, setSearch] = useState('')
  // The term the database was asked for, trailing the input by a short pause.
  const [appliedSearch, setAppliedSearch] = useState('')

  useEffect(() => {
    const handle = setTimeout(() => setAppliedSearch(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [search])

  useEffect(() => {
    if (!company) return
    const companyId = company.id
    let cancelled = false
    async function load() {
      if (appliedSearch) setIsSearching(true)
      else setIsLoading(true)
      try {
        // The search runs in the database across every open supplier invoice:
        // the newest-first list is capped, so filtering it here could never
        // find an older one. The status filter (approved/overdue/
        // partially_paid, the ones that can take a payment) lives there too
        // (lib/invoices/open-invoice-search).
        const all = await searchOpenSupplierInvoices<OpenSupplierInvoice>(supabase, companyId, appliedSearch)
        if (cancelled) return

        // Status-leak guard: if a supplier invoice still says 'approved'/'overdue'
        // but already has a payment voucher attached, hide it. Partially-paid
        // invoices intentionally pass through: they may take more payments.
        // Mirrors the customer-side guard in InvoicePicker.
        const fullIds = all
          .filter((inv) => inv.status === 'approved' || inv.status === 'overdue')
          .map((inv) => inv.id)
        let visible = all
        if (fullIds.length > 0) {
          const { data: paid } = await supabase
            .from('supplier_invoice_payments')
            .select('supplier_invoice_id')
            .eq('company_id', companyId)
            .in('supplier_invoice_id', fullIds)
            .not('journal_entry_id', 'is', null)
          if (cancelled) return
          const paidSet = new Set<string>(
            ((paid as { supplier_invoice_id: string }[] | null) ?? []).map(
              (r) => r.supplier_invoice_id,
            ),
          )
          visible = all.filter((inv) => !paidSet.has(inv.id))
        }

        setInvoices(visible)
        setCapped(all.length >= PICKER_LIMIT)
        if (!appliedSearch) setHasOpenInvoices(visible.length > 0)
      } catch {
        if (cancelled) return
        setInvoices([])
        setCapped(false)
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
  }, [company, supabase, appliedSearch])

  const sorted = useMemo(
    () =>
      // Amount proximity is only meaningful between comparable amounts: ranking
      // a 1 000 EUR invoice as a perfect hit for a 1 000 SEK payment put the
      // wrong row first. Foreign invoices stay in the list either way; see
      // ./invoice-candidate-ranking.
      rankInvoicesByAmountProximity(invoices, {
        amount: transaction.amount,
        currency: transaction.currency,
        amountSek: transaction.amount_sek,
      }),
    [invoices, transaction.amount, transaction.currency, transaction.amount_sek],
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Laddar leverantörsfakturor...
      </div>
    )
  }

  if (!hasOpenInvoices) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <p className="text-sm">Inga öppna leverantörsfakturor att matcha mot.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        {isSearching ? (
          <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        )}
        <Input
          placeholder="Sök fakturanummer eller leverantör..."
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

          return (
            <button
              key={invoice.id}
              type="button"
              onClick={() => onSelect(invoice)}
              className={cn(
                'w-full text-left rounded-lg border px-3 py-2.5 transition-colors',
                'hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                exact && 'border-success/50 bg-success/5',
                close && 'border-primary/30'
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="font-medium text-sm">
                      {invoice.supplier_invoice_number ?? '(utan nummer)'}
                    </span>
                    {invoice.status === 'overdue' && (
                      <span className="text-[11px] uppercase tracking-wide text-destructive">
                        Förfallen
                      </span>
                    )}
                    {invoice.status === 'partially_paid' && (
                      <span className="text-[11px] uppercase tracking-wide text-attn">
                        Delbetald
                      </span>
                    )}
                    {foreignCurrency && (
                      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        {invoiceCurrency}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {invoice.supplier?.name || 'Okänd leverantör'} · Förfaller{' '}
                    {formatDate(invoice.due_date)}
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
                  {exact && <p className="text-[11px] text-success">Exakt match</p>}
                  {candidateSek != null && (
                    <p className="text-[11px] text-muted-foreground tabular-nums">
                      ≈ {formatCurrency(candidateSek, DOMESTIC_CURRENCY)}
                    </p>
                  )}
                </div>
              </div>
            </button>
          )
        })}
        {sorted.length === 0 && (
          <p className="text-center text-sm text-muted-foreground py-4">
            Ingen faktura matchar &quot;{appliedSearch}&quot;
          </p>
        )}
        {capped && (
          <p className="text-center text-xs text-muted-foreground py-2">
            {appliedSearch
              ? t('capped_search_hint', { limit: PICKER_LIMIT })
              : t('capped_hint', { limit: PICKER_LIMIT })}
          </p>
        )}
      </div>
    </div>
  )
}
