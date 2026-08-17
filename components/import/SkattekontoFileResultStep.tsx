'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { CheckCircle } from 'lucide-react'

export interface SkattekontoFileImportResult {
  imported: number
  duplicates: number
  promoted: number
  errors: number
}

interface SkattekontoFileResultStepProps {
  result: SkattekontoFileImportResult
  onNewImport: () => void
}

export default function SkattekontoFileResultStep({
  result,
  onNewImport,
}: SkattekontoFileResultStepProps) {
  const t = useTranslations('import')

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <CheckCircle className="h-12 w-12 text-success" />
            <div>
              <p className="font-display text-xl">{t('skattekonto_result_title')}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {t('skattekonto_result_summary', {
                  imported: result.imported,
                  duplicates: result.duplicates,
                })}
                {result.promoted > 0 &&
                  ` ${t('skattekonto_result_promoted', { count: result.promoted })}`}
              </p>
              {result.errors > 0 && (
                <p className="mt-1 text-sm text-destructive">
                  {t('skattekonto_result_errors', { count: result.errors })}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
        <Button asChild>
          <Link href="/skattekonto">{t('skattekonto_result_open_skattekonto')}</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/transactions">{t('skattekonto_result_book_rows')}</Link>
        </Button>
        <Button variant="outline" onClick={onNewImport}>
          {t('skattekonto_result_new_import')}
        </Button>
      </div>
    </div>
  )
}
