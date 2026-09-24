'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { formatCurrency } from '@/lib/utils'
import {
  Calendar,
  FileText,
  CheckCircle,
  AlertCircle,
  XCircle,
  ArrowRight,
  Info,
  Briefcase,
} from 'lucide-react'
import type { ImportPreview, ParseIssue } from '@/lib/import/types'
import { HelpPopover } from '@/components/ui/help-popover'
import { ImportStatRow } from '@/components/import/ImportStatRow'

interface SIEPreviewStepProps {
  preview: ImportPreview
  issues: ParseIssue[]
  missingAccounts: { number: string; name: string }[]
  onCreateAccounts: () => Promise<void>
  isCreatingAccounts: boolean
  onContinue: () => void
  onBack: () => void
  /**
   * Opens the manual "Ingående balanser" wizard (issue #2082). Offered next to
   * the IB-imbalance acknowledgement so a user who rightly hesitates to book an
   * unexplained amount to 2099 has somewhere to go other than support.
   */
  onOpenManualOpeningBalances?: () => void
}

export default function SIEPreviewStep({
  preview,
  issues,
  missingAccounts,
  onCreateAccounts,
  isCreatingAccounts,
  onContinue,
  onBack,
  onOpenManualOpeningBalances,
}: SIEPreviewStepProps) {
  const t = useTranslations('import')
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')

  // Both blocks are optional: a preview built by an older parse response
  // lacks them, and the card then falls back to the BAS-reference counts.
  const chart = preview.chart
  const fiscalYear = preview.fiscalYear
  // Both refusals carry the import's own text: an overlap with a period that
  // has content, or #RAR dates that break a BFL 3 kap. shape rule.
  const fiscalYearRefused =
    fiscalYear?.verdict === 'conflict' || fiscalYear?.verdict === 'invalid'

  // Opening-balance imbalance. The importer plugs any diff > 0.01 to 2099, but a
  // diff under ~1 SEK is genuine öresavrundning. Anything larger is a real
  // imbalance (incomplete export: missing liabilities / unappropriated prior-year
  // result) that would silently book a bogus amount to 2099. Mirrors the importer's
  // own `fileImbalance > 1.00` "serious" threshold (lib/import/sie-import.ts).
  const ibDiff = Math.round((preview.trialBalance.totalDebit - preview.trialBalance.totalCredit) * 100) / 100
  const significantImbalance = !preview.trialBalance.isBalanced && Math.abs(ibDiff) > 1
  const [ackImbalance, setAckImbalance] = useState(false)

  // Only block on actual parsing errors, not unmapped accounts
  // (users need to proceed to mapping step to fix unmapped accounts).
  // A significant IB imbalance is a soft block: the user must acknowledge it.
  const hasBlockingErrors = errors.length > 0
  const blockContinue = hasBlockingErrors || (significantImbalance && !ackImbalance)

  return (
    <div className="space-y-6">
      {/* Company info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Briefcase className="h-5 w-5" />
            {t('sie_preview_company_info_title')}
          </CardTitle>
          <CardDescription>{t('sie_preview_company_info_description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="text-sm text-muted-foreground">{t('sie_preview_company_name')}</p>
              <p className="font-medium">{preview.companyName || t('sie_preview_not_specified')}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('sie_preview_org_number')}</p>
              <p className="font-medium">{preview.orgNumber || t('sie_preview_not_specified')}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Fiscal year */}
      <Card className={fiscalYearRefused ? 'border-destructive/50' : undefined}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            {t('sie_preview_fiscal_year_title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div>
              <p className="text-sm text-muted-foreground">{t('sie_preview_start')}</p>
              <p className="font-medium">
                {preview.fiscalYearStart ?? t('sie_preview_unknown')}
              </p>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-sm text-muted-foreground">{t('sie_preview_end')}</p>
              <p className="font-medium">
                {preview.fiscalYearEnd ?? t('sie_preview_unknown')}
              </p>
            </div>
            {fiscalYear && (fiscalYear.verdict === 'match' || fiscalYear.verdict === 'create') && (
              <span className="ml-auto text-sm text-muted-foreground">
                {fiscalYear.verdict === 'match'
                  ? t('fiscal_year_match')
                  : fiscalYear.replacesEmptyPeriodId
                    ? t('fiscal_year_create_replaces')
                    : t('fiscal_year_create')}
              </span>
            )}
          </div>
          {fiscalYear && (fiscalYear.verdict === 'conflict' || fiscalYear.verdict === 'invalid') && (
            <div className="mt-4 flex items-start gap-2 text-sm text-destructive">
              <XCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{fiscalYear.message}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Statistics: flat label/number pairs, no boxed tiles. The IB
          clarification sits behind the label's "?". */}
      <ImportStatRow
        stats={[
          { key: 'accounts', label: t('sie_preview_stat_accounts'), value: preview.accountCount },
          { key: 'vouchers', label: t('sie_preview_stat_vouchers'), value: preview.voucherCount },
          { key: 'lines', label: t('sie_preview_stat_lines'), value: preview.transactionLineCount },
          {
            key: 'ib',
            label: (
              <>
                {t('sie_preview_stat_ib_debit')}
                <HelpPopover className="shrink-0">
                  {t('sie_preview_stat_ib_debit_help')}
                </HelpPopover>
              </>
            ),
            value: formatCurrency(preview.openingBalanceTotal),
          },
        ]}
      />

      {/* Trial balance check */}
      <Card className={preview.trialBalance.isBalanced ? 'border-success/50' : 'border-border'}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {preview.trialBalance.isBalanced ? (
              <CheckCircle className="h-5 w-5 text-success" />
            ) : (
              <AlertCircle className="h-5 w-5 text-warning" />
            )}
            {t('sie_preview_trial_balance_title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <p className="text-sm text-muted-foreground">{t('sie_preview_total_debit')}</p>
              <p className="font-medium">{formatCurrency(preview.trialBalance.totalDebit)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('sie_preview_total_credit')}</p>
              <p className="font-medium">{formatCurrency(preview.trialBalance.totalCredit)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('sie_preview_status')}</p>
              {preview.trialBalance.isBalanced ? (
                <span className="text-xs text-muted-foreground">{t('sie_preview_balanced')}</span>
              ) : (
                <Badge variant="secondary">
                  {t('sie_preview_diff', { amount: formatCurrency(ibDiff) })}
                </Badge>
              )}
            </div>
          </div>

          {/* Significant imbalance: explain + require acknowledgement before continuing */}
          {significantImbalance && (
            <div className="mt-4 space-y-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
              <div className="flex items-start gap-2 text-sm">
                <AlertCircle className="h-4 w-4 text-warning mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <p className="font-medium text-warning">
                    {t('sie_preview_imbalance_title', { amount: formatCurrency(Math.abs(ibDiff)) })}
                  </p>
                  <p className="text-muted-foreground">
                    {t('sie_preview_imbalance_cause')}
                  </p>
                  <p className="text-muted-foreground">
                    {t('sie_preview_imbalance_fix')}
                  </p>
                  {onOpenManualOpeningBalances && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-1"
                      onClick={onOpenManualOpeningBalances}
                    >
                      {t('sie_preview_manual_opening_balances')}
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={ackImbalance}
                  onCheckedChange={(v) => setAckImbalance(v === true)}
                  className="mt-0.5"
                />
                <span className="text-muted-foreground">
                  {t('sie_preview_imbalance_ack')}
                </span>
              </label>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Mapping status */}
      <Card
        className={
          preview.mappingStatus.unmapped > 0
            ? 'border-destructive/50'
            : preview.mappingStatus.lowConfidence > 0
            ? 'border-border'
            : 'border-success/50'
        }
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {preview.mappingStatus.unmapped > 0 ? (
              <XCircle className="h-5 w-5 text-destructive" />
            ) : preview.mappingStatus.lowConfidence > 0 ? (
              <AlertCircle className="h-5 w-5 text-warning" />
            ) : (
              <CheckCircle className="h-5 w-5 text-success" />
            )}
            {t('chart_card_title')}
          </CardTitle>
          <CardDescription>
            {chart
              ? t('chart_summary', { toCreate: chart.toCreate, existing: chart.existing })
              : t('sie_preview_mapping_description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {chart ? (
              <>
                <div>
                  <p className="text-sm text-muted-foreground">{t('chart_to_create')}</p>
                  <p className="font-medium tabular-nums">{chart.toCreate}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{t('chart_existing')}</p>
                  <p className="font-medium tabular-nums">{chart.existing}</p>
                </div>
              </>
            ) : (
              <>
                <div>
                  <p className="text-sm text-muted-foreground">{t('sie_preview_mapping_total')}</p>
                  <p className="font-medium">{preview.mappingStatus.total}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{t('sie_preview_mapping_mapped')}</p>
                  <p className="font-medium text-success">{preview.mappingStatus.mapped}</p>
                </div>
              </>
            )}
            <div>
              <p className="text-sm text-muted-foreground">{t('sie_preview_mapping_unmapped')}</p>
              <p className={`font-medium tabular-nums ${preview.mappingStatus.unmapped > 0 ? 'text-destructive' : ''}`}>
                {preview.mappingStatus.unmapped}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('sie_preview_mapping_low_confidence')}</p>
              <p className={`font-medium tabular-nums ${preview.mappingStatus.lowConfidence > 0 ? 'text-warning' : ''}`}>
                {preview.mappingStatus.lowConfidence}
              </p>
            </div>
          </div>
          {chart && chart.sample.length > 0 && (
            <div className="mt-4 space-y-1 text-sm">
              {chart.sample.map((acc) => (
                <div key={acc.number} className="flex gap-2 text-muted-foreground">
                  <span className="font-mono">{acc.number}</span>
                  <span>{acc.name}</span>
                </div>
              ))}
              {chart.toCreate > chart.sample.length && (
                <div className="text-muted-foreground">
                  {t('chart_sample_more', { count: chart.toCreate - chart.sample.length })}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Excluded system accounts info */}
      {preview.excludedSystemAccounts.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>
            {t('sie_preview_excluded_system_accounts', { count: preview.excludedSystemAccounts.length, accounts: preview.excludedSystemAccounts.map((a) => a.number).join(', ') })}
          </span>
        </div>
      )}

      {Boolean(preview.archivedOnlyAccounts?.length) && (
        <p className="text-sm text-muted-foreground" data-ph-mask>
          {t('archived_only_accounts', { accounts: preview.archivedOnlyAccounts!.map(account => account.number).join(', ') })}
        </p>
      )}

      {/* Create missing accounts */}
      {missingAccounts.length > 0 ? (
        <Card className="border-primary/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              {t('sie_preview_missing_accounts_title')}
            </CardTitle>
            <CardDescription>
              {t('sie_preview_missing_accounts_description', { count: missingAccounts.length })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="max-h-32 overflow-y-auto text-sm space-y-1">
                {missingAccounts.slice(0, 10).map((acc) => (
                  <div key={acc.number} className="flex gap-2 text-muted-foreground">
                    <span className="font-mono">{acc.number}</span>
                    <span>{acc.name}</span>
                  </div>
                ))}
                {missingAccounts.length > 10 && (
                  <div className="text-muted-foreground">
                    {t('sie_preview_and_more', { count: missingAccounts.length - 10 })}
                  </div>
                )}
              </div>
              <Button
                onClick={onCreateAccounts}
                disabled={isCreatingAccounts}
                className="w-full"
              >
                {isCreatingAccounts ? (
                  <>{t('sie_preview_creating_accounts')}</>
                ) : (
                  <>{t('sie_preview_create_accounts', { count: missingAccounts.length })}</>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : preview.mappingStatus.mapped === preview.mappingStatus.total && preview.mappingStatus.total > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-success/50 bg-success/5 px-4 py-3 text-sm">
          <CheckCircle className="h-4 w-4 text-success flex-shrink-0" />
          <span>{t('accounts_mapped_ready')}</span>
        </div>
      )}

      {/* Errors */}
      {errors.length > 0 && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-destructive" />
              {t('sie_preview_errors_title', { count: errors.length })}
            </CardTitle>
            <CardDescription>
              {t('sie_preview_errors_description')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {errors.map((issue, i) => (
                <div key={`error-${i}`} className="text-sm flex gap-2 text-destructive">
                  <XCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>
                    <span className="font-mono text-xs opacity-70">{t('sie_preview_line', { line: issue.line })}</span>{' '}
                    {issue.message}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Warnings */}
      {warnings.length > 0 && (
        <Card className="border-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-warning" />
              {t('sie_preview_warnings_title', { count: warnings.length })}
            </CardTitle>
            <CardDescription>
              {t('sie_preview_warnings_description')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {warnings.map((issue, i) => (
                <div key={`warning-${i}`} className="text-sm flex gap-2 text-warning">
                  <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>
                    <span className="font-mono text-xs opacity-70">{t('sie_preview_line', { line: issue.line })}</span>{' '}
                    {issue.message}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Actions */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onBack}>
          {t('sie_preview_back')}
        </Button>
        <Button onClick={onContinue} disabled={blockContinue}>
          {preview.mappingStatus.lowConfidence > 0 || preview.mappingStatus.unmapped > 0
            ? t('sie_preview_review_mappings')
            : t('sie_preview_continue')}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
