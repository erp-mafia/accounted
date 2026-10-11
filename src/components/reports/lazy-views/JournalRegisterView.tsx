'use client'

import React, { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { AccountNumber } from '@/components/ui/account-number'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import {
  ReportEmptyState,
  ReportErrorCard,
  ReportLoadingCard,
} from '@/components/reports/report-view-shared'
import { useReportData } from '@/lib/hooks/use-report-data'
import { formatAmount, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'

// --- Journal Register (Grundbok) ---

interface JournalRegisterData {
  entries: {
    voucher_series: string
    voucher_number: number
    date: string
    description: string
    source_type: string
    status: string
    lines: {
      account_number: string
      account_name: string
      debit: number
      credit: number
    }[]
    total_debit: number
    total_credit: number
  }[]
  total_entries: number
  total_debit: number
  total_credit: number
  period: { start: string; end: string }
}

const NO_ENTRIES: ReadonlySet<number> = new Set()

export default function JournalRegisterView({ periodId }: { periodId: string }) {
  const { data, loading, error } = useReportData<JournalRegisterData>(
    periodId ? `/api/reports/journal-register?period_id=${periodId}` : null,
    'Kunde inte hämta grundbok',
  )
  // Expanded rows are indexes into one period's entries: another period
  // opens collapsed.
  const [expanded, setExpanded] = useState<{ periodId: string; entries: ReadonlySet<number> }>(
    () => ({ periodId, entries: NO_ENTRIES }),
  )
  const expandedEntries = expanded.periodId === periodId ? expanded.entries : NO_ENTRIES

  const toggleEntry = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev.periodId === periodId ? prev.entries : NO_ENTRIES)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return { periodId, entries: next }
    })
  }

  if (loading) {
    return <ReportLoadingCard />
  }

  if (error) {
    return <ReportErrorCard message={error} />
  }

  if (!data || data.entries.length === 0) {
    return (
      <ReportEmptyState
        title="Inga verifikationer i perioden"
        description="Det finns inga bokförda verifikationer i den valda perioden."
      />
    )
  }

  return (
    <div className="space-y-4">
      <ReportExportMenu items={[{ format: 'xlsx', href: `/api/reports/journal-register/xlsx?period_id=${periodId}` }]} />
      {data.period.start && (
        <p className="text-sm text-muted-foreground tabular-nums">
          Period {data.period.start} till {data.period.end} · {data.total_entries} verifikationer
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Grundbok (registreringsordning)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto -mx-2 px-2"><table className="w-full text-sm min-w-[500px]">
            <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
              <tr className="border-b text-left">
                <th className="py-2 w-8"></th>
                <th className="py-2 w-16">Ver.nr</th>
                <th className="py-2 w-24">Datum</th>
                <th className="py-2">Beskrivning</th>
                <th className="py-2 w-24">Typ</th>
                <th className="py-2 w-24 text-right">Debet</th>
                <th className="py-2 w-24 text-right">Kredit</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry, index) => {
                const isExpanded = expandedEntries.has(index)
                const isReversed = entry.status === 'reversed'

                return (
                  <React.Fragment key={index}>
                    <tr
                      className={`border-b cursor-pointer hover:bg-secondary/35 ${isReversed ? 'line-through opacity-60' : ''}`}
                      onClick={() => toggleEntry(index)}
                    >
                      <td className="py-2">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </td>
                      <td className="py-2 font-mono text-xs">
                        {formatVoucher(entry)}
                      </td>
                      <td className="py-2">{formatDate(entry.date)}</td>
                      <td className="py-2">
                        {entry.description}
                        {isReversed && (
                          <Badge variant="outline" className="ml-2 text-xs">Makulerad</Badge>
                        )}
                      </td>
                      <td className="py-2 text-xs text-muted-foreground">{entry.source_type}</td>
                      <td className="py-2 text-right tabular-nums">{formatAmount(entry.total_debit)}</td>
                      <td className="py-2 text-right tabular-nums">{formatAmount(entry.total_credit)}</td>
                    </tr>
                    {isExpanded && entry.lines.map((line, lineIndex) => (
                      <tr key={`${index}-${lineIndex}`} className="bg-muted/30 border-b last:border-0">
                        <td></td>
                        <td></td>
                        <td className="py-1"><AccountNumber number={line.account_number} name={line.account_name} size="sm" /></td>
                        <td className="py-1 text-muted-foreground">{line.account_name}</td>
                        <td></td>
                        <td className="py-1 text-right">
                          {line.debit > 0 ? formatAmount(line.debit) : ''}
                        </td>
                        <td className="py-1 text-right">
                          {line.credit > 0 ? formatAmount(line.credit) : ''}
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="font-semibold border-t-2">
                <td colSpan={5} className="py-2">Summa</td>
                <td className="py-2 text-right">{formatAmount(data.total_debit)}</td>
                <td className="py-2 text-right">{formatAmount(data.total_credit)}</td>
              </tr>
            </tfoot>
          </table></div>
        </CardContent>
      </Card>
    </div>
  )
}
