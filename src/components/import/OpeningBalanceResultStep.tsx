'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ArrowRightIcon, CheckCircleIcon, XCircleIcon } from '@/components/icons'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { OpeningBalanceExecuteResult } from '@/lib/import/opening-balance/types'

interface OpeningBalanceResultStepProps {
  result: OpeningBalanceExecuteResult
  onNewImport: () => void
  /** The user came from a SIE preview: its vouchers are still to be imported. */
  onResumeSieImport?: () => void
}

export default function OpeningBalanceResultStep({
  result,
  onNewImport,
  onResumeSieImport,
}: OpeningBalanceResultStepProps) {
  const t = useTranslations('import')
  const isCorrection = !!result.reversed_entry_id
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          {result.success ? (
            <CheckCircleIcon className="h-6 w-6 text-success" />
          ) : (
            <XCircleIcon className="h-6 w-6 text-destructive" />
          )}
          <CardTitle>
            {result.success
              ? isCorrection
                ? 'Ingående balanser korrigerade'
                : 'Ingående balanser bokförda'
              : 'Importen misslyckades'}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {result.success ? (
          <>
            {/* Stats */}
            <div className="grid grid-cols-3 gap-4">
              <div className="rounded-lg border bg-muted/30 p-4 text-center">
                <p className="text-2xl font-semibold tabular-nums">
                  {result.lines_created}
                </p>
                <p className="text-sm text-muted-foreground mt-1">Kontorader</p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-4 text-center">
                <p className="text-2xl font-semibold tabular-nums">
                  {result.total_debit.toLocaleString('sv-SE', {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0,
                  })}
                </p>
                <p className="text-sm text-muted-foreground mt-1">Debet (SEK)</p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-4 text-center">
                <p className="text-2xl font-semibold tabular-nums">
                  {result.total_credit.toLocaleString('sv-SE', {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0,
                  })}
                </p>
                <p className="text-sm text-muted-foreground mt-1">Kredit (SEK)</p>
              </div>
            </div>

            {/* Next steps. Coming from a SIE preview, the one step left is
                its vouchers: the file was set aside, not imported. */}
            {onResumeSieImport ? (
              <p className="text-sm text-muted-foreground">{t('ob_result_resume_sie_hint')}</p>
            ) : (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Nästa steg</h4>
                <ol className="text-sm text-muted-foreground space-y-1.5 list-decimal list-inside">
                  <li>Granska verifikationen i bokföringen</li>
                  <li>Kontrollera balansrapporten att beloppen stämmer</li>
                  <li>Börja importera banktransaktioner eller skapa verifikationer</li>
                </ol>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-3">
              {onResumeSieImport && (
                <Button onClick={onResumeSieImport}>
                  {t('ob_result_resume_sie')}
                  <ArrowRightIcon className="h-4 w-4 ml-2" />
                </Button>
              )}
              {result.journal_entry_id && (
                <Button asChild variant={onResumeSieImport ? 'outline' : 'default'}>
                  <Link href={`/bookkeeping/${result.journal_entry_id}`}>
                    Visa verifikation
                    <ArrowRightIcon className="h-4 w-4 ml-2" />
                  </Link>
                </Button>
              )}
              <Button variant="outline" asChild>
                <Link href="/reports">
                  Visa rapporter
                </Link>
              </Button>
              <Button variant="ghost" onClick={onNewImport}>
                Ny import
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
              <p className="text-sm text-destructive">
                {result.error || 'Ett okänt fel uppstod vid importen.'}
              </p>
            </div>

            <div className="flex gap-3">
              <Button variant="outline" onClick={onNewImport}>
                Försök igen
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
