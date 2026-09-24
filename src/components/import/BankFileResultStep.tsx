'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  CheckCircle,
  XCircle,
  ArrowRight,
  RotateCcw,
} from 'lucide-react'
import type { IngestResult } from '@/types'

interface BankFileResultStepProps {
  result: IngestResult
  onNewImport: () => void
}

export default function BankFileResultStep({
  result,
  onNewImport,
}: BankFileResultStepProps) {
  const t = useTranslations('transactions')
  const isSuccess = result.imported > 0 || result.duplicates > 0

  return (
    <div className="space-y-6">
      {/* Status header */}
      <Card className={isSuccess ? 'border-border' : 'border-destructive/50'}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {isSuccess ? (
              <>
                <CheckCircle className="h-6 w-6 text-success" />
                {t('import_result_success_title')}
              </>
            ) : (
              <>
                <XCircle className="h-6 w-6 text-destructive" />
                {t('import_result_failed_title')}
              </>
            )}
          </CardTitle>
          <CardDescription>
            {isSuccess
              ? t('import_result_success_description', { count: result.imported })
              : t('import_result_failed_description', { count: result.errors })}
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
              <p className="font-medium text-destructive">{t('import_result_database_error')}</p>
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
            <CardTitle className="text-base">{t('import_result_next_steps')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-medium flex-shrink-0">
                1
              </div>
              <div>
                <p className="font-medium">{t('import_result_step_review_title')}</p>
                <p className="text-sm text-muted-foreground">
                  {result.imported - result.auto_categorized > 0
                    ? t('import_result_step_review_manual', { count: result.imported - result.auto_categorized })
                    : t('import_result_step_review_all_auto')}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-medium flex-shrink-0">
                2
              </div>
              <div>
                <p className="font-medium">{t('import_result_step_matches_title')}</p>
                <p className="text-sm text-muted-foreground">
                  {result.auto_matched_invoices > 0
                    ? t('import_result_step_matches_found', { count: result.auto_matched_invoices })
                    : t('import_result_step_matches_none')}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-medium flex-shrink-0">
                3
              </div>
              <div>
                <p className="font-medium">{t('import_result_step_more_title')}</p>
                <p className="text-sm text-muted-foreground">
                  {t('import_result_step_more_body')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Actions */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onNewImport}>
          <RotateCcw className="mr-2 h-4 w-4" />
          {t('import_result_new_import')}
        </Button>
        {isSuccess && (
          <Button asChild>
            <Link href="/transactions">
              {t('import_result_view_transactions')}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        )}
      </div>
    </div>
  )
}
