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
  ArrowLeftIcon,
  BuildingLibraryIcon,
  CalendarIcon,
  CreditCardIcon,
  DocumentTextIcon,
  ExclamationCircleIcon,
  LinkIcon,
  PlayIcon,
  SpinnerIcon,
} from '@/components/icons'
import { formatCurrency } from '@/lib/utils'
import { summarizeByCurrency } from '@/lib/import/bank-file/currency-summary'
import type { BankFileParseResult, BankFileDuplicateInfo } from '@/lib/import/bank-file/types'
import { fileAccountLabel, type FileAccountMatch } from '@/lib/cash-accounts/file-account'

interface BankAccount {
  account_number: string
  account_name: string
}

interface BankFileConfirmStepProps {
  parseResult: BankFileParseResult
  duplicateInfo?: BankFileDuplicateInfo | null
  /**
   * The cash account the file's own bank account already is (crm#1204): the
   * only ledgers offered, since execute refuses any other.
   */
  accountMatch?: FileAccountMatch | null
  /**
   * The company card the statement goes to (chosen before the preview, which
   * set the sign): the only account, so no bank account is offered.
   */
  card?: { name: string; ledger_account: string } | null
  /** Why the last import attempt failed, if it did. */
  error?: string | null
  onExecute: (options: { skip_duplicates: boolean; auto_categorize: boolean; settlement_account?: string }) => void
  onBack: () => void
  isLoading: boolean
}

export default function BankFileConfirmStep({
  parseResult,
  duplicateInfo,
  accountMatch,
  card,
  error,
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

  const [selectedAccount, setSelectedAccount] = useState(card?.ledger_account ?? accountMatch?.ledger_account ?? '1930')
  // Active 19xx accounts from the session-cached chart (lib/reference-data):
  // the account select is populated on the first paint. A file whose bank
  // account is already a cash account offers only that account's ledger(s).
  const { accounts } = useAccounts()
  const bankAccounts = useMemo<BankAccount[]>(() => {
    const chart = accounts
      .filter((a) => a.account_number >= '1900' && a.account_number <= '1999')
      .sort((a, b) => a.account_number.localeCompare(b.account_number))
      .map((a) => ({ account_number: a.account_number, account_name: a.account_name }))
    if (!accountMatch) return chart
    return accountMatch.ledger_accounts.map((ledger) => ({
      account_number: ledger,
      account_name: chart.find((a) => a.account_number === ledger)?.account_name ?? '',
    }))
  }, [accounts, accountMatch])
  const matchedAccount = accountMatch
    ? bankAccounts.find((a) => a.account_number === selectedAccount) ?? bankAccounts[0]
    : null
  // Default to 1930 if available, otherwise the first account (once). A
  // matched file starts on its own account instead.
  const defaultedRef = useRef(Boolean(accountMatch) || Boolean(card))
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
          <SpinnerIcon className="h-12 w-12 animate-spin text-primary" />
        </div>
        <div className="text-center space-y-2">
          <p className="text-lg font-medium">Importerar transaktioner...</p>
          <p className="text-sm text-muted-foreground">
            {stats.parsed_rows} transaktioner bearbetas
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
          <CardTitle>Bekräfta import</CardTitle>
          <CardDescription>
            Granska sammanfattningen och importera transaktionerna.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Stats grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <DocumentTextIcon className="h-4 w-4" />
                <span className="text-xs">Transaktioner</span>
              </div>
              <p className="text-xl font-display tabular-nums">{stats.parsed_rows}</p>
              {stats.skipped_rows > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  {stats.skipped_rows} rader hoppades över
                </p>
              )}
            </div>

            <div className="p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <CalendarIcon className="h-4 w-4" />
                <span className="text-xs">Period</span>
              </div>
              <p className="text-sm font-medium">
                {date_from}: {date_to}
              </p>
            </div>

            <div className="p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <span className="text-xs">{card ? t('import_card_credits') : 'Inkomster'}</span>
              </div>
              {(currencyTotals.length ? currencyTotals : [{ currency: 'SEK', total_income: 0, total_expenses: 0 }]).map((row) => (
                <p key={row.currency} className="text-xl font-display tabular-nums">
                  {formatCurrency(row.total_income, row.currency)}
                </p>
              ))}
            </div>

            <div className="p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <span className="text-xs">{card ? t('import_card_charges') : 'Utgifter'}</span>
              </div>
              {(currencyTotals.length ? currencyTotals : [{ currency: 'SEK', total_income: 0, total_expenses: 0 }]).map((row) => (
                <p key={row.currency} className="text-xl font-display tabular-nums">
                  {formatCurrency(row.total_expenses, row.currency)}
                </p>
              ))}
            </div>
          </div>

          {/* A card statement goes to its card, chosen before the preview. */}
          {card && (
            <div className="flex items-center gap-2 text-sm font-medium">
              <CreditCardIcon className="h-4 w-4 text-muted-foreground" />
              {t('import_card_target', { card: card.name, ledger: card.ledger_account })}
            </div>
          )}

          {/* Bank account selector */}
          {!card && bankAccounts.length > 1 && (
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <BuildingLibraryIcon className="h-4 w-4 text-muted-foreground" />
                Bankkonto
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
                Välj vilket bankkonto transaktionerna ska bokföras mot.
              </p>
            </div>
          )}

          {/* The file's own bank account is already a cash account here */}
          {!card && accountMatch && parseResult.account && matchedAccount && (
            <div className="space-y-1">
              {bankAccounts.length <= 1 && (
                <div className="flex items-center gap-2 text-sm font-medium">
                  <BuildingLibraryIcon className="h-4 w-4 text-muted-foreground" />
                  <span className="font-mono">{matchedAccount.account_number}</span>
                  {matchedAccount.account_name}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {t('import_file_account_matched', {
                  account: fileAccountLabel(parseResult.account),
                  ledger: matchedAccount.account_number,
                })}
              </p>
              <p className="text-xs text-muted-foreground">{t('import_file_account_change_hint')}</p>
            </div>
          )}

          {/* Additional info */}
          {refsCount > 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <LinkIcon className="h-3 w-3" />
              {refsCount} med OCR/referens
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

      {error && (
        <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex gap-3">
          <ExclamationCircleIcon className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onBack} disabled={isLoading}>
          <ArrowLeftIcon className="mr-2 h-4 w-4" />
          Tillbaka
        </Button>
        <Button
          onClick={() => onExecute({
            skip_duplicates: true,
            auto_categorize: false,
            // Always sent, 1930 included: ingest binds the rows to the account
            // named here, and an omitted default imported every row unbound.
            settlement_account: card ? card.ledger_account : selectedAccount,
          })}
          loading={isLoading}
        >
          {isLoading ? (
            'Importerar...'
          ) : (
            <>
              <PlayIcon className="mr-2 h-4 w-4" />
              {card
                ? t('import_card_submit', { count: stats.parsed_rows - duplicateCount, card: card.name, ledger: card.ledger_account })
                : <>Importera {stats.parsed_rows - duplicateCount} transaktioner</>}
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
