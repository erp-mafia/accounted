'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { LoadError } from '@/components/ui/empty-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TOOLBAR_FIELD_CLASS } from '@/components/ui/toolbar-search'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { OssAccountsSection } from '@/components/reports/OssAccountsSection'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { useFormat } from '@/lib/hooks/use-format'
import { cn, formatCurrency, formatDate, formatRowAmount } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { OssUnaccountedVoucher, OssUnderlag } from '@/lib/webshop-orders/oss-underlag'
import { stockholmYearMonth } from '@/lib/dates/iso'

/**
 * Underlag for the quarterly OSS declaration: the quarter's sales to
 * consumers in other EU countries per country and VAT rate, in euro, to type
 * into Skatteverket's e-tjänst. Every OSS-account verifikat the underlag does
 * not cover is listed under it, so a gap is never silent.
 */

const QUARTERS = [1, 2, 3, 4]

/**
 * Warnings about what the underlag holds, each shown beside the rows it is
 * about. Every other warning names something missing from the underlag.
 */
const IN_PLACE_WARNINGS = new Set(['vat_rate_mismatch', 'refund_vouchers_netted'])

function VoucherTable({ vouchers }: { vouchers: OssUnaccountedVoucher[] }) {
  const t = useTranslations('oss_underlag')
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('col_voucher')}</TableHead>
          <TableHead>{t('col_date')}</TableHead>
          <TableHead>{t('col_description')}</TableHead>
          <TableHead className="text-right">{t('col_vat_sek')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="stagger-enter">
        {vouchers.map((voucher) => (
          <TableRow key={voucher.journal_entry_id}>
            <TableCell className="tabular-nums">
              <Link href={`/bookkeeping/${voucher.journal_entry_id}`} className="underline-offset-4 hover:underline">
                {formatVoucher(voucher)}
              </Link>
            </TableCell>
            <TableCell className="date-figures">{formatDate(voucher.entry_date)}</TableCell>
            <TableCell className="max-w-64 truncate">{voucher.description}</TableCell>
            <TableCell className="text-right tabular-nums">{formatRowAmount(voucher.vat_sek)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** The last finished quarter: the one a declaration is due for. */
function lastClosedQuarter(now: Date): { year: number; quarter: number } {
  const { year, month } = stockholmYearMonth(now)
  const current = Math.ceil(month / 3)
  return current === 1 ? { year: year - 1, quarter: 4 } : { year, quarter: current - 1 }
}

/** Euro as declared: always two decimals, 9,00 and never 9 (the VAT is never rounded). */
function eur(amount: number | null): string {
  return amount === null ? '-' : formatCurrency(amount, 'EUR', { minimumFractionDigits: 2 })
}

export function OssUnderlagView() {
  const t = useTranslations('oss_underlag')
  const locale = useLocale()
  const { formatDateLong } = useFormat()
  const initial = lastClosedQuarter(new Date())
  const [year, setYear] = useState(initial.year)
  const [quarter, setQuarter] = useState(initial.quarter)

  // Fetch outcome tagged with the key it was requested under, so a stale
  // response never paints over the current picker state.
  const [result, setResult] = useState<{ key: string; data?: OssUnderlag; error?: string } | null>(null)

  const query = `year=${year}&quarter=${quarter}`
  // "Försök igen" asks again under a new key, so the skeleton shows meanwhile.
  const [attempt, setAttempt] = useState(0)
  const requestKey = `${query}#${attempt}`
  useEffect(() => {
    let cancelled = false
    fetch(`/api/webshop-orders/oss-underlag?${query}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          setResult({ key: requestKey, error: getErrorMessage(json, { statusCode: res.status, locale: locale as ErrorLocale }) })
          return
        }
        setResult({ key: requestKey, data: json.data as OssUnderlag })
      })
      .catch(() => {
        if (!cancelled) setResult({ key: requestKey, error: t('load_failed') })
      })
    return () => {
      cancelled = true
    }
  }, [query, requestKey, locale, t])

  const countryName = useMemo(() => {
    const names = new Intl.DisplayNames([locale === 'en' ? 'en' : 'sv'], { type: 'region' })
    return (code: string) => `${names.of(code) ?? code} (${code})`
  }, [locale])
  const percent = useMemo(() => new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'sv-SE'), [locale])
  const rateFormat = useMemo(
    () => new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'sv-SE', { maximumFractionDigits: 6 }),
    [locale],
  )

  const yearOptions = Array.from({ length: 5 }, (_, i) => stockholmYearMonth().year - i).filter((y) => y >= 2021)
  const upToDate = result !== null && result.key === requestKey
  const report = upToDate ? result.data ?? null : null
  const error = upToDate ? result.error ?? null : null
  const message = (w: { message_sv: string; message_en: string }) => (locale === 'en' ? w.message_en : w.message_sv)
  // No amounts, yet not a nil return (the underlag decides that, never this
  // view): something on the OSS accounts or among the orders is left outside.
  const emptyNotNil = !!report && !report.nil_return && report.rows.length === 0 && report.corrections.length === 0
  const missing = report ? report.warnings.filter((w) => !IN_PLACE_WARNINGS.has(w.code)) : []
  const inPlace = (code: string) => report?.warnings.find((w) => w.code === code)
  const incomplete =
    !!report && (emptyNotNil || report.unaccounted.length > 0 || missing.some((w) => w.code !== 'rate_unavailable'))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger className={cn(TOOLBAR_FIELD_CLASS, 'w-auto gap-1.5')} aria-label={t('year_label')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {yearOptions.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(quarter)} onValueChange={(v) => setQuarter(Number(v))}>
          <SelectTrigger className={cn(TOOLBAR_FIELD_CLASS, 'w-auto gap-1.5')} aria-label={t('quarter_label')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {QUARTERS.map((q) => (
              <SelectItem key={q} value={String(q)}>
                {t(`quarter_${q}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ReportExportMenu items={[{ format: 'xlsx', href: `/api/webshop-orders/oss-underlag/xlsx?${query}` }]} />
      </div>

      {!upToDate ? (
        <LateReveal className="space-y-3">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-40 w-full" />
        </LateReveal>
      ) : error || !report ? (
        <LoadError title={error ?? t('load_failed')} onRetry={() => setAttempt((n) => n + 1)} />
      ) : (
        <div className="space-y-6 animate-fade-in">
          {incomplete && <AttnLine>{t('attn_incomplete')}</AttnLine>}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <div className="text-xs text-muted-foreground">{t('sales_eur')}</div>
              <div className="font-display text-xl tabular-nums">{eur(report.totals.net_eur)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('vat_eur')}</div>
              <div className="font-display text-xl tabular-nums">{eur(report.totals.vat_eur)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('corrections_eur')}</div>
              <div className="font-display text-xl tabular-nums">{eur(report.totals.corrections_vat_eur)}</div>
            </div>
          </div>
          <p className="text-[13px] text-muted-foreground">
            {report.nil_return
              ? t('nil_return', { date: formatDateLong(report.period.deadline) })
              : emptyNotNil
                ? t('nil_unconfirmed', { date: formatDateLong(report.period.deadline) })
                : t('deadline', { date: formatDateLong(report.period.deadline) })}
          </p>

          {report.rows.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('heading_rows')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('col_country')}</TableHead>
                      <TableHead className="text-right">{t('col_rate')}</TableHead>
                      <TableHead className="text-right">{t('col_net_eur')}</TableHead>
                      <TableHead className="text-right">{t('col_vat_eur')}</TableHead>
                      <TableHead className="text-right">{t('col_vat_sek')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="stagger-enter">
                    {report.rows.map((row) => (
                      <TableRow key={`${row.country}-${row.vat_rate}`}>
                        <TableCell>
                          <span className="inline-flex items-center gap-2">
                            {countryName(row.country)}
                            {row.rate_mismatch && <Badge variant="warning">{t('rate_mismatch_chip')}</Badge>}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums whitespace-nowrap">{percent.format(row.vat_rate)}&nbsp;%</TableCell>
                        <TableCell className="text-right tabular-nums">{eur(row.net_eur)}</TableCell>
                        <TableCell className="text-right tabular-nums">{eur(row.vat_eur)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{formatRowAmount(row.vat_sek)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={2} className="font-medium">{t('total')}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{eur(report.totals.net_eur)}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{eur(report.totals.vat_eur)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(report.totals.vat_sek)}</TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
                {inPlace('vat_rate_mismatch') && <p className="text-[13px]">{message(inPlace('vat_rate_mismatch')!)}</p>}
              </CardContent>
            </Card>
          )}

          {report.corrections.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('heading_corrections')}</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('col_country')}</TableHead>
                      <TableHead>{t('col_period')}</TableHead>
                      <TableHead className="text-right">{t('col_vat_eur')}</TableHead>
                      <TableHead className="text-right">{t('col_vat_sek')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="stagger-enter">
                    {report.corrections.map((correction) => (
                      <TableRow key={`${correction.country}-${correction.period.label}`}>
                        <TableCell>{countryName(correction.country)}</TableCell>
                        <TableCell className="tabular-nums">{correction.period.label}</TableCell>
                        <TableCell className="text-right tabular-nums">{eur(correction.vat_eur)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{formatRowAmount(correction.vat_sek)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {missing.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('heading_warnings')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-[13px]">
                {missing.map((w) => (
                  <div key={w.code}>
                    <p>{message(w)}</p>
                    {w.order_numbers.length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                        {t('orders_label', { numbers: w.order_numbers.join(', ') })}
                      </p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {report.accounts.length > 0 && (
            <OssAccountsSection key={requestKey} accounts={report.accounts} onSaved={() => setAttempt((n) => n + 1)} />
          )}

          {report.unaccounted.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('heading_unaccounted')}</CardTitle>
              </CardHeader>
              <CardContent>
                <VoucherTable vouchers={report.unaccounted} />
              </CardContent>
            </Card>
          )}

          {report.refund_vouchers.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('heading_refund_vouchers')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {inPlace('refund_vouchers_netted') && (
                  <p className="text-[13px]">{message(inPlace('refund_vouchers_netted')!)}</p>
                )}
                <VoucherTable vouchers={report.refund_vouchers} />
              </CardContent>
            </Card>
          )}

          <div className="space-y-1 text-xs text-muted-foreground">
            {report.rates.map((rate) =>
              rate.rate !== null && rate.rate_date ? (
                <p key={`${rate.currency}-${rate.for_date}`} className="tabular-nums">
                  {t('rate_line', { rate: rateFormat.format(rate.rate), currency: rate.currency, date: formatDate(rate.rate_date) })}
                </p>
              ) : (
                <p key={`${rate.currency}-${rate.for_date}`} className="tabular-nums">
                  {t('rate_missing', { currency: rate.currency, date: formatDate(rate.for_date) })}
                </p>
              ),
            )}
            <p className="tabular-nums">
              {t('ledger_line', {
                ledger: formatCurrency(report.ledger_vat_sek),
                underlag: formatCurrency(report.totals.vat_sek + report.totals.corrections_vat_sek),
              })}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
