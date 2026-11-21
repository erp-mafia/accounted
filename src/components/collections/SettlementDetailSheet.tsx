'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Label } from '@/components/ui/label'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { LoadError } from '@/components/ui/empty-state'
import { Textarea } from '@/components/ui/textarea'
import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/components/ui/use-toast'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SlideOver, SlideOverBody, SlideOverContent, SlideOverFooter, SlideOverHeader } from '@/components/ui/slide-over'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { DocumentViewButton } from '@/components/bookkeeping/DocumentViewButton'
import { capitalizeFirst } from '@/components/collections/collections-client'
import { settlementsCall } from '@/components/collections/settlements-client'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useAccounts } from '@/lib/reference-data/hooks'
import {
  bookingChoices,
  formatSettlementAmount,
  LINE_KIND_KEYS,
  SETTLEMENT_STATUS_KEYS,
  SETTLEMENT_STATUS_VARIANTS,
  settlementBookable,
  settlementBookingSentenceKey,
  settlementReasonKey,
  settlementVoucherRows,
  VAT_COST,
  VAT_DEDUCTIBLE,
  type LineChoiceState,
  type SettlementDetail,
  type VoucherPreviewRow,
} from '@/lib/collections/settlements-ui'
import { accountWithName } from '@/lib/collections/voucher-text'
import { getBasLoadedByNumber } from '@/lib/bookkeeping/bas-lazy'
import { useBasReference } from '@/lib/bookkeeping/use-bas-reference'
import { cn, formatDate } from '@/lib/utils'

interface SettlementDetailSheetProps {
  settlementId: string | null
  /** The provider's words for the `settlements` strings ({provider}, {providerOwner}). */
  words: { provider: string; providerOwner: string }
  canWrite: boolean
  onClose: () => void
  /** Called after a booking or a decision changed the payout, so the list reloads. */
  onChanged: () => void
}

type BookingAnswer = {
  outcome: 'booked' | 'needs_mapping' | 'ignored'
  journal_entry_id?: string
  reason?: string
  settlement?: SettlementDetail | null
}

/**
 * One payout in a right slide-over (design convention 13): its lines with
 * the account each books to, a choice where the ledger could not place a
 * line, the settlement PDF, and the booking. A payout held as a possible
 * duplicate shows the voucher the guard found and the two answers.
 */
