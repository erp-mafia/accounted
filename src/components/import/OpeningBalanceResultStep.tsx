'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { CheckCircle2, XCircle, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { OpeningBalanceExecuteResult } from '@/lib/import/opening-balance/types'

interface OpeningBalanceResultStepProps {
  result: OpeningBalanceExecuteResult
  onNewImport: () => void
}

export default function OpeningBalanceResultStep({
  result,
  onNewImport,
}: OpeningBalanceResultStepProps) {
  const t = useTranslations('opening_balance_result_step')
  const isCorrection = !!result.reversed_entry_id
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          {result.success ? (
            <CheckCircle2 className="h-6 w-6 text-success" />
          ) : (
            <XCircle className="h-6 w-6 text-destructive" />
          )}
          <CardTitle>
            {result.success
              ? isCorrection
                ? t('title_corrected')
                : t('title_posted')
              : t('title_failed')}
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
                <p className="text-sm text-muted-foreground mt-1">{t('stat_lines')}</p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-4 text-center">
                <p className="text-2xl font-semibold tabular-nums">
                  {result.total_debit.toLocaleString('sv-SE', {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0,
                  })}
                </p>
                <p className="text-sm text-muted-foreground mt-1">{t('stat_debit')}</p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-4 text-center">
                <p className="text-2xl font-semibold tabular-nums">
                  {result.total_credit.toLocaleString('sv-SE', {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0,
                  })}
                </p>
                <p className="text-sm text-muted-foreground mt-1">{t('stat_credit')}</p>
              </div>
            </div>

            {/* Next steps */}
            <div className="space-y-2">
              <h4 className="text-sm font-medium">{t('next_steps')}</h4>
              <ol className="text-sm text-muted-foreground space-y-1.5 list-decimal list-inside">
                <li>{t('next_step_review')}</li>
                <li>{t('next_step_check_balance')}</li>
                <li>{t('next_step_import')}</li>
              </ol>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap gap-3">
              {result.journal_entry_id && (
                <Button asChild>
                  <Link href={`/bookkeeping/${result.journal_entry_id}`}>
                    {t('view_voucher')}
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Link>
                </Button>
              )}
              <Button variant="outline" asChild>
                <Link href="/reports">
                  {t('view_reports')}
                </Link>
              </Button>
              <Button variant="ghost" onClick={onNewImport}>
                {t('new_import')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
              <p className="text-sm text-destructive">
                {result.error || t('unknown_error')}
              </p>
            </div>

            <div className="flex gap-3">
              <Button variant="outline" onClick={onNewImport}>
                {t('retry')}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
