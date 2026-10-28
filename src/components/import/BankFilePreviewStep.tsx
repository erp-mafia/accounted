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
import { ArrowLeftIcon, ArrowRightIcon, ExclamationTriangleIcon } from '@/components/icons'
import { Switch } from '@/components/ui/switch'
import { formatCurrency } from '@/lib/utils'
import { summarizeByCurrency } from '@/lib/import/bank-file/currency-summary'
import { cardStatementStats } from '@/lib/import/bank-file/card-statement'
import type { BankFileParseResult, BankFileDuplicateInfo } from '@/lib/import/bank-file/types'
import type { ImportStat } from '@/components/import/ImportStatRow'

interface BankFilePreviewStepProps {
  parseResult: BankFileParseResult
  duplicateInfo?: BankFileDuplicateInfo | null
  /**
   * The company card the statement is imported to. The rows arrive in the
   * stored sign (a purchase negative); the switch says whether the file
   * printed purchases as plus, which flips every row.
   */
  card?: { name: string; ledger_account: string } | null
  cardSignsFlipped?: boolean
  onCardSignsFlippedChange?: (flipped: boolean) => void
  onContinue: () => void
  onBack: () => void
}

export default function BankFilePreviewStep({
  parseResult,
  duplicateInfo,
  card,
  cardSignsFlipped = false,
  onCardSignsFlippedChange,
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

  // A card statement reads as what it is: purchases, fees, the payment and
  // refunds, each with its count (one currency: the card's).
  const cardStats = card ? cardStatementStats(transactions) : null
  const cardCurrency = cardStats?.currencies.length === 1 ? cardStats.currencies[0] : 'SEK'
  const cardStatRow: ImportStat[] | null = cardStats
    ? [
        {
          key: 'period',
          label: t('import_card_period'),
          value: t('import_card_period_value', { from: date_from || '-', to: date_to || '-' }),
          plain: true,
        },
        ...([
          ['purchases', cardStats.purchases],
          ['fees', cardStats.fees],
          ['payments', cardStats.payments],
          ['refunds', cardStats.refunds],
        ] as const)
          .filter(([key, group]) => key === 'purchases' || group.count > 0)
          .map(([key, group]) => ({
            key,
            label: t(`import_card_${key}`, { count: group.count }),
            value: formatCurrency(group.total, cardCurrency),
          })),
      ]
    : null

  return (
    <div className="space-y-6">
      {card && (
        <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
          <div className="min-w-0">
            <label htmlFor="card-sign-switch" className="block text-[13px] font-medium">
              {t('import_card_sign_label')}
            </label>
            <div className="text-[12.5px] text-muted-foreground">
              {t('import_card_sign_hint', { card: card.name, ledger: card.ledger_account })}
            </div>
          </div>
          <Switch
            id="card-sign-switch"
            checked={cardSignsFlipped}
            onCheckedChange={(checked) => onCardSignsFlippedChange?.(checked)}
          />
        </div>
      )}

      {/* Summary: flat label/number pairs, no boxed tiles */}
      <ImportStatRow
        stats={cardStatRow ?? [
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
                  <TableHead className="w-28">{card ? t('import_card_purchase_date') : 'Datum'}</TableHead>
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
                    <TableCell className="whitespace-nowrap font-mono text-sm">{tx.date}</TableCell>
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
              <ExclamationTriangleIcon className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
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
        <Button variant="outline" onClick={onBack}>
          <ArrowLeftIcon className="mr-2 h-4 w-4" />
          Tillbaka
        </Button>
        <Button onClick={onContinue} disabled={hasIssues || transactions.length === 0}>
          Fortsätt
          <ArrowRightIcon className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
