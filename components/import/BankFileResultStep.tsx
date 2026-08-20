'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import {
  CheckCircle,
  XCircle,
  ArrowRight,
  RotateCcw,
  Undo2,
  Loader2,
} from 'lucide-react'
import type { IngestResult } from '@/lib/transactions/ingest'

interface BankFileResultStepProps {
  result: IngestResult
  onNewImport: () => void
  /** bank_file_imports id of the batch just imported; enables undo (#1672). */
  importId?: string | null
  /** Undo the whole import (unbooked rows, ignored included). Owner/admin only. */
  onUndo?: (importId: string) => Promise<void> | void
  isUndoing?: boolean
}

export default function BankFileResultStep({
  result,
  onNewImport,
  importId = null,
  onUndo,
  isUndoing = false,
}: BankFileResultStepProps) {
  const t = useTranslations('transactions')
  const { dialogProps, confirm } = useDestructiveConfirm()
  const isSuccess = result.imported > 0 || result.duplicates > 0

  const handleUndoClick = async () => {
    if (!importId || !onUndo) return
    const ok = await confirm({
      title: t('import_undo_confirm_title'),
      description: t('import_undo_confirm_body'),
      confirmLabel: t('import_undo_confirm_label'),
    })
    if (!ok) return
    await onUndo(importId)
  }

  return (
    <div className="space-y-6">
      {/* Status header */}
      <Card className={isSuccess ? 'border-border' : 'border-destructive/50'}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {isSuccess ? (
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
            {isSuccess
              ? `${result.imported} transaktioner importerades framgångsrikt.`
              : `${result.errors} fel uppstod under importen.`}
          </CardDescription>
          {/* Close the silent-dedup loop: without this line, skipped rows just
              look like they vanished (fewer imported than parsed, no
              explanation). */}
          {result.duplicates > 0 && (
            <CardDescription>
              {t('import_duplicate_result', { count: result.duplicates })}
            </CardDescription>
          )}
        </CardHeader>
        {!isSuccess && result.first_error && (
          <CardContent>
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <p className="font-medium text-destructive">Databasfel</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground break-all">
                {result.first_error.message}
                {result.first_error.details ? `: ${result.first_error.details}` : ''}
                {result.first_error.code ? ` (${result.first_error.code})` : ''}
              </p>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Next steps */}
      {isSuccess && (
        <Card className="bg-muted/50">
          <CardHeader>
            <CardTitle className="text-base">Nästa steg</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-medium flex-shrink-0">
                1
              </div>
              <div>
                <p className="font-medium">Granska obokförda transaktioner</p>
                <p className="text-sm text-muted-foreground">
                  {result.imported - result.auto_categorized > 0
                    ? `${result.imported - result.auto_categorized} transaktioner behöver bokföras manuellt.`
                    : 'Alla transaktioner bokfördes automatiskt.'}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-medium flex-shrink-0">
                2
              </div>
              <div>
                <p className="font-medium">Bekräfta fakturamatchningar</p>
                <p className="text-sm text-muted-foreground">
                  {result.auto_matched_invoices > 0
                    ? `${result.auto_matched_invoices} transaktioner matchades mot fakturor. Bekräfta dessa på transaktionssidan.`
                    : 'Inga automatiska fakturamatchningar hittades.'}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-medium flex-shrink-0">
                3
              </div>
              <div>
                <p className="font-medium">Importera fler kontoutdrag</p>
                <p className="text-sm text-muted-foreground">
                  Importera löpande kontoutdrag för att hålla bokföringen uppdaterad.
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
          {isSuccess && result.imported > 0 && importId && onUndo && (
            <Button
              variant="outline"
              className="min-h-11 text-destructive hover:text-destructive"
              onClick={handleUndoClick}
              disabled={isUndoing}
            >
              {isUndoing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Undo2 className="mr-2 h-4 w-4" />
              )}
              {t('import_undo_button')}
            </Button>
          )}
        </div>
        {isSuccess && (
          <Button className="min-h-11" asChild>
            <Link href="/transactions">
              Visa transaktioner
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        )}
      </div>

      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}
