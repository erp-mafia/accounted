'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { isAccountNumber } from '@/lib/invariants'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { useSpendKindText, useSpendReasonText } from './reason-text'
import type { SpendItemDetailJson } from './types'

interface Props {
  itemId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onBooked: () => void
}

const NUM = 'text-right tabular-nums'
const SECTION = 'font-sans text-xs font-medium text-muted-foreground'

/**
 * One card or spend platform expense: how it was coded at the provider, the
 * receipts that came with it, what a person must look at, and the verifikat
 * it books as. Booking is confirmed here, up front (convention 10): the
 * outcome sentence says what the click does, and the request pins the
 * version shown (expected_raw_sha256), so a newer export can never be
 * booked unseen.
 */
export default function SpendItemDialog({ itemId, open, onOpenChange, onBooked }: Props) {
  const t = useTranslations('spend')
  const errorLocale = useLocale() as ErrorLocale
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const reasonText = useSpendReasonText()
  const kindText = useSpendKindText()
  const [detail, setDetail] = useState<SpendItemDetailJson | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [debitAccount, setDebitAccount] = useState('')
  const [booking, setBooking] = useState(false)

  const load = useCallback(async () => {
    setLoadFailed(false)
    try {
      const res = await fetch(`/api/spend/items/${itemId}`)
      if (!res.ok) throw new Error(`item failed: ${res.status}`)
      const json = (await res.json()) as { data: SpendItemDetailJson }
      setDetail(json.data)
    } catch {
      setLoadFailed(true)
    }
  }, [itemId])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const item = detail?.item ?? null
  const booked = Boolean(item?.journal_entry_id)
  const bookable = !!item && !booked && (item.status === 'ready' || item.status === 'review') && item.ack_outcome === 'received'
  const needsAck = !!detail && detail.reasons.length > 0
  const needsDebitAccount = !!detail && detail.reasons.some((r) => r.code === 'counter_account_needed')
  const debitAccountValid = isAccountNumber(debitAccount)
  const canBook =
    canWrite &&
    bookable &&
    (!needsAck || acknowledged) &&
    (needsDebitAccount ? debitAccountValid : detail!.proposal.lines.length > 0)

  async function book() {
    if (!item) return
    setBooking(true)
    try {
      const res = await fetch(`/api/spend/items/${item.id}/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expected_raw_sha256: item.raw_sha256,
          ...(needsAck ? { acknowledge_review: true } : {}),
          ...(needsDebitAccount ? { debit_account: debitAccount } : {}),
        }),
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
      const voucher = json.data?.voucher_series && json.data?.voucher_number ? formatVoucher(json.data) : ''
      toast({ title: t('booked_toast', { voucher }) })
      onBooked()
    } catch {
      toast({ title: t('book_failed'), variant: 'destructive' })
    } finally {
      setBooking(false)
    }
  }

  const expense = item?.expense ?? null
  const lines = detail?.proposal.lines ?? []
  const totalDebit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
  const title = item ? `${kindText(item.kind)}${item.merchant_name ? ` ${item.merchant_name}` : ''}` : t('dialog_title_loading')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {item && detail
              ? t('dialog_description', {
                  date: formatDate(item.expense_date),
                  amount: formatCurrency(item.amount),
                  person: item.person_name ?? t('unknown_person'),
                  provider: detail.connection.provider_name,
                })
              : null}
          </DialogDescription>
        </DialogHeader>

        {loadFailed ? (
          <div className="space-y-4 py-6 text-center">
            <p className="text-[13px] text-muted-foreground">{t('load_failed')}</p>
            <Button variant="outline" onClick={() => void load()}>
              {t('retry')}
            </Button>
          </div>
        ) : !detail || !item || !expense ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <div className="space-y-6">
            {item.status === 'rejected' ? (
              <div className="space-y-2">
                <AttnLine>{t('rejected_intro', { provider: detail.connection.provider_name })}</AttnLine>
                <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  {item.reasons.map((reason, i) => (
                    <li key={i}>{reasonText(reason)}</li>
                  ))}
                </ul>
              </div>
            ) : detail.reasons.length > 0 && !booked ? (
              <div className="space-y-2">
                <AttnLine>{t('review_intro')}</AttnLine>
                <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  {detail.reasons.map((reason, i) => (
                    <li key={i}>{reasonText(reason)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {item.status === 'no_entry' ? <p className="text-[13px] text-muted-foreground">{t('no_entry_explained')}</p> : null}
            {item.changed_after_booking ? <AttnLine>{t('changed_after_booking')}</AttnLine> : null}
            {item.ack_outcome === null && item.status !== 'rejected' ? (
              <p className="text-[13px] text-muted-foreground">{t('still_receiving')}</p>
            ) : null}

            {expense.lines.length > 0 ? (
              <section className="space-y-2">
                <h3 className={SECTION}>{t('section_coding')}</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('col_account')}</TableHead>
                      <TableHead>{t('col_vat_code')}</TableHead>
                      <TableHead>{t('col_dimensions')}</TableHead>
                      <TableHead className="text-right">{t('col_amount')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {expense.lines.map((l, i) => (
                      <TableRow key={i}>
                        <TableCell className="tabular-nums">{l.account ?? ''}</TableCell>
                        <TableCell className="text-muted-foreground">{l.vat?.code ?? ''}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {Object.entries(l.dimensions).map(([dim, value]) => `${dim}: ${value}`).join(', ')}
                        </TableCell>
                        <TableCell className={NUM}>{formatCurrency(l.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {expense.note ? <p className="text-xs text-muted-foreground">{expense.note}</p> : null}
                {expense.attendees.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t('attendees', { names: expense.attendees.map((a) => (a.company ? `${a.name} (${a.company})` : a.name)).join(', ') })}
                  </p>
                ) : null}
              </section>
            ) : null}

            <section className="space-y-2">
              <h3 className={SECTION}>{t('section_receipts')}</h3>
              {item.document_ids.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">{t('no_receipt')}</p>
              ) : (
                <ul className="space-y-1 text-[13px]">
                  {item.document_ids.map((documentId, i) => (
                    <li key={documentId}>
                      <a
                        href={`/api/documents/${documentId}/inline`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline decoration-border underline-offset-4 hover:text-foreground"
                      >
                        {t('receipt_label', { number: i + 1 })}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {needsDebitAccount && bookable ? (
              <div className="space-y-2">
                <Label htmlFor="spend-debit-account">{t('debit_account_label')}</Label>
                <Input
                  id="spend-debit-account"
                  inputMode="numeric"
                  maxLength={4}
                  value={debitAccount}
                  onChange={(e) => setDebitAccount(e.target.value.replace(/\D/g, ''))}
                  className="w-32 tabular-nums"
                />
                <p className="text-xs text-muted-foreground">{t('debit_account_help')}</p>
              </div>
            ) : null}

            {lines.length > 0 ? (
              <section className="space-y-2">
                <h3 className={SECTION}>{booked ? t('section_lines_booked') : t('section_lines')}</h3>
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

            {needsAck && bookable ? (
              <label className="flex items-center gap-2 text-[13px]">
                <Checkbox checked={acknowledged} onCheckedChange={(v) => setAcknowledged(v === true)} />
                <span>{t('acknowledge')}</span>
              </label>
            ) : null}

            {booked ? (
              <p className="text-[13px]">
                {t('booked_outcome')}{' '}
                <Link href={`/bookkeeping/${item.journal_entry_id}`} className="underline decoration-border underline-offset-4 hover:text-foreground">
                  {t('open_voucher')}
                </Link>
              </p>
            ) : canBook ? (
              <p className="text-[13px] text-muted-foreground">{t('confirm_outcome')}</p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {expense?.providerUrl ? (
            <Button variant="outline" asChild>
              <a href={expense.providerUrl} target="_blank" rel="noopener noreferrer">
                {t('open_at_provider', { provider: detail?.connection.provider_name ?? '' })}
              </a>
            </Button>
          ) : null}
          {bookable ? (
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
