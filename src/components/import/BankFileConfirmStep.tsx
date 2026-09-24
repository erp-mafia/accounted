'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { ImportNotices } from '@/components/import/ImportNotices'
import { makeNotice, noticesFromParseIssues } from '@/lib/import/notices'
import { useAccounts } from '@/lib/reference-data/hooks'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  ArrowLeft,
  Loader2,
  Play,
  FileText,
  Link2,
  Calendar,
  Landmark,
  AlertTriangle,
} from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { summarizeByCurrency } from '@/lib/import/bank-file/currency-summary'
import type { BankFileParseResult, BankFileDuplicateInfo } from '@/lib/import/bank-file/types'

interface BankAccount {
  account_number: string
  account_name: string
}

interface BankFileConfirmStepProps {
  parseResult: BankFileParseResult
  duplicateInfo?: BankFileDuplicateInfo | null
  onExecute: (options: { skip_duplicates: boolean; auto_categorize: boolean; settlement_account?: string }) => void
  onBack: () => void
  isLoading: boolean
}

export default function BankFileConfirmStep({
  parseResult,
  duplicateInfo,
  onExecute,
  onBack,
  isLoading,
}: BankFileConfirmStepProps) {
  const t = useTranslations('transactions')
  const { transactions, stats, date_from, date_to, issues } = parseResult
  const refsCount = transactions.filter((tx) => tx.reference).length
  const warnings = issues.filter((i) => i.severity === 'warning')
  // Same per-currency grouping as the preview step: parser-level totals sum
  // across currencies, which misleads on Wise/camt.053 multi-currency files.
  const currencyTotals = summarizeByCurrency(transactions)
  // Advisory: clamp so a stale preview can never produce a negative CTA
  // count. Execute stays authoritative; the copy says rows are skipped
  // automatically rather than promising an exact final number.
  const duplicateCount = Math.min(Math.max(duplicateInfo?.duplicate_count ?? 0, 0), stats.parsed_rows)

  const [selectedAccount, setSelectedAccount] = useState('1930')
  // Active 19xx accounts from the session-cached chart (lib/reference-data):
  // the account select is populated on the first paint.
  const { accounts } = useAccounts()
  const bankAccounts = useMemo<BankAccount[]>(
    () =>
      accounts
        .filter((a) => a.account_number >= '1900' && a.account_number <= '1999')
        .sort((a, b) => a.account_number.localeCompare(b.account_number))
        .map((a) => ({ account_number: a.account_number, account_name: a.account_name })),
    [accounts],
  )
  // Default to 1930 if available, otherwise the first account (once).
  const defaultedRef = useRef(false)
  useEffect(() => {
    if (defaultedRef.current || bankAccounts.length === 0) return
    defaultedRef.current = true
    const has1930 = bankAccounts.some((a) => a.account_number === '1930')
    if (!has1930) setSelectedAccount(bankAccounts[0].account_number)
  }, [bankAccounts])

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 space-y-6">
        <div className="relative">
          <Loader2 className="h-12 w-12 animate-spin text-primary" />
        </div>
        <div className="text-center space-y-2">
          <p className="text-lg font-medium">{t('bank_confirm_importing_title')}</p>
          <p className="text-sm text-muted-foreground">
            {t('bank_confirm_processing', { count: stats.parsed_rows })}
          </p>
        </div>
        <Skeleton className="h-1 w-48 rounded-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Summary */}
      <Card>
        <CardHeader>
          <CardTitle>{t('bank_confirm_title')}</CardTitle>
          <CardDescription>
            {t('bank_confirm_description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Stats grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <FileText className="h-4 w-4" />
                <span className="text-xs">{t('bank_confirm_stat_transactions')}</span>
              </div>
              <p className="text-xl font-display tabular-nums">{stats.parsed_rows}</p>
              {stats.skipped_rows > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  {t('bank_confirm_skipped_rows', { count: stats.skipped_rows })}
                </p>
              )}
            </div>

            <div className="p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <Calendar className="h-4 w-4" />
                <span className="text-xs">{t('bank_confirm_stat_period')}</span>
              </div>
              <p className="text-sm font-medium">
                {date_from}: {date_to}
              </p>
            </div>

            <div className="p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <span className="text-xs">{t('bank_confirm_stat_income')}</span>
              </div>
              {(currencyTotals.length ? currencyTotals : [{ currency: 'SEK', total_income: 0, total_expenses: 0 }]).map((row) => (
                <p key={row.currency} className="text-xl font-display tabular-nums">
                  {formatCurrency(row.total_income, row.currency)}
                </p>
              ))}
            </div>

            <div className="p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <span className="text-xs">{t('bank_confirm_stat_expenses')}</span>
              </div>
              {(currencyTotals.length ? currencyTotals : [{ currency: 'SEK', total_income: 0, total_expenses: 0 }]).map((row) => (
                <p key={row.currency} className="text-xl font-display tabular-nums">
                  {formatCurrency(row.total_expenses, row.currency)}
                </p>
              ))}
            </div>
          </div>

          {/* Bank account selector */}
          {bankAccounts.length > 1 && (
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Landmark className="h-4 w-4 text-muted-foreground" />
                {t('bank_confirm_bank_account')}
              </Label>
              <Select value={selectedAccount} onValueChange={setSelectedAccount}>
                <SelectTrigger className="w-full sm:w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {bankAccounts.map((account) => (
                    <SelectItem key={account.account_number} value={account.account_number}>
                      <span className="font-mono">{account.account_number}</span>
                      {' '}
                      {account.account_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('bank_confirm_bank_account_hint')}
              </p>
            </div>
          )}

          {/* Additional info */}
          {refsCount > 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Link2 className="h-3 w-3" />
              {t('bank_confirm_with_reference', { count: refsCount })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Duplicate rows: repeated here because the generic_csv path skips the
          preview step where the same card is shown. Advisory: ingest skips
          them automatically at execute. */}
      <ImportNotices
        notices={[
          ...(duplicateCount > 0
            ? [makeNotice('bank_duplicate_rows', 'notice', { count: duplicateCount })]
            : []),
          ...noticesFromParseIssues(warnings),
        ]}
      />

      {/* Actions */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onBack} disabled={isLoading}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('bank_confirm_back')}
        </Button>
        <Button
          onClick={() => onExecute({
            skip_duplicates: true,
            auto_categorize: false,
            // Always sent, 1930 included: ingest binds the rows to the account
            // named here, and an omitted default imported every row unbound.
            settlement_account: selectedAccount,
          })}
          loading={isLoading}
        >
          {isLoading ? (
            t('bank_confirm_importing')
          ) : (
            <>
              <Play className="mr-2 h-4 w-4" />
              {t('bank_confirm_import_count', { count: stats.parsed_rows - duplicateCount })}
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
