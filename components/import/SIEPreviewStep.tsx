'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatCurrency } from '@/lib/utils'
import {
  Building2,
  Calendar,
  FileText,
  CheckCircle,
  AlertCircle,
  XCircle,
  ArrowRight,
  BarChart3,
  Info,
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
}

export default function SIEPreviewStep({
  preview,
  issues,
  missingAccounts,
  onCreateAccounts,
  isCreatingAccounts,
  onContinue,
  onBack,
}: SIEPreviewStepProps) {
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')

  // Only block on actual parsing errors, not unmapped accounts
  // (users need to proceed to mapping step to fix unmapped accounts)
  const hasBlockingErrors = errors.length > 0

  return (
    <div className="space-y-6">
      {/* Company info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
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
      <Card>
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
          </div>
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
            <p className="text-2xl font-display font-medium tabular-nums">{preview.accountCount}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <BarChart3 className="h-4 w-4" />
              <span className="text-sm">Verifikationer</span>
            </div>
            <p className="text-2xl font-display font-medium tabular-nums">{preview.voucherCount}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <span className="text-sm">Transaktionsrader</span>
            </div>
            <p className="text-2xl font-display font-medium tabular-nums">{preview.transactionLineCount}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <span className="text-sm">IB Summa</span>
            </div>
            <p className="text-2xl font-display font-medium tabular-nums">{formatCurrency(preview.openingBalanceTotal)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Trial balance check */}
      <Card className={preview.trialBalance.isBalanced ? 'border-success/50' : 'border-warning/50'}>
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
                <Badge variant="default" className="bg-success">Balanserar</Badge>
              ) : (
                <Badge variant="secondary">
                  Diff: {formatCurrency(preview.trialBalance.totalDebit - preview.trialBalance.totalCredit)}
                </Badge>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Mapping status */}
      <Card
        className={
          preview.mappingStatus.unmapped > 0
            ? 'border-destructive/50'
            : preview.mappingStatus.lowConfidence > 0
            ? 'border-warning/50'
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
            Kontomappning
          </CardTitle>
          <CardDescription>
            Hur väl kunde kontona i filen matchas mot din kontoplan
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div>
              <p className="text-sm text-muted-foreground">Totalt</p>
              <p className="font-medium">{preview.mappingStatus.total}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Mappade</p>
              <p className="font-medium text-success">{preview.mappingStatus.mapped}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Ej mappade</p>
              <p className={`font-medium ${preview.mappingStatus.unmapped > 0 ? 'text-destructive' : ''}`}>
                {preview.mappingStatus.unmapped}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Osäkra</p>
              <p className={`font-medium ${preview.mappingStatus.lowConfidence > 0 ? 'text-warning' : ''}`}>
                {preview.mappingStatus.lowConfidence}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Excluded system accounts info */}
      {preview.excludedSystemAccounts.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>
            {preview.excludedSystemAccounts.length} internt systemkonto från källsystemet exkluderades ({preview.excludedSystemAccounts.map((a) => a.number).join(', ')}) — inte bokföringskonton
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
              Klicka nedan för att skapa dem — de kopplas sedan automatiskt i nästa steg.
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

      {/* Issues */}
      {(errors.length > 0 || warnings.length > 0) && (
        <Card className={errors.length > 0 ? 'border-destructive/50' : 'border-warning/50'}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {errors.length > 0 ? (
                <XCircle className="h-5 w-5 text-destructive" />
              ) : (
                <AlertCircle className="h-5 w-5 text-warning" />
              )}
              {errors.length > 0 ? 'Fel' : 'Varningar'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {errors.map((issue, i) => (
                <div key={`error-${i}`} className="text-sm flex gap-2 text-destructive">
                  <XCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>Rad {issue.line}: {issue.message}</span>
                </div>
              ))}
              {warnings.map((issue, i) => (
                <div key={`warning-${i}`} className="text-sm flex gap-2 text-warning">
                  <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>Rad {issue.line}: {issue.message}</span>
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
        <Button className="min-h-11" onClick={onContinue} disabled={hasBlockingErrors}>
          {preview.mappingStatus.lowConfidence > 0 || preview.mappingStatus.unmapped > 0
            ? 'Granska mappningar'
            : 'Fortsätt'}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
