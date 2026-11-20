'use client'

import React, { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { AccountNumber } from '@/components/ui/account-number'
import { useReportRowExpansion } from '@/components/reports/ReportRowExpansion'
import {
  ReportEmptyState,
  ReportLoadingCard,
  ReskontraErrorCard,
  ReskontraToolbar,
  agingCell,
} from '@/components/reports/report-view-shared'
import { useReportData } from '@/lib/hooks/use-report-data'
import { formatAmount, formatDate } from '@/lib/utils'
import type { ReportSourceLine, ReportSourceFetcher } from '@/lib/reports/source-lines'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { todayIsoStockholm } from '@/lib/dates/iso'

interface SupplierLedgerData {
  ledger: {
    entries: {
      supplier_id: string
      supplier_name: string
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
  }
  reconciliation: {
    supplier_ledger_total: number
    as_of_date: string | null
    account_2440_balance: number
    difference: number
    is_reconciled: boolean
    unconverted_fx_count: number
  } | null
}

export default function SupplierLedgerView({ periodId }: { periodId: string }) {
  const [asOfDate, setAsOfDate] = useState(() => todayIsoStockholm())
  const { data, loading, error, refetch } = useReportData<SupplierLedgerData>(
    periodId ? `/api/reports/supplier-ledger?period_id=${periodId}&as_of_date=${asOfDate}` : null,
    'Kunde inte hämta leverantörsreskontra',
  )

  if (loading) {
    return <ReportLoadingCard />
  }

  if (error) {
    return <ReskontraErrorCard message={error} onRetry={refetch} asOfDate={asOfDate} onAsOfDateChange={setAsOfDate} inputId="supplier-ledger-as-of" exportBase="/api/reports/supplier-ledger" />
  }

  if (!data || !data.ledger) {
    return (
      <ReportEmptyState
        title="Ingen leverantörsreskontra"
        description="Det finns inga leverantörsfakturor att visa för den valda perioden."
      />
    )
  }

  const { ledger, reconciliation } = data

  return (
    <div className="space-y-4">
      <ReskontraToolbar
        asOfDate={asOfDate}
        onAsOfDateChange={setAsOfDate}
        inputId="supplier-ledger-as-of"
        exportBase="/api/reports/supplier-ledger"
      />
      {/* Summary cards */}
      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
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
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Ej förfallet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl tabular-nums text-success">{formatAmount(ledger.total_current)} kr</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Förfallet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl tabular-nums text-destructive">{formatAmount(ledger.total_overdue)} kr</p>
          </CardContent>
        </Card>
      </div>

      {/* Aging table */}
      {ledger.entries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Ålderfördelning per leverantör</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto -mx-2 px-2"><table className="w-full text-sm tabular-nums min-w-[500px]">
              <thead className="[&_th]:font-medium [&_th]:text-xs [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-2 w-8"></th>
                  <th className="py-2">Leverantör</th>
                  <th className="py-2 text-right">Ej förfallet</th>
                  <th className="py-2 text-right">1-30 dagar</th>
                  <th className="py-2 text-right">31-60 dagar</th>
                  <th className="py-2 text-right">61-90 dagar</th>
                  <th className="py-2 text-right">90+ dagar</th>
                  <th className="py-2 text-right font-semibold">Totalt</th>
                </tr>
              </thead>
              <tbody>
                {ledger.entries.map((entry) => (
                  <SupplierLedgerRow key={entry.supplier_id} entry={entry} />
                ))}
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
            <CardTitle>Avstämning mot <AccountNumber number="2440" /></CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Leverantörsreskontra (summa utestående){reconciliation.as_of_date && ` ${formatDate(reconciliation.as_of_date)}`}</span>
                <span className="tabular-nums">{formatAmount(reconciliation.supplier_ledger_total)} kr</span>
              </div>
              <div className="flex justify-between">
                <span><AccountNumber number="2440" /> saldo (huvudbok)</span>
                <span className="tabular-nums">{formatAmount(reconciliation.account_2440_balance)} kr</span>
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
                    {reconciliation.unconverted_fx_count} leverantörsfaktura i utländsk valuta saknar växelkurs: differensen kan bero på saknade kursuppgifter snarare än felbokning.
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

function makeSupplierFetcher(supplierId: string): ReportSourceFetcher {
  return async () => {
    const res = await fetch(
      `/api/reports/supplier-ledger/supplier/${encodeURIComponent(supplierId)}/invoices`
    )
    const json = await res.json()
    if (!res.ok) throw new Error(getErrorMessage(json, { fallback: 'Kunde inte hämta leverantörsfakturor' }))
    const lines: ReportSourceLine[] = json.data?.lines || []
    return { lines, next_cursor: json.data?.next_cursor ?? null }
  }
}

function SupplierLedgerRow({
  entry,
}: {
  entry: {
    supplier_id: string
    supplier_name: string
    current: number
    days_1_30: number
    days_31_60: number
    days_61_90: number
    days_90_plus: number
    total_outstanding: number
  }
}) {
  const fetcher = React.useMemo(
    () => makeSupplierFetcher(entry.supplier_id),
    [entry.supplier_id]
  )
  const { toggle, panel } = useReportRowExpansion(fetcher, `sup-${entry.supplier_id}`)
  return (
    <>
      <tr className="border-b last:border-0 hover:bg-secondary/35 transition-colors">
        <td className="py-2">{toggle}</td>
        <td className="py-2">{entry.supplier_name}</td>
        <td className="py-2 text-right tabular-nums">{agingCell(entry.current)}</td>
        <td className="py-2 text-right tabular-nums">{agingCell(entry.days_1_30)}</td>
        <td className="py-2 text-right tabular-nums">{agingCell(entry.days_31_60)}</td>
        <td className="py-2 text-right tabular-nums">{agingCell(entry.days_61_90)}</td>
        <td className="py-2 text-right tabular-nums text-destructive">{agingCell(entry.days_90_plus)}</td>
        <td className="py-2 text-right tabular-nums font-semibold">{formatAmount(entry.total_outstanding)}</td>
      </tr>
      {panel(8)}
    </>
  )
}
