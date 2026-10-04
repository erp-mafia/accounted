'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { usePosReasonText } from './reason-text'
import type { PosDayDetailJson } from './types'

interface Props {
  dayId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onBooked: () => void
}

const NUM = 'text-right tabular-nums'

/**
 * One POS day: what was sold per VAT rate, how it was paid, what a person
 * must look at, and the voucher it books as. Booking is confirmed here, up
 * front (convention 10): the outcome sentence says what the click does, and
 * the request pins the version of the day shown (expected_raw_sha256), so a
 * newer fetch can never be booked unseen.
 */
export default function PosDayDialog({ dayId, open, onOpenChange, onBooked }: Props) {
  const t = useTranslations('pos_sales')
  const errorLocale = useLocale() as ErrorLocale
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const reasonText = usePosReasonText()
  const [detail, setDetail] = useState<PosDayDetailJson | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [booking, setBooking] = useState(false)

  const load = useCallback(async () => {
    setLoadFailed(false)
    try {
      const res = await fetch(`/api/pos-sales/days/${dayId}`)
      if (!res.ok) throw new Error(`day failed: ${res.status}`)
      const json = (await res.json()) as { data: PosDayDetailJson }
      setDetail(json.data)
    } catch {
      setLoadFailed(true)
    }
  }, [dayId])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const day = detail?.day ?? null
  const booked = Boolean(day?.journal_entry_id)
  const blocking = detail ? detail.reasons.some((r) => r.code !== 'provider_issue') : false
  const needsAck = detail ? detail.reasons.length > 0 && detail.acknowledgeable : false
  const canBook =
    canWrite && !!day && !booked && day.status !== 'empty' && !blocking && detail!.proposal.lines.length > 0 && (!needsAck || acknowledged)

  async function book() {
    if (!day) return
    setBooking(true)
    try {
      const res = await fetch(`/api/pos-sales/days/${day.id}/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_raw_sha256: day.raw_sha256, ...(needsAck ? { acknowledge_issues: true } : {}) }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        toast({
          title: t('book_failed'),
          description: getErrorMessage(json, { context: 'transaction', statusCode: res.status, locale: errorLocale }),
          variant: 'destructive',
        })
        if (res.status === 409) void load()
        return
      }
      const voucher = json.data?.voucher_series && json.data?.voucher_number ? `${json.data.voucher_series}${json.data.voucher_number}` : ''
      toast({ title: t('booked_toast', { date: formatDate(day.business_date), voucher }) })
      onBooked()
    } catch {
      toast({ title: t('book_failed'), variant: 'destructive' })
    } finally {
      setBooking(false)
    }
  }

  const tendered = day ? day.tenders.reduce((sum, x) => sum + x.amount, 0) : 0
  const lines = detail?.proposal.lines ?? []
  const totalDebit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredit = lines.reduce((sum, l) => sum + l.credit_amount, 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{day ? t('dialog_title', { date: formatDate(day.business_date) }) : t('dialog_title_loading')}</DialogTitle>
          <DialogDescription>
            {detail
              ? t('dialog_description', {
                  venue: detail.connection.venue_name,
                  provider: detail.connection.provider_name,
                  receipts: detail.day.receipt_count,
                })
              : null}
          </DialogDescription>
        </DialogHeader>

        {loadFailed ? (
          <div className="space-y-4 py-6 text-center">
            <p className="text-[13px] text-muted-foreground">{t('load_failed')}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t('retry')}
            </Button>
          </div>
        ) : !detail || !day ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <div className="space-y-6">
            {detail.reasons.length > 0 && !booked ? (
              <div className="space-y-2">
                <AttnLine>{blocking ? t('review_blocking') : t('review_provider')}</AttnLine>
                <ul className="list-disc space-y-1 pl-4 text-[12.5px] text-muted-foreground">
                  {detail.reasons.map((reason, i) => (
                    <li key={i}>{reasonText(reason)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {day.changed_after_booking ? <AttnLine>{t('changed_after_booking')}</AttnLine> : null}

            <section className="space-y-2">
              <h3 className="font-sans text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('section_vat')}</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col_rate')}</TableHead>
                    <TableHead className="text-right">{t('col_net')}</TableHead>
                    <TableHead className="text-right">{t('col_vat')}</TableHead>
                    <TableHead className="text-right">{t('col_gross')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {day.vat_groups.map((g) => (
                    <TableRow key={g.ratePercent}>
                      <TableCell>{g.ratePercent === 0 ? t('rate_zero') : t('rate_label', { rate: g.ratePercent })}</TableCell>
                      <TableCell className={NUM}>{formatCurrency(g.net)}</TableCell>
                      <TableCell className={NUM}>{formatCurrency(g.vat)}</TableCell>
                      <TableCell className={NUM}>{formatCurrency(g.gross)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell className="font-medium">{t('total')}</TableCell>
                    <TableCell className={cn(NUM, 'font-medium')}>{formatCurrency(day.net)}</TableCell>
                    <TableCell className={cn(NUM, 'font-medium')}>{formatCurrency(day.vat)}</TableCell>
                    <TableCell className={cn(NUM, 'font-medium')}>{formatCurrency(day.gross)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </section>

            <section className="space-y-2">
              <h3 className="font-sans text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('section_payments')}</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col_tender')}</TableHead>
                    <TableHead className="text-right">{t('col_receipts')}</TableHead>
                    <TableHead className="text-right">{t('col_tips')}</TableHead>
                    <TableHead className="text-right">{t('col_amount')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {day.tenders.map((x) => (
                    <TableRow key={`${x.kind}:${x.method}`}>
                      <TableCell>
                        {t(`tender_${x.kind}`)}
                        {x.kind === 'other' ? <span className="text-muted-foreground"> ({x.method})</span> : null}
                      </TableCell>
                      <TableCell className={NUM}>{x.receiptCount}</TableCell>
                      <TableCell className={NUM}>{x.tips ? formatCurrency(x.tips) : ''}</TableCell>
                      <TableCell className={NUM}>{formatCurrency(x.amount)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell className="font-medium">{t('total')}</TableCell>
                    <TableCell />
                    <TableCell className={cn(NUM, 'font-medium')}>{formatCurrency(day.tips)}</TableCell>
                    <TableCell className={cn(NUM, 'font-medium')}>{formatCurrency(tendered)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              <p className="text-[12.5px] text-muted-foreground">
                {t('discounts_refunds', {
                  discounts: formatCurrency(detail.day.day.discounts),
                  refunds: detail.day.day.refunds.count,
                  refundAmount: formatCurrency(detail.day.day.refunds.gross),
                })}
              </p>
            </section>

            {lines.length > 0 ? (
              <section className="space-y-2">
                <h3 className="font-sans text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {booked ? t('section_lines_booked') : t('section_lines')}
                </h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('col_account')}</TableHead>
                      <TableHead>{t('col_text')}</TableHead>
                      <TableHead className="text-right">{t('col_debit')}</TableHead>
                      <TableHead className="text-right">{t('col_credit')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((l, i) => (
                      <TableRow key={i}>
                        <TableCell className="tabular-nums">{l.account_number}</TableCell>
                        <TableCell className="text-muted-foreground">{l.line_description ?? ''}</TableCell>
                        <TableCell className={NUM}>{l.debit_amount ? formatCurrency(l.debit_amount) : ''}</TableCell>
                        <TableCell className={NUM}>{l.credit_amount ? formatCurrency(l.credit_amount) : ''}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell />
                      <TableCell className="font-medium">{t('total')}</TableCell>
                      <TableCell className={cn(NUM, 'font-medium')}>{formatCurrency(totalDebit)}</TableCell>
                      <TableCell className={cn(NUM, 'font-medium')}>{formatCurrency(totalCredit)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </section>
            ) : null}

            {needsAck && !booked ? (
              <label className="flex items-center gap-2 text-[13px]">
                <Checkbox checked={acknowledged} onCheckedChange={(v) => setAcknowledged(v === true)} />
                <span>{t('acknowledge')}</span>
              </label>
            ) : null}

            {booked ? (
              <p className="text-[13px]">
                {t('booked_outcome')}{' '}
                <Link href={`/bookkeeping/${day.journal_entry_id}`} className="underline decoration-border underline-offset-4 hover:text-foreground">
                  {t('open_voucher')}
                </Link>
              </p>
            ) : day.status === 'empty' ? (
              <p className="text-[13px] text-muted-foreground">{t('empty_day')}</p>
            ) : canBook ? (
              <p className="text-[13px] text-muted-foreground">{t('confirm_outcome', { date: formatDate(day.business_date) })}</p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {day ? (
            <Button variant="outline" asChild>
              <a href={`/api/pos-sales/days/${day.id}/report`} target="_blank" rel="noopener noreferrer">
                {t('view_report')}
              </a>
            </Button>
          ) : null}
          {blocking && !booked ? (
            <Button variant="outline" asChild>
              <Link href="/settings/pos">{t('fix_mapping')}</Link>
            </Button>
          ) : null}
          {!booked && day?.status !== 'empty' ? (
            <Button onClick={() => void book()} disabled={!canBook} loading={booking}>
              {t('book_button')}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('close')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
