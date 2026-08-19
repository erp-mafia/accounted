'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ArrowLeft, ArrowRight, AlertTriangle, Calendar, FileText, Scale } from 'lucide-react'
import { formatCurrency, cn } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import type { SkattekontoFileParseResult } from '@/lib/import/skattekonto-file/types'

interface SkattekontoFilePreviewStepProps {
  parseResult: SkattekontoFileParseResult
  duplicateIndexes: number[]
  promotionIndexes: number[]
  orgNumberMismatch: boolean
  isLoading: boolean
  onExecute: () => void
  onBack: () => void
}

const PREVIEW_ROW_LIMIT = 100

export default function SkattekontoFilePreviewStep({
  parseResult,
  duplicateIndexes,
  promotionIndexes,
  orgNumberMismatch,
  isLoading,
  onExecute,
  onBack,
}: SkattekontoFilePreviewStepProps) {
  const t = useTranslations('import')
  const [mismatchConfirmed, setMismatchConfirmed] = useState(false)
  const [sumGapConfirmed, setSumGapConfirmed] = useState(false)
  const {
    rows,
    stats,
    issues,
    date_from,
    date_to,
    opening_saldo,
    closing_saldo,
    events_sum,
    sum_difference,
    sum_valid,
  } = parseResult

  const duplicateSet = new Set(duplicateIndexes)
  const promotionSet = new Set(promotionIndexes)
  const newCount = rows.length - duplicateIndexes.length
  const warnings = issues.filter((i) => i.severity !== 'error')
  // A statement that does not sum (truncated, filtered, unreadable rows) is
  // a confirm gate, not a block: nothing is booked at import and every event
  // is reviewed on the skattekonto page, so importing what IS in the file is
  // safe. The gate exists so the user knows the picture is incomplete.
  const sumGap = sum_valid === false
  const sumGapHasFigures =
    opening_saldo !== null && closing_saldo !== null && events_sum !== null && sum_difference !== null
  const importBlocked =
    (orgNumberMismatch && !mismatchConfirmed) || (sumGap && !sumGapConfirmed)

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <FileText className="h-4 w-4" />
              <span className="text-sm">{t('skattekonto_preview_rows')}</span>
            </div>
            <p className="text-2xl font-display tabular-nums">{stats.parsed_rows}</p>
            {stats.skipped_rows > 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                {t('skattekonto_preview_skipped', { count: stats.skipped_rows })}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Calendar className="h-4 w-4" />
              <span className="text-sm">{t('skattekonto_preview_period')}</span>
            </div>
            <p className="text-sm font-medium tabular-nums">
              {date_from || '-'} – {date_to || '-'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Scale className="h-4 w-4" />
              <span className="text-sm">{t('skattekonto_preview_closing_saldo')}</span>
            </div>
            <p className="text-lg font-display tabular-nums">
              {closing_saldo !== null ? formatCurrency(closing_saldo) : '-'}
            </p>
          </CardContent>
        </Card>
      </div>

      {orgNumberMismatch && (
        <Card className="border-destructive/40">
          <CardHeader className="py-3">
            <CardTitle className="text-sm flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              {t('skattekonto_org_mismatch_title')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              {t('skattekonto_org_mismatch_body', {
                orgNumber: parseResult.org_number ?? '?',
                companyName: parseResult.company_name ?? '?',
              })}
            </p>
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded-sm border-border"
                checked={mismatchConfirmed}
                onChange={(e) => setMismatchConfirmed(e.target.checked)}
              />
              <span>{t('skattekonto_org_mismatch_confirm')}</span>
            </label>
          </CardContent>
        </Card>
      )}

      {sumGap && (
        <Card className="border-destructive/40">
          <CardHeader className="py-3">
            <CardTitle className="text-sm flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              {t('skattekonto_sum_gap_title')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {sumGapHasFigures ? (
              <dl className="grid max-w-sm grid-cols-[auto_1fr] gap-x-6 gap-y-1 tabular-nums">
                <dt className="text-muted-foreground">{t('skattekonto_sum_gap_opening')}</dt>
                <dd className="text-right">{formatCurrency(opening_saldo)}</dd>
                <dt className="text-muted-foreground">{t('skattekonto_sum_gap_events')}</dt>
                <dd className="text-right">{formatCurrency(roundOre(events_sum - opening_saldo))}</dd>
                <dt className="text-muted-foreground">{t('skattekonto_sum_gap_expected')}</dt>
                <dd className="text-right">{formatCurrency(events_sum)}</dd>
                <dt className="text-muted-foreground">{t('skattekonto_sum_gap_closing')}</dt>
                <dd className="text-right">{formatCurrency(closing_saldo)}</dd>
                <dt className="font-medium">{t('skattekonto_sum_gap_difference')}</dt>
                <dd className="text-right font-medium">{formatCurrency(sum_difference)}</dd>
              </dl>
            ) : (
              <p className="text-muted-foreground">{t('skattekonto_sum_gap_no_saldo')}</p>
            )}
            <p className="text-muted-foreground">
              {stats.unreadable_amount_rows > 0
                ? t('skattekonto_sum_gap_body_unreadable', { count: stats.unreadable_amount_rows })
                : t('skattekonto_sum_gap_body')}
            </p>
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded-sm border-border"
                checked={sumGapConfirmed}
                onChange={(e) => setSumGapConfirmed(e.target.checked)}
              />
              <span>{t('skattekonto_sum_gap_confirm')}</span>
            </label>
          </CardContent>
        </Card>
      )}

      {duplicateIndexes.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {t('skattekonto_duplicates_note', { count: duplicateIndexes.length })}
        </p>
      )}

      {/* What happens after import: nothing is booked automatically, and an
          event that already has a 1630 verifikat (a deposit booked from the
          bank side) is offered as a link, not a second booking. Answers the
          "some of these are already booked" question before the click. */}
      <p className="text-sm text-muted-foreground">{t('skattekonto_after_import_note')}</p>

      {warnings.length > 0 && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm flex items-center gap-2 text-warning">
              <AlertTriangle className="h-4 w-4" />
              {t('skattekonto_issues_title', { count: warnings.length })}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-1">
            {warnings.slice(0, 5).map((issue, i) => (
              <p key={i}>
                {issue.row > 0 ? `${t('skattekonto_issue_row', { row: issue.row })}: ` : ''}
                {issue.message}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('skattekonto_col_date')}</TableHead>
                <TableHead>{t('skattekonto_col_text')}</TableHead>
                <TableHead className="text-right">{t('skattekonto_col_amount')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, PREVIEW_ROW_LIMIT).map((row, index) => {
                const isDuplicate = duplicateSet.has(index)
                return (
                  <TableRow key={index} className={cn(isDuplicate && 'opacity-60')}>
                    <TableCell className="tabular-nums">{row.transaktionsdatum}</TableCell>
                    <TableCell>{row.transaktionstext}</TableCell>
                    <TableCell
                      className={cn(
                        'text-right tabular-nums',
                        row.belopp < 0 ? 'text-destructive' : undefined,
                      )}
                    >
                      {formatCurrency(row.belopp)}
                    </TableCell>
                    <TableCell className="text-right">
                      {isDuplicate ? (
                        <Badge variant="secondary">{t('skattekonto_chip_duplicate')}</Badge>
                      ) : promotionSet.has(index) ? (
                        <Badge variant="outline">{t('skattekonto_chip_promotion')}</Badge>
                      ) : null}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          {rows.length > PREVIEW_ROW_LIMIT && (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              {t('skattekonto_preview_truncated', {
                shown: PREVIEW_ROW_LIMIT,
                total: rows.length,
              })}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack} disabled={isLoading}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('skattekonto_back')}
        </Button>
        <Button onClick={onExecute} disabled={isLoading || importBlocked || newCount === 0}>
          {t('skattekonto_import_button', { count: newCount })}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
