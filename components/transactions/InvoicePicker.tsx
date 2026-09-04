'use client'

import { useState, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/input'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import { Search, FileText, Loader2, Landmark } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import type { Invoice, Customer } from '@/types'
import type { PotentialRotRutPayout, TransactionWithInvoice } from './transaction-types'
import {
  DOMESTIC_CURRENCY,
  normalizeCurrency,
  rankInvoicesByAmountProximity,
} from './invoice-candidate-ranking'
import {
  expectedRotRutPayoutAmount,
  OPEN_ROT_RUT_PAYOUT_STATUSES,
} from '@/lib/invoices/rot-rut-payout-matching'

type OpenInvoice = Invoice & { customer?: Customer }

interface InvoicePickerProps {
  transaction: TransactionWithInvoice
  onSelect: (invoice: OpenInvoice) => void
  /** Pick an open ROT/RUT begäran instead of an invoice (Skatteverkets
   *  utbetalning). The section only renders when the company has one. */
  onSelectRotRutPayout?: (request: PotentialRotRutPayout) => void
}

type RotRutRequestRow = {
  id: string
  name: string
  deduction_type: 'rot' | 'rut'
  status: string
  requested_total: number | string
  decided_total: number | string | null
  settlement_journal_entry_id: string | null
  items?: Array<{
    requested_amount: number | string
    invoice?: { invoice_number: string | null } | { invoice_number: string | null }[] | null
  }> | null
}

export default function InvoicePicker({ transaction, onSelect, onSelectRotRutPayout }: InvoicePickerProps) {
  const t = useTranslations('tx_invoice_picker')
  const { company } = useCompany()
  const supabase = useMemo(() => createClient(), [])
  const [invoices, setInvoices] = useState<OpenInvoice[]>([])
  const [rotRutRequests, setRotRutRequests] = useState<PotentialRotRutPayout[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')
  // Boolean, not the callback: a fresh function identity per parent render
  // must not refetch the list.
  const wantRotRutRequests = !!onSelectRotRutPayout

  useEffect(() => {
    if (!company) return
    // Capture the company id once so the async closure below never
    // dereferences a `company` that has flipped to null between renders.
    // The earlier non-null assertions allowed a stale render to query
    // against an undefined company_id; pinning the value avoids that.
    const companyId = company.id
    let cancelled = false
    async function load() {
      setIsLoading(true)
      // Filter out fully-settled invoices defensively: match-invoice should
      // flip status to 'paid' on full settlement, but a stale 'sent'/'overdue'
      // row with remaining_amount=0 would otherwise be selectable here and
      // could be matched a second time, double-booking the income.
      // Also exclude proformas (PF- series): proforma is not a faktura per
      // ML 17 kap 24§, has no VAT obligation, and must never be matched
      // against a bank receipt or trigger a verifikation.
      const { data } = await supabase
        .from('invoices')
        .select('*, customer:customers(*)')
        .eq('company_id', companyId)
        .eq('document_type', 'invoice')
        .is('credited_invoice_id', null)
        .in('status', ['sent', 'overdue', 'partially_paid'])
        .gt('remaining_amount', 0)
        .order('invoice_date', { ascending: false })
        .limit(200)
      if (cancelled) return
      const all = (data as OpenInvoice[]) || []

      // Status-leak guard: if an invoice still says 'sent'/'overdue' but
      // already has a payment voucher attached (manual or system), hide it.
      // Partially-paid invoices intentionally pass through: they may take
      // more payments. Mirrors the server-side filter in findMatchingInvoices.
      const fullIds = all
        .filter((inv) => inv.status === 'sent' || inv.status === 'overdue')
        .map((inv) => inv.id)
      let visible = all
      if (fullIds.length > 0) {
        const { data: paid } = await supabase
          .from('invoice_payments')
          .select('invoice_id')
          .eq('company_id', companyId)
          .in('invoice_id', fullIds)
          .not('journal_entry_id', 'is', null)
        if (cancelled) return
        const paidSet = new Set<string>(
          ((paid as { invoice_id: string }[] | null) ?? []).map((r) => r.invoice_id),
        )
        visible = all.filter((inv) => !paidSet.has(inv.id))
      }

      // Open ROT/RUT begäran: the manual fallback when the SKV payout got no
      // auto-hint (amount differs from the request, or the row predates the
      // hint). Non-fatal: the invoice list renders either way.
      if (wantRotRutRequests) {
        const { data: requests } = await supabase
          .from('rot_rut_payout_requests')
          .select(
            'id, name, deduction_type, status, requested_total, decided_total, settlement_journal_entry_id, items:rot_rut_payout_request_items(requested_amount, invoice:invoices(invoice_number))',
          )
          .eq('company_id', companyId)
          .in('status', [...OPEN_ROT_RUT_PAYOUT_STATUSES])
          .is('settlement_journal_entry_id', null)
          .order('created_at', { ascending: false })
        if (cancelled) return
        setRotRutRequests(
          ((requests as RotRutRequestRow[] | null) ?? []).map((req) => ({
            id: req.id,
            name: req.name,
            deduction_type: req.deduction_type,
            status: req.status,
            requested_total: req.requested_total,
            decided_total: req.decided_total,
            settlement_journal_entry_id: req.settlement_journal_entry_id,
            invoices: (req.items ?? []).map((item) => {
              const inv = Array.isArray(item.invoice) ? item.invoice[0] : item.invoice
              return { invoice_number: inv?.invoice_number ?? null, requested_amount: item.requested_amount }
            }),
          })),
        )
      }

      setInvoices(visible)
      setIsLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [company, supabase, wantRotRutRequests])

  const sorted = useMemo(() => {
    const filtered = !search
      ? invoices
      : invoices.filter((inv) => {
          const q = search.toLowerCase()
          return (
            (inv.invoice_number ?? '').toLowerCase().includes(q) ||
            (inv.customer?.name ?? '').toLowerCase().includes(q)
          )
        })

    // Amount proximity is only meaningful between comparable amounts: ranking
    // a 1 000 EUR invoice as a perfect hit for a 1 000 SEK deposit put the
    // wrong row first. Foreign invoices stay in the list either way; see
    // ./invoice-candidate-ranking.
    return rankInvoicesByAmountProximity(filtered, {
      amount: transaction.amount,
      currency: transaction.currency,
      amountSek: transaction.amount_sek,
    })
  }, [invoices, search, transaction.amount, transaction.currency, transaction.amount_sek])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        {t('loading')}
      </div>
    )
  }

  const txAmount = roundOre(transaction.amount)
  // Skatteverket pays out in kronor only; the match route refuses other
  // currencies, so a foreign-currency row must not be offered a begäran.
  const txIsSek = (transaction.currency || 'SEK').toUpperCase() === 'SEK'
  const rotRutSection =
    onSelectRotRutPayout && txIsSek && rotRutRequests.length > 0 ? (
      <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('rot_rut_section_title')}
        </p>
        {rotRutRequests.map((request) => {
          const expected = expectedRotRutPayoutAmount(request)
          const exact = Math.abs(expected - txAmount) < 0.005
          return (
            <button
              key={request.id}
              type="button"
              onClick={() => onSelectRotRutPayout(request)}
              className={cn(
                'w-full text-left rounded-lg border px-3 py-2.5 transition-colors',
                'hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-ring',
                exact && 'border-success/50 bg-success/5',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Landmark className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="font-medium text-sm">{request.name}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {t('rot_rut_request_meta', {
                      type: request.deduction_type === 'rut' ? 'RUT' : 'ROT',
                      count: request.invoices.length,
                    })}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className={cn('text-sm font-medium tabular-nums', exact && 'text-success')}>
                    {formatCurrency(expected, DOMESTIC_CURRENCY)}
                  </p>
                  {exact && <p className="text-[10px] text-success">{t('exact_match')}</p>}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    ) : null

  if (invoices.length === 0) {
    return (
      <div className="space-y-3">
        {rotRutSection}
        <div className="text-center py-8 text-muted-foreground">
          <p className="text-sm">{t('empty')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {rotRutSection}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('search_placeholder')}
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
                'hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-ring',
                exact && 'border-success/50 bg-success/5',
                close && 'border-primary/30'
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="font-medium text-sm">
                      {invoice.invoice_number ?? t('no_number')}
                    </span>
                    {invoice.status === 'overdue' && (
                      <span className="text-[10px] uppercase tracking-wide text-destructive">
                        {t('status_overdue')}
                      </span>
                    )}
                    {invoice.status === 'partially_paid' && (
                      <span className="text-[10px] uppercase tracking-wide text-attn">
                        {t('status_partially_paid')}
                      </span>
                    )}
                    {foreignCurrency && (
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {invoiceCurrency}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {invoice.customer?.name || t('unknown_customer')} · {t('due_short', { date: formatDate(invoice.due_date) })}
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
                  {exact && <p className="text-[10px] text-success">{t('exact_match')}</p>}
                  {candidateSek != null && (
                    <p className="text-[10px] text-muted-foreground tabular-nums">
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
            {t('no_search_results', { term: search })}
          </p>
        )}
      </div>
    </div>
  )
}
