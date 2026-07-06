'use client'

import { useState, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/input'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { Search, FileText, Loader2 } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import type { Invoice, Customer } from '@/types'
import type { TransactionWithInvoice } from './transaction-types'

type OpenInvoice = Invoice & { customer?: Customer }

interface InvoicePickerProps {
  transaction: TransactionWithInvoice
  onSelect: (invoice: OpenInvoice) => void
  isProcessing: boolean
}

export default function InvoicePicker({ transaction, onSelect, isProcessing }: InvoicePickerProps) {
  const t = useTranslations('tx_invoice_picker')
  const { company } = useCompany()
  const supabase = useMemo(() => createClient(), [])
  const [invoices, setInvoices] = useState<OpenInvoice[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')

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

      setInvoices(visible)
      setIsLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [company, supabase])

  const sorted = useMemo(() => {
    const txAmount = Math.abs(transaction.amount)
    const filtered = !search
      ? invoices
      : invoices.filter((inv) => {
          const q = search.toLowerCase()
          return (
            (inv.invoice_number ?? '').toLowerCase().includes(q) ||
            (inv.customer?.name ?? '').toLowerCase().includes(q)
          )
        })

    return [...filtered].sort((a, b) => {
      const remainA = a.remaining_amount ?? a.total
      const remainB = b.remaining_amount ?? b.total
      const diffA = Math.abs(remainA - txAmount)
      const diffB = Math.abs(remainB - txAmount)
      if (diffA !== diffB) return diffA - diffB
      return b.invoice_date.localeCompare(a.invoice_date)
    })
  }, [invoices, search, transaction.amount])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        {t('loading')}
      </div>
    )
  }

  if (invoices.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <p className="text-sm">{t('empty')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
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
        {sorted.map((invoice) => {
          const txAmount = Math.abs(transaction.amount)
          const remaining = invoice.remaining_amount ?? invoice.total
          const sameCurrency = transaction.currency === invoice.currency
          const exact = sameCurrency && Math.abs(remaining - txAmount) < 0.01
          const close =
            sameCurrency &&
            !exact &&
            txAmount > 0 &&
            Math.abs(remaining - txAmount) / txAmount < 0.01

          return (
            <button
              key={invoice.id}
              type="button"
              onClick={() => onSelect(invoice)}
              disabled={isProcessing}
              className={cn(
                'w-full text-left rounded-lg border px-3 py-2.5 transition-colors',
                'hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-ring',
                exact && 'border-success/50 bg-success/5',
                close && 'border-primary/30',
                isProcessing && 'opacity-50 pointer-events-none'
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
                      <span className="text-[10px] uppercase tracking-wide text-warning-foreground">
                        {t('status_partially_paid')}
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
                    {formatCurrency(remaining, invoice.currency)}
                  </p>
                  {exact && <p className="text-[10px] text-success">{t('exact_match')}</p>}
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
