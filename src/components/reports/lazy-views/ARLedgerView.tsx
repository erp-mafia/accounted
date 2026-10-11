'use client'

import React, { useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { AccountNumber } from '@/components/ui/account-number'
import {
  ReportEmptyState,
  ReportErrorCard,
  ReportLoadingCard,
  ReskontraToolbar,
} from '@/components/reports/report-view-shared'
import { useReportData } from '@/lib/hooks/use-report-data'
import { formatAmount, formatDate } from '@/lib/utils'
import { formatDateISO } from '@/lib/calendar/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'

// --- AR Ledger (Kundreskontra) ---

interface ARLedgerData {
  ledger: {
    entries: {
      customer_id: string
      customer_name: string
      invoices: {
        invoice_id: string
        invoice_number: string
        invoice_date: string
        due_date: string
        total: number
        paid_amount: number
        outstanding: number
        outstanding_sek: number | null
        days_overdue: number
        currency: string
      }[]
      current: number
      days_1_30: number
      days_31_60: number
      days_61_90: number
      days_90_plus: number
      total_outstanding: number
    }[]
    total_outstanding: number
    total_current: number
    total_overdue: number
    unpaid_count: number
    unconverted_fx_count: number
    register_coverage?: {
      covers_from: string | null
      has_pre_register_invoices: boolean
    }
  }
  reconciliation: {
    ar_ledger_total: number
    account_1510_balance: number
    difference: number
    is_reconciled: boolean
    unconverted_fx_count: number
    pre_register_ar_in_period?: boolean
  } | null
}

// One line of /api/reports/ar-ledger/customer/[id]/invoices.
interface ARCustomerInvoiceLine {
  invoice_id?: string
  journal_entry_id?: string
  voucher_series: string
  voucher_number: number
}

// Inner expansion row component for AR ledger.
// Fetches per-customer invoices (with journal_entry_id) and renders each as a
// link to /bookkeeping/[id] when posted, /invoices/[id] when still draft.
function ARCustomerInvoiceRows({
  customerId,
  invoices,
}: {
  customerId: string
  invoices: {
    invoice_id: string
    invoice_number: string
    invoice_date: string
    due_date: string
    total: number
    paid_amount: number
    outstanding: number
    outstanding_sek: number | null
    days_overdue: number
    currency: string
  }[]
}) {
  // ARCustomerInvoiceRows is mounted lazily: only when a customer is
  // expanded. A failed fetch is silent: the rows still render, without the
  // verifikat link.
  const { data, loading } = useReportData<{ lines?: ARCustomerInvoiceLine[] }>(
    `/api/reports/ar-ledger/customer/${encodeURIComponent(customerId)}/invoices`,
    'Kunde inte hämta verifikat',
  )
  const enriched = useMemo(() => {
    const map: Record<string, { journal_entry_id: string; voucher_series: string; voucher_number: number } | undefined> = {}
    for (const line of data?.lines || []) {
      if (line.invoice_id && line.journal_entry_id) {
        map[line.invoice_id] = {
          journal_entry_id: line.journal_entry_id,
          voucher_series: line.voucher_series,
          voucher_number: line.voucher_number,
        }
      }
    }
    return map
  }, [data])

  return (
    <>
      {invoices.map((inv) => {
        const entry = enriched[inv.invoice_id]
        const targetHref = entry?.journal_entry_id
          ? `/bookkeeping/${entry.journal_entry_id}`
          : `/invoices/${inv.invoice_id}`
        return (
          <tr key={inv.invoice_id} className="bg-muted/30 border-b last:border-0">
            <td></td>
            <td className="py-1 text-xs" colSpan={2}>
              <Link href={targetHref} className="font-mono hover:underline underline-offset-4">
                {inv.invoice_number || '(utkast)'}
              </Link>
              {entry && (
                <span className="ml-2 text-muted-foreground font-mono">
                  {formatVoucher(entry)}
                </span>
              )}
              <span className="text-muted-foreground ml-2 tabular-nums">{formatDate(inv.invoice_date)}</span>
              <span className="text-muted-foreground ml-2 tabular-nums">förfaller {formatDate(inv.due_date)}</span>
            </td>
            <td className="py-1 text-right text-xs text-muted-foreground" colSpan={2}>
              {inv.days_overdue > 0 ? `${inv.days_overdue} dagar förfallen` : 'Ej förfallen'}
            </td>
            <td className="py-1 text-right text-xs text-muted-foreground">
              {inv.paid_amount > 0 ? `Betalt: ${formatAmount(inv.paid_amount)} ${inv.currency}` : ''}
            </td>
            <td></td>
            <td className="py-1 text-right text-xs font-medium tabular-nums">
              {formatAmount(inv.outstanding)} {inv.currency}
            </td>
          </tr>
        )
      })}
      {loading && (
        <tr className="bg-muted/30">
          <td></td>
          <td colSpan={7} className="py-1 text-[11px] text-muted-foreground">Letar verifikat…</td>
        </tr>
      )}
    </>
  )
}

export default function ARLedgerView({ periodId }: { periodId: string }) {
  const [expandedCustomers, setExpandedCustomers] = useState<Set<string>>(new Set())
  const [asOfDate, setAsOfDate] = useState(() => formatDateISO(new Date()))
  const { data, loading, error } = useReportData<ARLedgerData>(
    periodId ? `/api/reports/ar-ledger?period_id=${periodId}&as_of_date=${asOfDate}` : null,
    'Kunde inte hämta kundreskontra',
  )

  const toggleCustomer = (customerId: string) => {
    setExpandedCustomers((prev) => {
      const next = new Set(prev)
      if (next.has(customerId)) {
        next.delete(customerId)
      } else {
        next.add(customerId)
      }
      return next
    })
  }

  if (loading) {
    return <ReportLoadingCard />
  }

  if (error) {
    return <ReportErrorCard message={error} />
  }

  if (!data || !data.ledger) {
    return (
      <ReportEmptyState
        title="Ingen kundreskontra"
        description="Det finns inga kundfakturor att visa för den valda perioden."
      />
    )
  }

  const { ledger, reconciliation } = data

  return (
    <div className="space-y-4">
      <ReskontraToolbar
        asOfDate={asOfDate}
        onAsOfDateChange={setAsOfDate}
        inputId="ar-ledger-as-of"
        exportBase="/api/reports/ar-ledger"
      />
      {/* Summary cards */}
      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Totalt utestående</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl tabular-nums">{formatAmount(ledger.total_outstanding)} kr</p>
            <p className="text-xs text-muted-foreground">{ledger.unpaid_count} fakturor</p>
            {ledger.unconverted_fx_count > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {ledger.unconverted_fx_count} faktura i utländsk valuta utan växelkurs är inte med i totalen.
              </p>
            )}
            {ledger.register_coverage?.has_pre_register_invoices && ledger.register_coverage.covers_from && (
              <p className="mt-1 text-xs text-muted-foreground">
                Fakturor före {formatDate(ledger.register_coverage.covers_from)} kan ligga som bokförda verifikat och ingår inte i reskontran.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Ej förfallet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl tabular-nums text-success">{formatAmount(ledger.total_current)} kr</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Förfallet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl tabular-nums text-destructive">{formatAmount(ledger.total_overdue)} kr</p>
          </CardContent>
        </Card>
      </div>

      {/* Aging table with expandable invoice details */}
      {ledger.entries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Ålderfördelning per kund</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto -mx-2 px-2"><table className="w-full text-sm min-w-[500px]">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-2 w-8"></th>
                  <th className="py-2">Kund</th>
                  <th className="py-2 text-right">Ej förfallet</th>
                  <th className="py-2 text-right">1-30 dagar</th>
                  <th className="py-2 text-right">31-60 dagar</th>
                  <th className="py-2 text-right">61-90 dagar</th>
                  <th className="py-2 text-right">90+ dagar</th>
                  <th className="py-2 text-right font-semibold">Totalt</th>
                </tr>
              </thead>
              <tbody>
                {ledger.entries.map((entry) => {
                  const isExpanded = expandedCustomers.has(entry.customer_id)
                  return (
                    <React.Fragment key={entry.customer_id}>
                      <tr
                        className="border-b cursor-pointer hover:bg-secondary/35"
                        onClick={() => toggleCustomer(entry.customer_id)}
                      >
                        <td className="py-2">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </td>
                        <td className="py-2">{entry.customer_name}</td>
                        <td className="py-2 text-right">{entry.current > 0 ? formatAmount(entry.current) : ''}</td>
                        <td className="py-2 text-right">{entry.days_1_30 > 0 ? formatAmount(entry.days_1_30) : ''}</td>
                        <td className="py-2 text-right">{entry.days_31_60 > 0 ? formatAmount(entry.days_31_60) : ''}</td>
                        <td className="py-2 text-right">{entry.days_61_90 > 0 ? formatAmount(entry.days_61_90) : ''}</td>
                        <td className="py-2 text-right text-destructive">{entry.days_90_plus > 0 ? formatAmount(entry.days_90_plus) : ''}</td>
                        <td className="py-2 text-right font-semibold">{formatAmount(entry.total_outstanding)}</td>
                      </tr>
                      {isExpanded && (
                        <ARCustomerInvoiceRows
                          customerId={entry.customer_id}
                          invoices={entry.invoices}
                        />
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="font-semibold border-t-2">
                  <td className="py-2"></td>
                  <td className="py-2">Summa</td>
                  <td className="py-2 text-right">{formatAmount(ledger.entries.reduce((s, e) => s + e.current, 0))}</td>
                  <td className="py-2 text-right">{formatAmount(ledger.entries.reduce((s, e) => s + e.days_1_30, 0))}</td>
                  <td className="py-2 text-right">{formatAmount(ledger.entries.reduce((s, e) => s + e.days_31_60, 0))}</td>
                  <td className="py-2 text-right">{formatAmount(ledger.entries.reduce((s, e) => s + e.days_61_90, 0))}</td>
                  <td className="py-2 text-right text-destructive">{formatAmount(ledger.entries.reduce((s, e) => s + e.days_90_plus, 0))}</td>
                  <td className="py-2 text-right">{formatAmount(ledger.total_outstanding)}</td>
                </tr>
              </tfoot>
            </table></div>
          </CardContent>
        </Card>
      )}

      {/* Reconciliation */}
      {reconciliation && (
        <Card>
          <CardHeader>
            <CardTitle>Avstämning mot <AccountNumber number="1510" /></CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Kundreskontra (summa utestående)</span>
                <span className="tabular-nums">{formatAmount(reconciliation.ar_ledger_total)} kr</span>
              </div>
              <div className="flex justify-between">
                <span>Kundfordringar (<AccountNumber number="1510" /> + <AccountNumber number="1513" />) saldo</span>
                <span className="tabular-nums">{formatAmount(reconciliation.account_1510_balance)} kr</span>
              </div>
              <div className="flex justify-between pt-2 border-t font-semibold">
                <span>Differens</span>
                <span className={`tabular-nums ${reconciliation.is_reconciled ? 'text-success' : 'text-destructive'}`}>
                  {formatAmount(reconciliation.difference)} kr
                </span>
              </div>
              <div className="pt-2 space-y-2">
                {reconciliation.is_reconciled ? (
                  <span className="text-sm text-muted-foreground">Avstämd</span>
                ) : (
                  <Badge variant="destructive">Ej avstämd - kontrollera bokföring</Badge>
                )}
                {reconciliation.unconverted_fx_count > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {reconciliation.unconverted_fx_count} kundfaktura i utländsk valuta saknar växelkurs: differensen kan bero på saknade kursuppgifter snarare än felbokning.
                  </p>
                )}
                {/* Only when pre-register AR debits exist IN the reconciled
                    period: prior-period migration history contributes nothing
                    to this period's balance, and offering it as an explanation
                    there would cushion a genuine felbokning. */}
                {!reconciliation.is_reconciled &&
                  reconciliation.pre_register_ar_in_period &&
                  ledger.register_coverage?.covers_from && (
                    <p className="text-xs text-muted-foreground">
                      Perioden innehåller verifikat med kundfordringar före {formatDate(ledger.register_coverage.covers_from)} som inte ligger i fakturaregistret (t.ex. efter en migrering): differensen kan bero på det. Kontrollera huvudboken på <AccountNumber number="1510" /> och <AccountNumber number="1513" /> innan du letar felbokning.
                    </p>
                  )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
