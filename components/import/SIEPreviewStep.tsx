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
  BarChart3,
  Info,
  Briefcase,
} from 'lucide-react'
import type { ImportPreview, ParseIssue } from '@/lib/import/types'

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
            Företagsinformation
          </CardTitle>
          <CardDescription>Information från SIE-filen</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="text-sm text-muted-foreground">Företagsnamn</p>
              <p className="font-medium">{preview.companyName || 'Ej angivet'}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Organisationsnummer</p>
              <p className="font-medium">{preview.orgNumber || 'Ej angivet'}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Fiscal year */}
      <Card className={fiscalYearRefused ? 'border-destructive/50' : undefined}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            Räkenskapsår
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Start</p>
              <p className="font-medium">
                {preview.fiscalYearStart ?? 'Okänt'}
              </p>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-sm text-muted-foreground">Slut</p>
              <p className="font-medium">
                {preview.fiscalYearEnd ?? 'Okänt'}
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

      {/* Statistics */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <FileText className="h-4 w-4" />
              <span className="text-sm">Konton</span>
            </div>
            <p className="text-2xl font-display tabular-nums">{preview.accountCount}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <BarChart3 className="h-4 w-4" />
              <span className="text-sm">Verifikationer</span>
            </div>
            <p className="text-2xl font-display tabular-nums">{preview.voucherCount}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <span className="text-sm">Transaktionsrader</span>
            </div>
            <p className="text-2xl font-display tabular-nums">{preview.transactionLineCount}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <span className="text-sm">IB, summa debet</span>
            </div>
            <p className="text-2xl font-display tabular-nums">{formatCurrency(preview.openingBalanceTotal)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Summan av alla debetsaldon i ingående balans, inte ett enskilt kontosaldo.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Trial balance check */}
      <Card className={preview.trialBalance.isBalanced ? 'border-success/50' : 'border-border'}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {preview.trialBalance.isBalanced ? (
              <CheckCircle className="h-5 w-5 text-success" />
            ) : (
              <AlertCircle className="h-5 w-5 text-warning" />
            )}
            Balansräkning (IB)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <p className="text-sm text-muted-foreground">Total debet</p>
              <p className="font-medium">{formatCurrency(preview.trialBalance.totalDebit)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total kredit</p>
              <p className="font-medium">{formatCurrency(preview.trialBalance.totalCredit)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Status</p>
              {preview.trialBalance.isBalanced ? (
                <Badge variant="success">Balanserar</Badge>
              ) : (
                <Badge variant="secondary">
                  Diff: {formatCurrency(ibDiff)}
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
                    Ingående balanser balanserar inte ({formatCurrency(Math.abs(ibDiff))})
                  </p>
                  <p className="text-muted-foreground">
                    Vanligaste orsaken är att föregående års resultat aldrig fördes över till
                    eget kapital i det gamla programmet. SpeedLedger parkerar det till exempel på
                    egna 9xxx-konton (9030/9031 Obokat resultat), och då summerar inte filens
                    ingående balanser till noll: differensen är det oförda resultatet. En annan
                    orsak är en ofullständig export, till exempel att skulder saknas.
                  </p>
                  <p className="text-muted-foreground">
                    Rätta i källsystemet och ladda upp filen på nytt, eller lägg in de ingående
                    balanserna för hand i guiden Ingående balanser, där du kan rätta raderna
                    själv innan de bokförs (den här filen importeras då inte). Fortsätter du ändå
                    bokförs differensen på konto 2099 (Årets resultat), vilket nästan alltid blir
                    fel.
                  </p>
                  {onOpenManualOpeningBalances && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-1"
                      onClick={onOpenManualOpeningBalances}
                    >
                      Lägg in ingående balanser för hand
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
                  Jag förstår att differensen bokförs på 2099 och vill fortsätta ändå.
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
              : 'Hur väl kunde kontona i filen matchas mot din kontoplan'}
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
                  <p className="text-sm text-muted-foreground">Totalt</p>
                  <p className="font-medium">{preview.mappingStatus.total}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Mappade</p>
                  <p className="font-medium text-success">{preview.mappingStatus.mapped}</p>
                </div>
              </>
            )}
            <div>
              <p className="text-sm text-muted-foreground">Ej mappade</p>
              <p className={`font-medium tabular-nums ${preview.mappingStatus.unmapped > 0 ? 'text-destructive' : ''}`}>
                {preview.mappingStatus.unmapped}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Osäkra</p>
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
            {preview.excludedSystemAccounts.length} internt systemkonto från källsystemet exkluderades ({preview.excludedSystemAccounts.map((a) => a.number).join(', ')}), inte bokföringskonton
          </span>
        </div>
      )}

      {/* Create missing accounts */}
      {missingAccounts.length > 0 ? (
        <Card className="border-primary/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              Skapa saknade konton
            </CardTitle>
            <CardDescription>
              {missingAccounts.length} konton från SIE-filen finns inte i din kontoplan ännu.
              Klicka nedan för att skapa dem: de kopplas sedan automatiskt i nästa steg.
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
                    ... och {missingAccounts.length - 10} till
                  </div>
                )}
              </div>
              <Button
                onClick={onCreateAccounts}
                disabled={isCreatingAccounts}
                className="w-full"
              >
                {isCreatingAccounts ? (
                  <>Skapar konton...</>
                ) : (
                  <>Skapa {missingAccounts.length} konton</>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : preview.mappingStatus.mapped === preview.mappingStatus.total && preview.mappingStatus.total > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-success/50 bg-success/5 px-4 py-3 text-sm">
          <CheckCircle className="h-4 w-4 text-success flex-shrink-0" />
          <span>Alla konton skapade och automatiskt kopplade</span>
        </div>
      )}

      {/* Errors */}
      {errors.length > 0 && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-destructive" />
              Tolkningsfel ({errors.length})
            </CardTitle>
            <CardDescription>
              Dessa fel hittades under tolkningen av SIE-filen och kan påverka importresultatet.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {errors.map((issue, i) => (
                <div key={`error-${i}`} className="text-sm flex gap-2 text-destructive">
                  <XCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>
                    <span className="font-mono text-xs opacity-70">Rad {issue.line}</span>{' '}
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
              Varningar ({warnings.length})
            </CardTitle>
            <CardDescription>
              Dessa varningar blockerar inte importen men bör granskas.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {warnings.map((issue, i) => (
                <div key={`warning-${i}`} className="text-sm flex gap-2 text-warning">
                  <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>
                    <span className="font-mono text-xs opacity-70">Rad {issue.line}</span>{' '}
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
        <Button variant="outline" className="min-h-11" onClick={onBack}>
          Tillbaka
        </Button>
        <Button className="min-h-11" onClick={onContinue} disabled={blockContinue}>
          {preview.mappingStatus.lowConfidence > 0 || preview.mappingStatus.unmapped > 0
            ? 'Granska mappningar'
            : 'Fortsätt'}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
