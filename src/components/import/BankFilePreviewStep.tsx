'use client'

import { useTranslations } from 'next-intl'
import { ImportNotices } from '@/components/import/ImportNotices'
import { ImportStatRow } from '@/components/import/ImportStatRow'
import { makeNotice, noticesFromParseIssues } from '@/lib/import/notices'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
} from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { summarizeByCurrency } from '@/lib/import/bank-file/currency-summary'
import type { BankFileParseResult, BankFileDuplicateInfo } from '@/lib/import/bank-file/types'

interface BankFilePreviewStepProps {
  parseResult: BankFileParseResult
  duplicateInfo?: BankFileDuplicateInfo | null
  onContinue: () => void
  onBack: () => void
}

export default function BankFilePreviewStep({
  parseResult,
  duplicateInfo,
  onContinue,
  onBack,
}: BankFilePreviewStepProps) {
  const t = useTranslations('transactions')
  const { transactions, stats, issues, date_from, date_to } = parseResult
  const errors = issues.filter((i) => i.severity === 'error')
  const hasIssues = errors.length > 0
  const warnings = issues.filter((i) => i.severity === 'warning')
  // Wise/camt.053 files can mix currencies per row: the parser-level totals
  // sum across currencies, so income/expenses are grouped per currency here.
  const currencyTotals = summarizeByCurrency(transactions)
  const totalsRows = currencyTotals.length
    ? currencyTotals
    : [{ currency: 'SEK', total_income: 0, total_expenses: 0 }]
  const duplicateCount = duplicateInfo?.duplicate_count ?? 0
  // Table rows render transactions.slice(0, 50), so the slice index IS the
  // original array index the server flagged.
  const duplicateRowSet = new Set(duplicateInfo?.duplicate_row_indexes ?? [])

  return (
    <div className="space-y-6">
      {/* Summary: flat label/number pairs, no boxed tiles */}
      <ImportStatRow
        stats={[
          {
            key: 'rows',
            label: 'Transaktioner',
            value: stats.parsed_rows,
            note: stats.skipped_rows > 0 ? `${stats.skipped_rows} rader hoppades över` : undefined,
          },
          {
            key: 'period',
            label: 'Period',
            value: `${date_from || '-'} till ${date_to || '-'}`,
            plain: true,
          },
          {
            key: 'income',
            label: 'Inkomster',
            value: (
              <div className="space-y-1">
                {totalsRows.map((row) => (
                  <p key={row.currency}>{formatCurrency(row.total_income, row.currency)}</p>
                ))}
              </div>
            ),
          },
          {
            key: 'expenses',
            label: 'Utgifter',
            value: (
              <div className="space-y-1">
                {totalsRows.map((row) => (
                  <p key={row.currency}>{formatCurrency(row.total_expenses, row.currency)}</p>
                ))}
              </div>
            ),
          },
        ]}
      />

      {/* Duplicate rows (ingest skips them) and rows the parser could not
          read: one folded list, nothing boxed. */}
      <ImportNotices
        notices={[
          ...(duplicateCount > 0
            ? [makeNotice('bank_duplicate_rows', 'notice', { count: duplicateCount })]
            : []),
          ...noticesFromParseIssues(warnings),
        ]}
      />

      {/* Transaction preview table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Transaktioner</CardTitle>
          <CardDescription>
            Förhandsgranskning av de {Math.min(transactions.length, 50)} första transaktionerna
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border max-h-96 overflow-x-auto overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">Datum</TableHead>
                  <TableHead>Beskrivning</TableHead>
                  <TableHead className="text-right w-32">Belopp</TableHead>
                  {transactions.some((t) => t.balance != null) && (
                    <TableHead className="text-right w-32">Saldo</TableHead>
                  )}
                  {transactions.some((t) => t.reference) && (
                    <TableHead className="w-32">Referens</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {transactions.slice(0, 50).map((tx, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-sm">{tx.date}</TableCell>
                    <TableCell className="text-sm">
                      {tx.description}
                      {duplicateRowSet.has(i) && (
                        <Badge variant="secondary" className="ml-2">
                          {t('import_duplicate_row_badge')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell
                      className="text-right font-mono text-sm"
                    >
                      {formatCurrency(tx.amount, tx.currency || 'SEK')}
                    </TableCell>
                    {transactions.some((t) => t.balance != null) && (
                      <TableCell className="text-right font-mono text-sm text-muted-foreground">
                        {tx.balance != null ? formatCurrency(tx.balance, tx.currency || 'SEK') : '-'}
                      </TableCell>
                    )}
                    {transactions.some((t) => t.reference) && (
                      <TableCell className="font-mono text-sm text-muted-foreground">
                        {tx.reference ? tx.reference : '-'}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {transactions.length > 50 && (
            <p className="text-sm text-muted-foreground mt-2 text-center">
              Visar 50 av {transactions.length} transaktioner
            </p>
          )}
        </CardContent>
      </Card>

      {/* Error blocking continuation */}
      {hasIssues && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
              <div className="min-w-0 space-y-2">
                <p className="font-medium text-destructive">Filen innehåller fel som förhindrar import</p>
                <div className="max-h-32 space-y-1 overflow-y-auto">
                  {errors.map((issue, i) => (
                    <p key={i} className="text-xs text-muted-foreground">
                      Rad {issue.row}: {issue.message}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Navigation */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" className="min-h-11" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Tillbaka
        </Button>
        <Button className="min-h-11" onClick={onContinue} disabled={hasIssues || transactions.length === 0}>
          Fortsätt
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