export function SettlementDetailSheet({ settlementId, words, canWrite, onClose, onChanged }: SettlementDetailSheetProps) {
  const t = useTranslations('settlements')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { toast } = useToast()
  const [detail, setDetail] = useState<SettlementDetail | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [choices, setChoices] = useState<Record<number, LineChoiceState>>({})
  const [confirm, setConfirm] = useState<'book' | 'not_duplicate' | 'handled' | null>(null)
  const [reason, setReason] = useState('')
  // The booking confirm says in plain words what is booked; the voucher's rows sit behind "Visa verifikationen".
  const [showVoucher, setShowVoucher] = useState(false)
  const needsAnyAccount = detail?.lines.some((line) => line.needsAccount === 'any') ?? false
  const { accounts } = useAccounts(true)

  const tw = useCallback((key: string, values: Record<string, string | number> = {}) => capitalizeFirst(t(key, { ...words, ...values })), [t, words])

  const load = useCallback(async (id: string) => {
    const result = await settlementsCall<SettlementDetail>(`/api/collections/settlements/${id}`)
    setLoadFailed(!result.ok)
    if (result.ok) setDetail(result.data)
  }, [])

  // The page keys the sheet by the payout's id, so a new payout starts from empty state.
  useEffect(() => {
    if (settlementId) void load(settlementId)
  }, [settlementId, load])

  const pendingChoices = useMemo(() => (detail ? bookingChoices(detail, choices) : null), [detail, choices])
  // The voucher the booking posts, with the person's choices as they stand: shown before any booking, live.
  const voucherRows = useMemo(() => (detail ? settlementVoucherRows(detail, choices) : null), [detail, choices])

  const answer = (data: BookingAnswer) => {
    if (data.settlement) setDetail(data.settlement)
    onChanged()
    if (data.outcome === 'booked') {
      toast({
        title: t('toast_booked'),
        action: data.journal_entry_id ? (
          <ToastAction altText={t('toast_show_voucher')} asChild>
            <Link href={`/bookkeeping/${data.journal_entry_id}`}>{t('toast_show_voucher')}</Link>
          </ToastAction>
        ) : undefined,
      })
    } else if (data.outcome === 'ignored') {
      toast({ title: t('toast_ignored') })
    } else {
      const key = settlementReasonKey(data.reason ?? null) ?? 'reason_default'
      toast({ title: t('toast_needs_mapping'), description: tw(key), variant: 'destructive' })
    }
  }

  const refusal = (body: unknown) => toast({ title: t('toast_failed'), description: getErrorMessage(body, { locale }), variant: 'destructive' })

  const book = async () => {
    if (!detail || !pendingChoices) return
    const result = await settlementsCall<BookingAnswer>(`/api/collections/settlements/${detail.id}/book`, 'POST', pendingChoices.length > 0 ? { lines: pendingChoices } : {})
    if (result.ok) answer(result.data)
    else refusal(result.body)
  }

  const resolve = async (resolution: 'not_duplicate' | 'handled_elsewhere') => {
    if (!detail) return
    const body = resolution === 'handled_elsewhere' ? { resolution, reason: reason.trim() } : { resolution }
    const result = await settlementsCall<BookingAnswer>(`/api/collections/settlements/${detail.id}/duplicate`, 'POST', body)
    if (result.ok) answer(result.data)
    else refusal(result.body)
  }

  const setChoice = (position: number, patch: LineChoiceState) => setChoices((prev) => ({ ...prev, [position]: { ...prev[position], ...patch } }))

  const reasonKey = detail?.status === 'needs_mapping' ? settlementReasonKey(detail.needsMappingReason) : null
  const isDuplicate = detail?.status === 'needs_mapping' && detail.needsMappingReason === 'possible_duplicate'
  // A line for a claim the books do not know (handed to the provider outside Accounted): booked by hand, then marked here.
  const isUnknownCase = detail?.status === 'needs_mapping' && detail.needsMappingReason === 'unknown_case'
  const canMarkHandled = isDuplicate || isUnknownCase
  const variant = detail ? SETTLEMENT_STATUS_VARIANTS[detail.status] : null

  return (
    <SlideOver open={settlementId !== null} onOpenChange={(open) => !open && onClose()}>
      <SlideOverContent aria-describedby={undefined}>
        <SlideOverHeader
          kicker={detail ? t('detail_kicker', { reference: detail.providerSettlementRef }) : undefined}
          title={detail ? <span className="tabular-nums">{formatSettlementAmount(detail.amount)}</span> : <Skeleton className="h-6 w-32" />}
          closeLabel={t('close')}
        />
        <SlideOverBody className="space-y-6">
          {loadFailed && settlementId && (
            <LoadError title={t('load_failed')} onRetry={() => void load(settlementId)} />
          )}
          {!detail && !loadFailed && (
            <LateReveal className="space-y-3">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-24 w-full" />
            </LateReveal>
          )}
          {detail && (
            <>
              <div className="space-y-2 text-[13px]">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="tabular-nums text-muted-foreground">{t('detail_paid', { date: formatDate(detail.paymentDate) })}</span>
                  {variant ? (
                    <Badge variant={variant}>{t(SETTLEMENT_STATUS_KEYS[detail.status])}</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t(SETTLEMENT_STATUS_KEYS[detail.status])}</span>
                  )}
                  {detail.journalEntryId && (
                    <Link href={`/bookkeeping/${detail.journalEntryId}`} className="underline underline-offset-4">
                      {t('voucher_link', { number: detail.voucher ?? '' })}
                    </Link>
                  )}
                </div>
                {reasonKey && !isDuplicate && <p className="attn text-xs">{tw(reasonKey)}</p>}
                {isDuplicate && (
                  <p className="attn text-xs">
                    {detail.duplicateOf?.voucher ? (
                      <>
                        {tw('duplicate_body', { voucher: detail.duplicateOf.voucher })}{' '}
                        <Link href={`/bookkeeping/${detail.duplicateOf.journalEntryId}`} className="underline underline-offset-4">
                          {t('voucher_link', { number: detail.duplicateOf.voucher ?? '' })}
                        </Link>
                      </>
                    ) : (
                      tw('duplicate_body_unknown')
                    )}
                  </p>
                )}
                {detail.status === 'failed' && <p className="text-muted-foreground">{tw('failed_body')}</p>}
                {detail.status === 'ignored' && detail.ignoredReason && (
                  <p className="text-muted-foreground">{t('ignored_reason', { reason: detail.ignoredReason })}</p>
                )}
                {detail.documentAttachmentId && <DocumentViewButton documentId={detail.documentAttachmentId} label={t('document')} />}
              </div>

              <section className="space-y-2">
                <h2 className="text-xs font-medium text-muted-foreground">{t('lines_heading')}</h2>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('col_line')}</TableHead>
                      <TableHead className="text-right">{t('col_amount')}</TableHead>
                      <TableHead className="w-[150px]">{t('col_account')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.lines.map((line) => {
                      const label = tw(LINE_KIND_KEYS[line.kind], { type: line.providerType })
                      const inVoucher = line.inPayout && line.kind !== 'informational'
                      const chosen = choices[line.position] ?? {}
                      // Deductions read as negative, so the lines add up to the payout in the title.
                      const signed = (amount: number) => (line.direction === 'debit' ? -amount : amount)
                      return [
                        <TableRow key={`l${line.position}`}>
                          <TableCell className="text-[13px]">{label}</TableCell>
                          <TableCell className={cn('text-right tabular-nums text-[13px]', !inVoucher && 'text-muted-foreground')}>
                            {formatSettlementAmount(signed(line.amount))}
                          </TableCell>
                          <TableCell className="text-[13px]">
                            {line.needsAccount === 'vat' && canWrite ? (
                              <VatSelect value={chosen.account ?? ''} onChange={(account) => setChoice(line.position, { account })} t={t} />
                            ) : line.needsAccount === 'any' && canWrite ? (
                              <AccountCombobox
                                value={chosen.account ?? ''}
                                accounts={accounts}
                                onChange={(account) => setChoice(line.position, { account })}
                                className="h-8"
                              />
                            ) : inVoucher ? (
                              <span className="tabular-nums">{line.accountNumber ?? t('choose_account')}</span>
                            ) : (
                              <span className="text-muted-foreground">{t('line_not_booked')}</span>
                            )}
                          </TableCell>
                        </TableRow>,
                        line.taxAmount !== 0 && inVoucher && (line.needsVatAccount || line.vatAccountNumber) ? (
                          <TableRow key={`v${line.position}`}>
                            <TableCell className="pl-8 text-[13px] text-muted-foreground">{t('line_vat')}</TableCell>
                            <TableCell className="text-right tabular-nums text-[13px]">{formatSettlementAmount(signed(line.taxAmount))}</TableCell>
                            <TableCell className="text-[13px]">
                              {line.needsVatAccount && canWrite ? (
                                <VatSelect value={chosen.vatAccount ?? ''} onChange={(vatAccount) => setChoice(line.position, { vatAccount })} t={t} />
                              ) : (
                                <span className="tabular-nums">{line.vatAccountNumber ?? t('choose_account')}</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ) : null,
                      ]
                    })}
                  </TableBody>
                </Table>
                {needsAnyAccount && accounts.length === 0 && <Skeleton className="h-4 w-40" />}
              </section>

              {/* What the booking posts, before it is booked: a row that waits for a choice above reads as waiting, then follows it. */}
              {voucherRows && settlementBookable(detail) && (
                <section className="space-y-2">
                  <h2 className="text-xs font-medium text-muted-foreground">{t('voucher_heading')}</h2>
                  <VoucherTable rows={voucherRows} accounts={accounts} t={t} />
                </section>
              )}

              {canMarkHandled && canWrite && (
                <div className="space-y-2">
                  <Label htmlFor="settlement-handled-reason">{t('duplicate_reason_label')}</Label>
                  <Textarea
                    id="settlement-handled-reason"
                    value={reason}
                    maxLength={500}
                    placeholder={t('duplicate_reason_placeholder')}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </div>
              )}
            </>
          )}
        </SlideOverBody>
        {detail && canWrite && (canMarkHandled || settlementBookable(detail)) && (
          <SlideOverFooter>
            {isDuplicate ? (
              <>
                <Button variant="outline" disabled={reason.trim().length === 0} onClick={() => setConfirm('handled')}>
                  {t('duplicate_handled')}
                </Button>
                <Button onClick={() => setConfirm('not_duplicate')}>{t('duplicate_not_duplicate')}</Button>
              </>
            ) : (
              <>
                {/* Bokför waits for an account on a line: say which step is missing, not only grey the button. */}
                {settlementBookable(detail) && pendingChoices === null && (
                  <span className="mr-auto text-xs text-muted-foreground">{t('book_needs_account')}</span>
                )}
                {/* An unknown claim stays unbookable until the books know its case: answering how it was handled is the step, booking is only a retry. */}
                {isUnknownCase && settlementBookable(detail) && (
                  <Button
                    variant="outline"
                    disabled={pendingChoices === null}
                    title={pendingChoices === null ? t('book_needs_account') : undefined}
                    onClick={() => setConfirm('book')}
                  >
                    {t('book')}
                  </Button>
                )}
                {isUnknownCase && (
                  <Button disabled={reason.trim().length === 0} onClick={() => setConfirm('handled')}>
                    {t('duplicate_handled')}
                  </Button>
                )}
                {!isUnknownCase && settlementBookable(detail) && (
                  <Button
                    disabled={pendingChoices === null}
                    title={pendingChoices === null ? t('book_needs_account') : undefined}
                    onClick={() => setConfirm('book')}
                  >
                    {t('book')}
                  </Button>
                )}
              </>
            )}
          </SlideOverFooter>
        )}
      </SlideOverContent>

      {detail && (
        <>
          <ConfirmDialog
            open={confirm === 'book'}
            onOpenChange={(open) => {
              if (!open) {
                setConfirm(null)
                setShowVoucher(false)
              }
            }}
            title={t('confirm_book_title')}
            description={tw(settlementBookingSentenceKey(detail.lines), {
              amount: formatSettlementAmount(detail.amount),
              date: formatDate(detail.paymentDate),
            })}
            confirmLabel={t('book')}
            onConfirm={book}
          >
            {voucherRows && (
              <button
                type="button"
                className="text-xs underline underline-offset-2"
                aria-expanded={showVoucher}
                onClick={() => setShowVoucher((v) => !v)}
              >
                {showVoucher ? t('hide_voucher') : t('show_voucher')}
              </button>
            )}
            {voucherRows && showVoucher && <VoucherTable rows={voucherRows} accounts={accounts} t={t} />}
          </ConfirmDialog>
          <ConfirmDialog
            open={confirm === 'not_duplicate'}
            onOpenChange={(open) => !open && setConfirm(null)}
            title={t('not_duplicate_confirm_title')}
            description={
              detail.duplicateOf?.voucher
                ? tw('not_duplicate_confirm_body', { voucher: detail.duplicateOf.voucher, date: formatDate(detail.paymentDate) })
                : tw('not_duplicate_confirm_body_unknown', { date: formatDate(detail.paymentDate) })
            }
            confirmLabel={t('duplicate_not_duplicate')}
            onConfirm={() => resolve('not_duplicate')}
          />
          <ConfirmDialog
            open={confirm === 'handled'}
            onOpenChange={(open) => !open && setConfirm(null)}
            title={t('duplicate_confirm_title')}
            description={tw(isUnknownCase ? 'unknown_case_confirm_body' : 'duplicate_confirm_body')}
            confirmLabel={t('duplicate_confirm')}
            onConfirm={() => resolve('handled_elsewhere')}
          />
        </>
      )}
    </SlideOver>
  )
}

