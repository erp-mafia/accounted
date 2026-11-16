'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { PercentBadgeIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { HelpPopover } from '@/components/ui/help-popover'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import type { LatePaymentInterestReport } from '@/lib/invoices/late-payment-interest-report'
import { cn, formatCurrency, formatDate } from '@/lib/utils'

const SECTION_HEADING_CLASS = 'text-[11px] font-medium uppercase tracking-wider text-muted-foreground'
const NUM_TH = cn(TH_CLASS, 'text-right')
const NUM_TD = cn(TD_CLASS, 'text-right tabular-nums')

/**
 * Dröjsmålsränta (accounted#38): the interest each customer invoice paid
 * late has earned, and what each overdue unpaid invoice has accrued, as the
 * basis for a räntefaktura. Reads only; nothing is booked or sent from here.
 * Only payments booked in Accounted count (see late-payment-interest-report.ts).
 * Linked from the invoice list's top bar.
 */
export default function LatePaymentInterestPage() {
  const t = useTranslations('latePaymentInterest')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const [report, setReport] = useState<LatePaymentInterestReport | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  const load = useCallback(async () => {
    setLoadFailed(false)
    try {
      const res = await fetch('/api/invoices/late-payment-interest', { cache: 'no-store' })
      const json = (await res.json().catch(() => null)) as { data?: LatePaymentInterestReport } | null
      if (res.ok && json?.data) setReport(json.data)
      else setLoadFailed(true)
    } catch {
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const percent = (rate: number) =>
    `${(rate * 100).toLocaleString(locale === 'en' ? 'en-GB' : 'sv-SE', { maximumFractionDigits: 2 })} %`

  const empty = report && report.paid_late.length === 0 && report.overdue_open.length === 0

  return (
    <div className="space-y-8">
      <PageHeader title={t('title')} help={<HelpPopover>{t('help')}</HelpPopover>} />

      {loadFailed && (
        <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
          <span>{t('load_failed')}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t('retry')}
          </Button>
        </div>
      )}

      {!report && !loadFailed && (
        <div className="space-y-3">
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {report && (
        <p className="text-[12.5px] text-muted-foreground">
          {t(report.rate_is_override ? 'rate_line_override' : 'rate_line', {
            rate: percent(report.rate),
            date: formatDate(report.as_of),
          })}
          {report.consumer_rate_ceiling !== null &&
            ` ${t('rate_line_consumer_ceiling', { rate: percent(report.consumer_rate_ceiling) })}`}
        </p>
      )}

      {empty && <EmptyState icon={PercentBadgeIcon} title={t('empty_title')} description={t('empty_description')} />}

      {report && !empty && (
        <>
          <section className="space-y-3">
            <h2 className={SECTION_HEADING_CLASS}>{t('paid_late_heading')}</h2>
            <p className="text-[12.5px] text-muted-foreground">{t('paid_late_scope')}</p>
            {report.paid_late.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t('paid_late_empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="stagger-enter w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className={TH_CLASS}>{t('col_invoice')}</th>
                      <th className={TH_CLASS}>{t('col_customer')}</th>
                      <th className={TH_CLASS}>{t('col_due')}</th>
                      <th className={TH_CLASS}>{t('col_paid')}</th>
                      <th className={NUM_TH}>{t('col_days_late')}</th>
                      <th className={NUM_TH}>{t('col_paid_late_amount')}</th>
                      <th className={NUM_TH}>{t('col_interest')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.paid_late.map((row) => (
                      <tr key={row.invoice_id} className="hover:bg-secondary/35">
                        <td className={cn(TD_CLASS, 'tabular-nums')}>
                          <Link href={`/invoices/${row.invoice_id}`} className="underline-offset-4 hover:underline">
                            {row.invoice_number}
                          </Link>
                        </td>
                        <td className={cn(TD_CLASS, 'max-w-[220px] truncate')} data-ph-mask>
                          {row.customer_name ?? ''}
                        </td>
                        <td className={cn(TD_CLASS, 'tabular-nums')}>{formatDate(row.due_date)}</td>
                        <td className={cn(TD_CLASS, 'tabular-nums')}>{formatDate(row.last_payment_date)}</td>
                        <td className={NUM_TD}>{row.days_late}</td>
                        <td className={NUM_TD}>{formatCurrency(row.paid_late_amount, row.currency)}</td>
                        <td className={NUM_TD}>{formatCurrency(row.interest, row.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {report.totals
                      .filter((total) => total.paid_late_interest > 0)
                      .map((total) => (
                        <tr key={total.currency}>
                          <td colSpan={6} className={cn(TD_CLASS, 'border-b-0 font-medium')}>
                            {t('total')}
                          </td>
                          <td className={cn(NUM_TD, 'border-b-0 font-medium')}>
                            {formatCurrency(total.paid_late_interest, total.currency)}
                          </td>
                        </tr>
                      ))}
                  </tfoot>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h2 className={SECTION_HEADING_CLASS}>{t('overdue_heading')}</h2>
            {report.overdue_open.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t('overdue_empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="stagger-enter w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className={TH_CLASS}>{t('col_invoice')}</th>
                      <th className={TH_CLASS}>{t('col_customer')}</th>
                      <th className={TH_CLASS}>{t('col_due')}</th>
                      <th className={NUM_TH}>{t('col_days_overdue')}</th>
                      <th className={NUM_TH}>{t('col_remaining')}</th>
                      <th className={NUM_TH}>{t('col_accrued')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.overdue_open.map((row) => (
                      <tr key={row.invoice_id} className="hover:bg-secondary/35">
                        <td className={cn(TD_CLASS, 'tabular-nums')}>
                          <Link href={`/invoices/${row.invoice_id}`} className="underline-offset-4 hover:underline">
                            {row.invoice_number}
                          </Link>
                        </td>
                        <td className={cn(TD_CLASS, 'max-w-[220px] truncate')} data-ph-mask>
                          {row.customer_name ?? ''}
                        </td>
                        <td className={cn(TD_CLASS, 'tabular-nums')}>{formatDate(row.due_date)}</td>
                        <td className={NUM_TD}>{row.days_overdue}</td>
                        <td className={NUM_TD}>{formatCurrency(row.remaining_amount, row.currency)}</td>
                        <td className={NUM_TD}>{formatCurrency(row.interest, row.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {report.totals
                      .filter((total) => total.overdue_interest > 0)
                      .map((total) => (
                        <tr key={total.currency}>
                          <td colSpan={5} className={cn(TD_CLASS, 'border-b-0 font-medium')}>
                            {t('total')}
                          </td>
                          <td className={cn(NUM_TD, 'border-b-0 font-medium')}>
                            {formatCurrency(total.overdue_interest, total.currency)}
                          </td>
                        </tr>
                      ))}
                  </tfoot>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
