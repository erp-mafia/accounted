'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
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
  Calendar,
  TrendingUp,
  TrendingDown,
  FileText,
} from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import type { BankFileParseResult } from '@/lib/import/bank-file/types'

interface BankFilePreviewStepProps {
  parseResult: BankFileParseResult
  onContinue: () => void
  onBack: () => void
}

export default function BankFilePreviewStep({
  parseResult,
  onContinue,
  onBack,
}: BankFilePreviewStepProps) {
  const { transactions, stats, issues, date_from, date_to } = parseResult
  const hasIssues = issues.filter((i) => i.severity === 'error').length > 0
  const warnings = issues.filter((i) => i.severity === 'warning')

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <FileText className="h-4 w-4" />
              <span className="text-sm">Transaktioner</span>
            </div>
            <p className="text-2xl font-display tabular-nums">{stats.parsed_rows}</p>
            {stats.skipped_rows > 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                {stats.skipped_rows} rader hoppades över
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Calendar className="h-4 w-4" />
              <span className="text-sm">Period</span>
            </div>
            <p className="text-sm font-medium">
              {date_from || '–'} till {date_to || '–'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <TrendingUp className="h-4 w-4" />
              <span className="text-sm">Inkomster</span>
            </div>
            <p className="text-lg font-display tabular-nums">
              {formatCurrency(stats.total_income)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <TrendingDown className="h-4 w-4" />
              <span className="text-sm">Utgifter</span>
            </div>
            <p className="text-lg font-display tabular-nums">
              {formatCurrency(stats.total_expenses)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm flex items-center gap-2 text-warning">
              <AlertTriangle className="h-4 w-4" />
              {warnings.length} varning{warnings.length !== 1 ? 'ar' : ''}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {warnings.slice(0, 10).map((issue, i) => (
                <p key={i} className="text-xs text-muted-foreground">
                  Rad {issue.row}: {issue.message}
                </p>
              ))}
              {warnings.length > 10 && (
                <p className="text-xs text-muted-foreground font-medium">
                  ...och {warnings.length - 10} till
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Transaction preview table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Transaktioner</CardTitle>
          <CardDescription>
            Förhandsgranskning av de {Math.min(transactions.length, 50)} första transaktionerna
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border max-h-96 overflow-x-auto overflow-y-auto">
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
                    <TableCell className="text-sm">{tx.description}</TableCell>
                    <TableCell
                      className="text-right font-mono text-sm"
                    >
                      {formatCurrency(tx.amount)}
                    </TableCell>
                    {transactions.some((t) => t.balance != null) && (
                      <TableCell className="text-right font-mono text-sm text-muted-foreground">
                        {tx.balance != null ? formatCurrency(tx.balance) : '–'}
                      </TableCell>
                    )}
                    {transactions.some((t) => t.reference) && (
                      <TableCell className="font-mono text-sm text-muted-foreground">
                        {tx.reference ? tx.reference : '–'}
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
              <div>
                <p className="font-medium text-destructive">Filen innehåller fel som förhindrar import</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Kontrollera felet ovan och försök ladda upp en korrigerad fil.
                </p>
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