/** The voucher's rows with account names from the chart; a row waiting for the person's choice says so. */
function VoucherTable({
  rows,
  accounts,
  t,
}: {
  rows: VoucherPreviewRow[]
  accounts: ReadonlyArray<{ account_number: string; account_name: string | null }>
  t: (key: string) => string
}) {
  // Names an account the company chart does not hold yet (BAS standard name), once the chunk lands.
  useBasReference()
  return (
    <table className="w-full border-collapse text-[13px]" aria-label={t('confirm_voucher_heading')}>
      <thead>
        <tr className="text-xs text-muted-foreground">
          <th className="py-1 text-left font-normal">{t('col_account')}</th>
          <th className="py-1 text-right font-normal">{t('col_debit')}</th>
          <th className="py-1 text-right font-normal">{t('col_credit')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.accountNumber ?? 'waiting'}-${index}`} className="border-t-hairline">
            <td className={cn('py-1 pr-3', row.waiting && 'text-attn')}>
              {row.accountNumber
                ? accountWithName(row.accountNumber, accounts, getBasLoadedByNumber(row.accountNumber)?.account_name)
                : t('voucher_waiting')}
            </td>
            <td className="py-1 text-right tabular-nums">{row.debit ? formatSettlementAmount(row.debit) : ''}</td>
            <td className="py-1 text-right tabular-nums">{row.credit ? formatSettlementAmount(row.credit) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function VatSelect({ value, onChange, t }: { value: string; onChange: (account: string) => void; t: (key: string) => string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 text-[13px]">
        <SelectValue placeholder={t('choose_vat_account')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={VAT_DEDUCTIBLE}>{t('account_vat_deductible')}</SelectItem>
        <SelectItem value={VAT_COST}>{t('account_vat_cost')}</SelectItem>
      </SelectContent>
    </Select>
  )
}
