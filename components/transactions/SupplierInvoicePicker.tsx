'use client'

import { useState, useEffect, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/input'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { Search, FileText, Loader2 } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import type { SupplierInvoice, Supplier } from '@/types'
import type { TransactionWithInvoice } from './transaction-types'

type OpenSupplierInvoice = SupplierInvoice & { supplier?: Supplier }

interface SupplierInvoicePickerProps {
  transaction: TransactionWithInvoice
  onSelect: (invoice: OpenSupplierInvoice) => void
  isProcessing: boolean
}

export default function SupplierInvoicePicker({
  transaction,
  onSelect,
  isProcessing,
}: SupplierInvoicePickerProps) {
  const { company } = useCompany()
  const supabase = useMemo(() => createClient(), [])
  const [invoices, setInvoices] = useState<OpenSupplierInvoice[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!company) return
    const companyId = company.id
    let cancelled = false
    async function load() {
      setIsLoading(true)
      // Status filter mirrors match-supplier-invoice route expectations: only
      // approved/overdue/partially_paid invoices can take a payment. Registered
      // invoices haven't passed the approval gate yet; paid/credited/reversed
      // are terminal.
      const { data } = await supabase
        .from('supplier_invoices')
        .select('*, supplier:suppliers(*)')
        .eq('company_id', companyId)
        .in('status', ['approved', 'overdue', 'partially_paid'])
        .gt('remaining_amount', 0)
        .order('invoice_date', { ascending: false })
        .limit(200)
      if (cancelled) return
      const all = ((data as OpenSupplierInvoice[]) || [])

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
            (inv.supplier_invoice_number ?? '').toLowerCase().includes(q) ||
            (inv.supplier?.name ?? '').toLowerCase().includes(q)
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
        Laddar leverantörsfakturor...
      </div>
    )
  }

  if (invoices.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <p className="text-sm">Inga öppna leverantörsfakturor att matcha mot.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Sök fakturanummer eller leverantör..."
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
                      {invoice.supplier_invoice_number ?? '(utan nummer)'}
                    </span>
                    {invoice.status === 'overdue' && (
                      <span className="text-[10px] uppercase tracking-wide text-destructive">
                        Förfallen
                      </span>
                    )}
                    {invoice.status === 'partially_paid' && (
                      <span className="text-[10px] uppercase tracking-wide text-warning-foreground">
                        Delbetald
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
                    {formatCurrency(remaining, invoice.currency)}
                  </p>
                  {exact && <p className="text-[10px] text-success">Exakt match</p>}
                </div>
              </div>
            </button>
          )
        })}
        {sorted.length === 0 && (
          <p className="text-center text-sm text-muted-foreground py-4">
            Ingen faktura matchar &quot;{search}&quot;
          </p>
        )}
      </div>
    </div>
  )
}
