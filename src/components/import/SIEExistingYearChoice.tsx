'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDate, formatRowAmount } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { AccountMapping } from '@/lib/import/types'
import type { SIEAppendPlan, SIEAppendVerdict } from '@/lib/import/sie-append'

export type ExistingYearMode = 'block' | 'replace' | 'append'

interface SIEExistingYearChoiceProps {
  mode: ExistingYearMode
  onModeChange: (mode: ExistingYearMode) => void
  /** A verifikat-only file: it can be appended, never replace the year (crm#1049). */
  appendOnly: boolean
  storagePath: string | null
  filename: string | null
  mappings: AccountMapping[]
  includePossibleDuplicates: boolean
  onIncludePossibleDuplicatesChange: (include: boolean) => void
  seriesMap: Record<string, string>
  onSeriesMapChange: (map: Record<string, string>) => void
  /** The plan as last read, so the review step can hold back a refused append. */
  onPlan: (plan: SIEAppendPlan | null) => void
}

const SHOWN_ROWS = 100

const VERDICT_BADGE: Partial<Record<SIEAppendVerdict, 'warning' | 'destructive'>> = {
  conflict: 'destructive',
  possible_duplicate: 'warning',
}

/**
 * What happens to a fiscal year that already holds an import (issue #108):
 * add only the file's new vouchers (the default; a verifikat-only file has
 * no other choice), or replace the year's import. The append shows its plan
 * before anything is submitted, read by the same planner the import runs.
 */
export function SIEExistingYearChoice({
  mode, onModeChange, appendOnly, storagePath, filename, mappings,
  includePossibleDuplicates, onIncludePossibleDuplicatesChange, seriesMap, onSeriesMapChange, onPlan,
}: SIEExistingYearChoiceProps) {
  const t = useTranslations('import.sie_append')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const [plan, setPlan] = useState<SIEAppendPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (mode !== 'append' || !storagePath || !filename) {
      setPlan(null)
      onPlan(null)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const form = new FormData()
    form.append('storagePath', storagePath)
    form.append('filename', filename)
    form.append('mappings', JSON.stringify(mappings))
    form.append('options', JSON.stringify({ includePossibleDuplicates, seriesMap }))
    fetch('/api/import/sie/append-plan', { method: 'POST', body: form, signal: controller.signal })
      .then(async (res) => {
        const body = await res.json()
        if (!res.ok) throw body
        setPlan(body.data as SIEAppendPlan)
        onPlan(body.data as SIEAppendPlan)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        setPlan(null)
        onPlan(null)
        setError(getErrorMessage(err, { locale }))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
    // onPlan is the page's state setter; the plan depends on the inputs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, storagePath, filename, mappings, includePossibleDuplicates, seriesMap, locale])

  const newSeries = plan?.series.filter((series) => !series.exists) ?? []
  const rows = plan?.vouchers ?? []

  return (
    <section className="space-y-4 rounded-lg p-4 bg-control shadow-raised">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px]">{appendOnly ? t('title_vouchers_only') : t('title')}</p>
        <Select value={mode} onValueChange={(value) => onModeChange(value as ExistingYearMode)}>
          <SelectTrigger className="h-8 w-64 px-3" aria-label={t('choice_label')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="append">{appendOnly ? t('choice_append_vouchers_only') : t('choice_append')}</SelectItem>
            {!appendOnly && <SelectItem value="replace">{t('choice_replace')}</SelectItem>}
          </SelectContent>
        </Select>
      </div>

      {mode === 'replace' && <p className="text-xs text-muted-foreground">{t('replace_hint')}</p>}

      {mode === 'append' && loading && !plan && (
        <LateReveal className="space-y-2">
          <Skeleton className="h-4 w-2/3 rounded-sm" />
          <Skeleton className="h-4 w-1/2 rounded-sm" />
        </LateReveal>
      )}

      {mode === 'append' && error && <p className="text-[13px] text-destructive">{error}</p>}

      {mode === 'append' && plan && (
        <div className="space-y-4 animate-fade-in">
          {plan.refusal ? (
            <p className="text-[13px] text-destructive">{plan.refusal.message}</p>
          ) : (
            <p className="text-[13px] tabular-nums">
              {t('summary', { add: plan.counts.toAdd, present: plan.counts.present })}
            </p>
          )}

          {plan.counts.possibleDuplicates > 0 && (
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="sie-append-duplicates" className="text-[13px] font-normal">
                {t('include_duplicates', { count: plan.counts.possibleDuplicates })}
              </Label>
              <Switch id="sie-append-duplicates" checked={includePossibleDuplicates}
                onCheckedChange={onIncludePossibleDuplicatesChange} />
            </div>
          )}

          {newSeries.map((series) => (
            <div key={series.source} className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[13px]">{t('new_series', { series: series.source, count: series.vouchers })}</p>
              <Select value={seriesMap[series.source] ?? series.source}
                onValueChange={(target) => {
                  const next = { ...seriesMap }
                  if (target === series.source) delete next[series.source]
                  else next[series.source] = target
                  onSeriesMapChange(next)
                }}>
                <SelectTrigger className="h-8 w-48 px-3" aria-label={t('series_label', { series: series.source })}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={series.source}>{t('series_keep', { series: series.source })}</SelectItem>
                  {plan.yearSeries.map((target) => (
                    <SelectItem key={target} value={target}>{t('series_to', { series: target })}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}

          {plan.warnings.length > 0 && (
            <ul className="space-y-1 text-xs text-attn">
              {plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          )}

          {rows.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('col_date')}</TableHead>
                  <TableHead>{t('col_voucher')}</TableHead>
                  <TableHead>{t('col_text')}</TableHead>
                  <TableHead className="text-right">{t('col_amount')}</TableHead>
                  <TableHead>{t('col_outcome')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="stagger-enter">
                {rows.slice(0, SHOWN_ROWS).map((row) => {
                  const added = row.verdict === 'new' || (row.verdict === 'possible_duplicate' && includePossibleDuplicates)
                  const badge = VERDICT_BADGE[row.verdict]
                  return (
                    <TableRow key={row.sourceOrdinal}>
                      <TableCell className="date-figures">{formatDate(row.date)}</TableCell>
                      <TableCell className="tabular-nums">{row.sourceId}</TableCell>
                      <TableCell className="max-w-64 truncate">{row.description}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRowAmount(row.amount)}</TableCell>
                      <TableCell>
                        {badge ? (
                          <Badge variant={badge}>
                            {t(`verdict_${row.verdict}`, { voucher: row.matchedVoucher ?? '' })}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">
                            {added ? (row.yearEnd ? t('verdict_year_end') : t('verdict_new')) : t('verdict_skipped')}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
          {(rows.length > SHOWN_ROWS || plan.vouchersTruncated) && (
            <p className="text-xs text-muted-foreground">{t('more_rows', { count: plan.counts.total - plan.counts.present - Math.min(rows.length, SHOWN_ROWS) })}</p>
          )}
        </div>
      )}
    </section>
  )
}
