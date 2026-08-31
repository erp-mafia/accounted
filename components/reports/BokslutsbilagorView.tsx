'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { AlertCircle, FolderArchive } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { BokslutsbilagorReport } from '@/lib/reports/bokslutsbilagor-types'

/**
 * The bokslutsbilagor pärm on screen: one row per balance account as of the
 * balansdag (booked, per underlag, difference, sign-off, files) with the PDF
 * export; each row links into the Avstämning page where the work is done.
 */
interface BokslutsbilagorViewProps {
  periodId: string
}

export function BokslutsbilagorView({ periodId }: BokslutsbilagorViewProps) {
  const t = useTranslations('bokslutsbilagor')
  const locale = useLocale()
  const [report, setReport] = useState<BokslutsbilagorReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Keyed on periodId by the caller: a new period is a fresh mount, so the
  // initial loading state is the reset.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/reports/bokslutsbilagor?period_id=${encodeURIComponent(periodId)}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          setError(getErrorMessage(json, { statusCode: res.status }))
          return
        }
        setReport(json.data as BokslutsbilagorReport)
      })
      .catch(() => {
        if (!cancelled) setError(t('load_failed'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [periodId, t])

  if (loading) {
    return (
      <div className="space-y-3" aria-busy>
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-destructive">
          <AlertCircle className="mx-auto mb-2 h-6 w-6" />
          {error}
        </CardContent>
      </Card>
    )
  }
  if (!report || report.accounts.length === 0) {
    return <EmptyState icon={FolderArchive} title={t('empty_title')} description={t('empty_desc')} actionLabel={t('open_reconciliation')} actionHref="/reconciliation" />
  }

  const money = (n: number | null) => (n == null ? '-' : formatCurrency(n, 'SEK'))
  const externalLabel = (a: BokslutsbilagorReport['accounts'][number]) => (locale === 'en' ? a.external_label_en : a.external_label_sv)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground tabular-nums">
          {t('summary', {
            accounts: report.summary.accounts,
            signed: report.summary.signed_on_balansdag,
            files: report.summary.attachments,
            date: formatDate(report.period.end),
          })}
          {' · '}
          {t('checklist_summary', { done: report.checklist.summary.done + report.checklist.summary.not_applicable, total: report.checklist.summary.total })}
        </p>
        <ReportExportMenu items={[{ format: 'pdf', href: `/api/reports/bokslutsbilagor?period_id=${encodeURIComponent(periodId)}&format=pdf` }]} />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-[13px]">
              <thead>
                <tr>
                  <th className={cn(TH_CLASS, 'w-[240px]')}>{t('col_account')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_booked')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_external')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_difference')}</th>
                  <th className={TH_CLASS}>{t('col_signoff')}</th>
                  <th className={cn(TH_CLASS, 'text-right w-[70px]')}>{t('col_files')}</th>
                </tr>
              </thead>
              <tbody>
                {report.accounts.map((a) => {
                  const files = a.attachments.filter((f) => !f.removed_at).length
                  return (
                    <tr key={a.account_key} className="border-b border-border/60 last:border-b-0 align-top">
                      <td className={cn(TD_CLASS, 'max-w-0')}>
                        <Link href={`/reconciliation?account=${encodeURIComponent(a.account_key)}`} className={QUIET_LINK_CLASS} data-ph-mask>
                          <span className="tabular-nums">{a.account_number}</span> {a.name}
                        </Link>
                        <div className="truncate text-[11.5px] text-muted-foreground">{externalLabel(a)}</div>
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')} data-ph-mask>
                        {money(a.closing_balance)}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')} data-ph-mask>
                        {money(a.external_balance)}
                      </td>
                      <td
                        className={cn(
                          TD_CLASS,
                          'whitespace-nowrap text-right tabular-nums',
                          a.difference != null && Math.abs(a.difference) >= 0.005 && 'text-warning',
                        )}
                        data-ph-mask
                      >
                        {money(a.difference)}
                      </td>
                      <td className={cn(TD_CLASS, 'text-[12.5px]')}>
                        {a.signoff ? (
                          <span className={cn(!a.signoff.on_balansdag && 'text-warning')} data-ph-mask>
                            {a.signoff.on_balansdag
                              ? t('signed', { who: a.signoff.signed_by_label, when: formatDate(a.signoff.signed_at) })
                              : t('signed_other_date', { date: formatDate(a.signoff.through_date), who: a.signoff.signed_by_label })}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{t('unsigned')}</span>
                        )}
                      </td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')} data-ph-mask>
                        {files}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
