'use client'

import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  CheckCircle,
  XCircle,
  AlertCircle,
  FileText,
  ExternalLink,
  RotateCcw,
  Info,
  Undo2,
} from 'lucide-react'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import type { ImportResult } from '@/lib/import/types'

interface ImportResultStepProps {
  result: ImportResult
  onNewImport: () => void
  onUndo?: (importId: string) => Promise<void> | void
}

export default function ImportResultStep({ result, onNewImport, onUndo }: ImportResultStepProps) {
  const { dialogProps, confirm } = useDestructiveConfirm()

  const handleUndoClick = async () => {
    if (!result.importId || !onUndo) return
    const ok = await confirm({
      title: 'Ångra hela importen?',
      description: `Detta raderar ${result.journalEntriesCreated} verifikation${result.journalEntriesCreated === 1 ? '' : 'er'} och rensar ingående balanser från den här importen. Bifogade dokument blir okopplade men finns kvar.`,
      confirmLabel: 'Ångra import',
    })
    if (!ok) return
    await onUndo(result.importId)
  }
  const hasErrors = result.errors.length > 0
  const skipped = result.details?.skippedVouchers

  // Filter out raw "hoppades över" warnings when we have structured data
  const otherWarnings = skipped && skipped.total > 0
    ? result.warnings.filter((w) => !w.includes('hoppades över'))
    : result.warnings

  return (
    <div className="space-y-6">
      {/* Success/Failure header */}
      <Card className={result.success ? 'border-border' : 'border-destructive/50'}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {result.success ? (
              <>
                <CheckCircle className="h-6 w-6 text-success" />
                Import genomförd
              </>
            ) : (
              <>
                <XCircle className="h-6 w-6 text-destructive" />
                Import misslyckades
              </>
            )}
          </CardTitle>
          <CardDescription>
            {result.success
              ? skipped && skipped.total > 0
                ? `Din bokföring har importerats. ${result.journalEntriesCreated} verifikationer skapades, ${skipped.total} hoppades över — se detaljer nedan.`
                : 'Din bokföring har importerats framgångsrikt.'
              : 'Det uppstod fel under importen. Läs felmeddelanden nedan för att förstå vad som gick snett och hur du kan åtgärda det.'}
          </CardDescription>
        </CardHeader>
      </Card>

      {/* IB resync notice (prior-year backfill) */}
      {result.success && result.nextPeriodIBResync && (
        <Card className="border-success/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle className="h-5 w-5 text-success" />
              Ingående balanser synkades om
            </CardTitle>
            <CardDescription>
              Eftersom du importerade ett tidigare räkenskapsår uppdaterades ingående balanser för{' '}
              <span className="font-medium">{result.nextPeriodIBResync.nextPeriodName}</span>{' '}
              automatiskt (gammal IB makulerad, ny IB skapad från utgående balans).
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {result.success && result.nextPeriodIBResyncSkipped && (
        <Card className="border-warning/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-warning">
              <AlertCircle className="h-5 w-5" />
              Ingående balanser för {result.nextPeriodIBResyncSkipped.nextPeriodName} kunde inte synkas
            </CardTitle>
            <CardDescription>
              Nästa räkenskapsår är låst eller stängt. Lås upp perioden och kör importen igen om du
              vill att ingående balanser ska uppdateras automatiskt.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Dimensions detected (lossless SIE round-trip, dimensions plan PR5) */}
      {result.success && result.dimensionsImported && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Info className="h-5 w-5 text-muted-foreground" />
              Dimensioner följde med importen
            </CardTitle>
            <CardDescription>
              Filen innehöll kostnadsställen/projekt: {result.dimensionsImported.taggedLines}{' '}
              taggade rader importerades
              {result.dimensionsImported.values > 0 && (
                <> och {result.dimensionsImported.values} nya värden lades till i registret</>
              )}
              .{' '}
              {result.dimensionsImported.toggleEnabled && (
                <>Dimensioner aktiverades automatiskt för företaget — du hittar registret under{' '}
                <Link href="/dimensions" className="underline underline-offset-4">
                  Kostnadsställen &amp; projekt
                </Link>
                .</>
              )}
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Statistics */}
      {result.success && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <FileText className="h-4 w-4" />
                <span className="text-sm">Verifikationer skapade</span>
              </div>
              <p className="text-2xl font-display tabular-nums">{result.journalEntriesCreated}</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <span className="text-sm">Räkenskapsår</span>
              </div>
              <div className="text-2xl font-display">
                {result.fiscalPeriodId ? (
                  <Badge variant="success">Skapat</Badge>
                ) : (
                  <Badge variant="secondary">Befintligt</Badge>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <span className="text-sm">Ingående balanser</span>
              </div>
              <div className="text-2xl font-display">
                {result.openingBalanceEntryId ? (
                  <Badge variant="success">Importerade</Badge>
                ) : (
                  <Badge variant="secondary">Inga</Badge>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Errors */}
      {hasErrors && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <XCircle className="h-5 w-5" />
              Fel ({result.errors.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {result.errors.map((error, i) => (
                <div key={i} className="text-sm flex gap-2">
                  <XCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              ))}
            </div>
            {!result.success && (
              <div className="text-sm text-muted-foreground border-t pt-3 space-y-1">
                <p className="font-medium">Vad kan du göra?</p>
                <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                  <li>Kontrollera att SIE-filen exporterades korrekt från källsystemet</li>
                  <li>Prova att exportera filen igen och ladda upp på nytt</li>
                  <li>Om felet kvarstår, kontakta support med felmeddelandet ovan</li>
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Skipped vouchers — structured breakdown */}
      {skipped && skipped.total > 0 && (
        <Card className="border-muted-foreground/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-muted-foreground">
              <Info className="h-5 w-5" />
              Hoppade över {skipped.total} verifikationer
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {skipped.empty > 0 && (
                <div className="text-sm">
                  <p className="font-medium">{skipped.empty} tomma verifikationer</p>
                  <p className="text-muted-foreground">
                    Platshållare utan bokföringsrader — vanligt i Fortnox och Visma. Påverkar inte din bokföring.
                  </p>
                </div>
              )}
              {skipped.unbalanced > 0 && (
                <div className="text-sm">
                  <p className="font-medium">{skipped.unbalanced} obalanserade verifikationer</p>
                  <p className="text-muted-foreground">
                    Debet och kredit stämmer inte överens i källsystemet. Saldon har justerats automatiskt.
                  </p>
                </div>
              )}
              {skipped.singleLine > 0 && (
                <div className="text-sm">
                  <p className="font-medium">{skipped.singleLine} enradsverifikationer</p>
                  <p className="text-muted-foreground">
                    Verifikationer med bara en rad (t.ex. periodiseringar). Kräver minst två rader för dubbelbokning.
                  </p>
                </div>
              )}
              {skipped.unmapped > 0 && (
                <div className="text-sm">
                  <p className="font-medium">{skipped.unmapped} verifikationer med ej kopplade konton</p>
                  <p className="text-muted-foreground">
                    Innehåller konton som inte kunde kopplas till din kontoplan.
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Other warnings (filtered) */}
      {otherWarnings.length > 0 && (
        <Card className="border-warning/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-warning">
              <AlertCircle className="h-5 w-5" />
              Varningar ({otherWarnings.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {otherWarnings.map((warning, i) => (
                <div key={i} className="text-sm flex gap-2">
                  <AlertCircle className="h-4 w-4 text-warning flex-shrink-0 mt-0.5" />
                  <span>{warning}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Next steps */}
      {result.success && (
        <Card className="bg-muted/50">
          <CardHeader>
            <CardTitle className="text-base">Nästa steg</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-medium">
                1
              </div>
              <div>
                <p className="font-medium">Granska importerade verifikationer</p>
                <p className="text-sm text-muted-foreground">
                  Kontrollera att allt ser korrekt ut i bokföringslistan
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-medium">
                2
              </div>
              <div>
                <p className="font-medium">Verifiera balanserna</p>
                <p className="text-sm text-muted-foreground">
                  Jämför huvudboken med din tidigare bokföring
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-medium">
                3
              </div>
              <div>
                <p className="font-medium">Fortsätt med ny bokföring</p>
                <p className="text-sm text-muted-foreground">
                  Nu kan du börja lägga till nya transaktioner
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Actions */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" className="min-h-11" onClick={onNewImport}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Ny import
          </Button>
          {result.success && result.importId && onUndo && (
            <Button variant="outline" className="min-h-11 text-destructive hover:text-destructive" onClick={handleUndoClick}>
              <Undo2 className="mr-2 h-4 w-4" />
              Ångra import
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          {result.success && (
            <>
              <Button variant="outline" className="min-h-11" asChild>
                <Link href="/bookkeeping">
                  Visa bokföring
                  <ExternalLink className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button className="min-h-11" asChild>
                <Link href="/reports">
                  Visa rapporter
                  <ExternalLink className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </>
          )}
        </div>
      </div>

      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}
