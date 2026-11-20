'use client'

import { useState, useEffect, useMemo } from 'react'
import { useAccounts, useCashAccounts, useCompanySettings, usePaymentBankLedger } from '@/lib/reference-data/hooks'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/use-toast'
import { KonteringLinesEditor } from '@/components/bookkeeping/KonteringLinesEditor'
import LinkVoucherPicker from '@/components/invoices/LinkVoucherPicker'
import { carriedSekOf } from '@/lib/bookkeeping/ledger-carried-sek'
import { proposePaymentLines, resolveInvoicePaymentSourceType } from '@/lib/bookkeeping/propose-payment-lines'
import { getAmountToPay } from '@/lib/bookkeeping/invoice-rounding'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { createClient } from '@/lib/supabase/client'
import { formatCurrency, formatDate } from '@/lib/utils'
import { useCompany } from '@/contexts/CompanyContext'
import { Skeleton } from '@/components/ui/skeleton'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import { withLineDimensions } from '@/components/bookkeeping/payment-line-dimensions'
import type { EntityType } from '@/types'
import type { InvoiceWithRelations } from '@/components/invoices/types'
import { loadBasCatalog, type CatalogAccount } from '@/lib/bookkeeping/bas-catalog-client'
import { todayIsoStockholm } from '@/lib/dates/iso'

type DuplicateMatchReason =
  | 'ocr_exact'
  | 'name_amount_fuzzy'
  | 'amount_only'
  | 'aggregate_exact'
  | 'already_booked'

interface DuplicateCandidate {
  id: string
  date: string
  amount: number
  description: string | null
  merchant_name: string | null
  reference: string | null
  /** already_booked: the verifikat the row is already booked on. */
  journal_entry_id?: string | null
  match_reason: DuplicateMatchReason
  match_confidence: number
  /** aggregate_exact: the other open invoices the bank row also covers. */
  aggregate_invoice_numbers?: string[]
}

interface PaymentBookingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoice: InvoiceWithRelations
  onSuccess: () => void
}

const BLANK_LINE: FormLine = { account_number: '', debit_amount: '', credit_amount: '', line_description: '' }

export default function PaymentBookingDialog({
  open,
  onOpenChange,
  invoice,
  onSuccess,
}: PaymentBookingDialogProps) {
  const { toast } = useToast()
  const router = useRouter()
  const { company } = useCompany()
  const t = useTranslations('invoice_payment_dialog')

  const MATCH_REASON_LABEL: Record<DuplicateMatchReason, string> = {
    ocr_exact: t('match_reason_ocr_exact'),
    name_amount_fuzzy: t('match_reason_name_amount_fuzzy'),
    amount_only: t('match_reason_amount_only'),
    aggregate_exact: t('match_reason_aggregate_exact'),
    already_booked: t('match_reason_already_booked'),
  }

  // Session-cached reference data (lib/reference-data), seeded by the
  // dashboard layout: the chart and the settings are known on the first
  // paint, so the proposed lines and the voucher preview resolve as soon as
  // the dialog opens instead of after two sequential requests.
  const { accounts, isLoading: accountsLoading, error: accountsError } = useAccounts()
  const {
    settings: companySettings,
    isLoading: settingsLoading,
    error: settingsError,
  } = useCompanySettings()
  const [catalog, setCatalog] = useState<CatalogAccount[]>([])
  const [lines, setLines] = useState<FormLine[]>([])
  const accountNameByNumber = useMemo(() => {
    const names = new Map(catalog.map((account) => [account.account_number, account.account_name]))
    for (const account of accounts) names.set(account.account_number, account.account_name)
    return names
  }, [accounts, catalog])
  const [paymentDate, setPaymentDate] = useState(() => todayIsoStockholm())
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)
  const [duplicateCandidates, setDuplicateCandidates] = useState<DuplicateCandidate[] | null>(null)
  const [tab, setTab] = useState<'new' | 'existing'>('new')
  // Drives the "Befintlig verifikation" picker copy: cash links against a 19xx
  // debit, accrual against a 1510 credit.
  const accountingMethod: 'accrual' | 'cash' =
    companySettings?.accounting_method === 'cash' ? 'cash' : 'accrual'
  // An invoice that already carries a verifikat (booked at issue, or a
  // kontantmetod invoice whose payment entry recognised the revenue and that
  // a ROT/RUT reclaim later reopened) is settled by clearing 1510: proposing
  // the cash shape again would recognise the revenue twice, and the
  // existing-voucher picker must look for a 1510 clearing for the same
  // reason. Same rule as resolveInvoicePaymentSourceType.
  const proposalMethod: 'accrual' | 'cash' = invoice.journal_entry_id ? 'accrual' : accountingMethod
  // The bank account the invoice asked to be paid to, else the company's
  // primary: the proposed debit lands there, same as the route's default.
  const { cashAccounts, isLoading: cashAccountsLoading } = useCashAccounts()
  const paymentLedger = usePaymentBankLedger()
  const chosenPaymentAccount = useMemo(() => {
    const id = (invoice as { payment_cash_account_id?: string | null }).payment_cash_account_id
    return (id ? cashAccounts.find((a) => a.id === id)?.ledger_account : undefined) ?? paymentLedger
  }, [cashAccounts, invoice, paymentLedger])
  // source_type the booking will use: drives the voucher-series preview so the
  // number shown matches what mark-paid will actually create.
  const [sourceType, setSourceType] =
    useState<'invoice_cash_payment' | 'invoice_paid' | null>(null)
  const [nextVoucher, setNextVoucher] = useState<{ series: string; next: number | null } | null>(null)

  // Load accounts and settings when dialog opens
  useEffect(() => {
    if (!open) {
      setIsInitialized(false)
      setDuplicateCandidates(null)
      setTab('new')
      setSourceType(null)
      setNextVoucher(null)
      return
    }

    // Reference data still loading (no seed, first mount of the session):
    // the effect re-runs once it lands.
    if (accountsLoading || settingsLoading || cashAccountsLoading) return

    let cancelled = false

    async function init() {
      try {
        if (accountsError) throw new Error(t('load_chart_failed'))
        if (!company?.id) throw new Error(t('no_active_company'))
        if (settingsError) throw new Error(t('load_settings_failed'))

        const fetchedCatalog = await loadBasCatalog()
        if (cancelled) return

        setCatalog(fetchedCatalog)

        const settings = companySettings
        // /api/settings used to fall back to the company row's entity type
        // when company_settings.entity_type is null; the cached row does not.
        const entityType: EntityType =
          (settings?.entity_type as EntityType | null | undefined) ??
          company.entity_type ??
          'enskild_firma'

        setSourceType(
          resolveInvoicePaymentSourceType({
            invoiceAlreadyBooked: !!invoice.journal_entry_id,
            accountingMethod,
          }),
        )

        // A foreign invoice clears what 1510 carries.
        const carried = await carriedSekOf(createClient(), company.id, 'customer', invoice).catch(() => {
          // Safe: the proposal falls back to the invoice's rate, and the rows are the person's to edit.
          return null
        })
        if (cancelled) return

        const proposed = proposePaymentLines({
          invoice: {
            id: invoice.id,
            invoice_number: invoice.invoice_number,
            customer_name: invoice.customer?.name ?? null,
            total: invoice.total,
            total_sek: invoice.total_sek,
            subtotal: invoice.subtotal,
            subtotal_sek: invoice.subtotal_sek,
            vat_amount: invoice.vat_amount,
            vat_amount_sek: invoice.vat_amount_sek,
            currency: invoice.currency,
            exchange_rate: invoice.exchange_rate,
            vat_treatment: invoice.vat_treatment,
            // #2906: goods delivered abroad book 3108 / 3105, as on every other door.
            delivery_country: invoice.delivery_country,
            items: invoice.items,
            default_dimensions: invoice.default_dimensions,
            ore_rounding: invoice.ore_rounding,
            deduction_total: invoice.deduction_total,
            deduction_reclaimed_total: invoice.deduction_reclaimed_total,
            // #1717: lets the proposal clear the actual remaining on a
            // partially_paid invoice (öre write-off when < 1 kr remains).
            paid_amount: invoice.paid_amount,
            remaining_amount: invoice.remaining_amount,
            carried_sek: carried,
          },
          accountingMethod: proposalMethod,
          entityType,
          paymentAccount: chosenPaymentAccount,
          companyOreRounding:
            typeof settings?.ore_rounding === 'boolean' ? settings.ore_rounding : undefined,
        })

        setLines(proposed)
        setPaymentDate(todayIsoStockholm())
        setIsInitialized(true)
      } catch (err) {
        if (cancelled) return
        toast({
          title: t('load_dialog_failed_title'),
          description: err instanceof Error ? getErrorMessage(err) : t('try_again'),
          variant: 'destructive',
        })
        onOpenChange(false)
      }
    }

    init()
    return () => { cancelled = true }
  // companySettings and accountingMethod are read at init time on purpose: a
  // background revalidation of the settings row must not re-run init()
  // (and reset the user's lines) mid-dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoice.id, company?.id, accountsLoading, settingsLoading, cashAccountsLoading, chosenPaymentAccount, accountsError, settingsError])

  // Voucher-series preview: resolve the upcoming serie + nummer the same way the
  // booking engine will, so a misconfigured series is visible before confirming.
  // Re-runs when the payment date changes (vouchers are numbered per period).
  useEffect(() => {
    if (!open || !sourceType) return
    let cancelled = false
    const qs = new URLSearchParams({ source_type: sourceType, date: paymentDate })
    fetch(`/api/bookkeeping/voucher-sequences/next?${qs}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled || !json?.data) return
        setNextVoucher({ series: json.data.series, next: json.data.next })
      })
      .catch(() => {
        if (!cancelled) setNextVoucher(null)
      })
    return () => { cancelled = true }
  }, [open, sourceType, paymentDate])

  // Balance computation
  const { totalDebit, totalCredit, balanced: isBalanced } = useMemo(() => lineBalance(lines), [lines])

  const updateLine = (index: number, field: keyof FormLine, value: string) => {
    setLines((prev) => {
      const next = [...prev]
      const updated = { ...next[index], [field]: value }

      // Debit/credit exclusion: clear the other when one is entered
      if (field === 'debit_amount' && value) {
        updated.credit_amount = ''
      } else if (field === 'credit_amount' && value) {
        updated.debit_amount = ''
      }

      next[index] = updated
      return next
    })
  }

  const addLine = () => {
    // A row the user adds belongs to the same payment: it starts with the
    // invoice's bag, like the proposed rows.
    setLines((prev) => [...prev, { ...BLANK_LINE, ...withLineDimensions(invoice.default_dimensions) }])
  }

  const removeLine = (index: number) => {
    if (lines.length <= 2) return
    setLines((prev) => prev.filter((_, i) => i !== index))
  }

  const submit = async (force: boolean) => {
    if (!isBalanced) return

    setIsSubmitting(true)

    try {
      const apiLines = lines
        .filter((l) => l.account_number && (parseFloat(l.debit_amount) || parseFloat(l.credit_amount)))
        .map((l) => ({
          account_number: l.account_number,
          debit_amount: parseFloat(l.debit_amount) || 0,
          credit_amount: parseFloat(l.credit_amount) || 0,
          line_description: l.line_description || undefined,
          // Dimensions PR7: the proposal re-propagates the invoice default;
          // whatever the grid holds is what gets booked.
          dimensions:
            l.dimensions && Object.keys(l.dimensions).length > 0
              ? l.dimensions
              : undefined,
        }))

      const response = await fetch(`/api/invoices/${invoice.id}/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment_date: paymentDate,
          lines: apiLines,
          ...(force ? { force: true } : {}),
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        const code = (data as { error?: { code?: string } })?.error?.code
        if (code === 'INVOICE_PAID_LIKELY_DUPLICATE') {
          const details = (data as { error?: { details?: { candidates?: DuplicateCandidate[] } } })
            ?.error?.details
          setDuplicateCandidates(details?.candidates ?? [])
          setIsSubmitting(false)
          return
        }
        const error = new Error(t('mark_paid_failed')) as Error & { body?: unknown; status?: number }
        error.body = data
        error.status = response.status
        throw error
      }

      onOpenChange(false)
      onSuccess()
    } catch (error) {
      const anyErr = error as { body?: unknown; status?: number }
      toast({
        title: t('booking_failed_title'),
        description: getErrorMessage(anyErr.body ?? error, { context: 'invoice', statusCode: anyErr.status }),
        variant: 'destructive',
      })
    }

    setIsSubmitting(false)
  }

  const handleSubmit = () => submit(false)
  const handleForceSubmit = () => submit(true)

  const handleLinkExisting = (transactionId: string) => {
    onOpenChange(false)
    router.push(`/transactions?highlight=${encodeURIComponent(transactionId)}`)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide">
        <DialogHeader>
          <DialogTitle>
            {/* data-ph-mask: the invoice number is user data */}
            {t('title')}{invoice.invoice_number ? (
              <span data-ph-mask="">{t('title_suffix', { number: invoice.invoice_number })}</span>
            ) : ''}
            {nextVoucher && (
              <span className="ml-1 text-muted-foreground tabular-nums">
                ({nextVoucher.series}{nextVoucher.next})
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {/* What the invoice asks for (getAmountToPay): öresavrundning and
                any ROT/RUT deduction applied, as on the PDF and in the mail. */}
            {formatCurrency(getAmountToPay(invoice, companySettings).toPay, invoice.currency)}
            {invoice.currency !== 'SEK' && invoice.total_sek && (
              <>{t('description_sek_suffix', { amount: formatCurrency(invoice.total_sek) })}</>
            )}
          </DialogDescription>
        </DialogHeader>

        {duplicateCandidates && duplicateCandidates.length > 0 ? (
          <div className="space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">{t('duplicate_title')}</p>
              <p className="text-sm text-muted-foreground">
                {duplicateCandidates.length === 1
                  ? t('duplicate_one')
                  : t('duplicate_many', { count: duplicateCandidates.length })}
              </p>
            </div>
            <ul className="space-y-2">
              {duplicateCandidates.map((c) => {
                const reasonVariant: 'muted' | 'secondary' | 'outline' | 'warning' =
                  c.match_reason === 'already_booked'
                    ? 'warning'
                    : c.match_reason === 'ocr_exact' || c.match_reason === 'aggregate_exact'
                      ? 'muted'
                      : c.match_reason === 'name_amount_fuzzy'
                        ? 'secondary'
                        : 'outline'
                const isAggregate =
                  c.match_reason === 'aggregate_exact' && (c.aggregate_invoice_numbers?.length ?? 0) > 0
                // Already a verifikat: linking would book the money twice, so
                // the action is to open that voucher and correct, not to link.
                const isAlreadyBooked = c.match_reason === 'already_booked' && !!c.journal_entry_id
                return (
                  <li
                    key={c.id}
                    className="flex flex-col gap-2 rounded-lg p-3 sm:flex-row sm:items-center sm:justify-between bg-control shadow-raised"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {reasonVariant === 'muted' ? (
                          <span className="text-xs text-muted-foreground">{MATCH_REASON_LABEL[c.match_reason]}</span>
                        ) : (
                          <Badge variant={reasonVariant}>{MATCH_REASON_LABEL[c.match_reason]}</Badge>
                        )}
                        <span className="text-sm tabular-nums text-muted-foreground">
                          {formatDate(c.date)}
                        </span>
                        <span className="text-sm font-medium tabular-nums">
                          {formatCurrency(c.amount, invoice.currency)}
                        </span>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {c.merchant_name || c.description || '-'}
                      </p>
                      {/* A Bankgirot aggregate: the row also settles other
                          invoices, so the remedy is the split under
                          Transaktioner (one samlingsverifikation, row linked),
                          never marking the invoices paid one by one. */}
                      {isAggregate && (
                        <p className="text-xs text-muted-foreground">
                          {t('aggregate_covers', {
                            count: c.aggregate_invoice_numbers!.length,
                            numbers: c.aggregate_invoice_numbers!.join(', '),
                          })}
                        </p>
                      )}
                      {isAlreadyBooked && (
                        <p className="text-xs text-muted-foreground">{t('already_booked_hint')}</p>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        isAlreadyBooked
                          ? router.push(`/bookkeeping/${c.journal_entry_id}`)
                          : handleLinkExisting(c.id)
                      }
                      className="shrink-0"
                    >
                      {isAlreadyBooked
                        ? t('show_voucher')
                        : isAggregate
                          ? t('allocate_transaction')
                          : t('link_transaction')}
                    </Button>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : (
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'new' | 'existing')}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="new">{t('tab_new_payment')}</TabsTrigger>
              <TabsTrigger value="existing">{t('tab_existing_voucher')}</TabsTrigger>
            </TabsList>
            <TabsContent value="existing" className="mt-4">
              <LinkVoucherPicker
                invoiceId={invoice.id}
                invoiceCurrency={invoice.currency}
                accountingMethod={proposalMethod}
                onLinked={() => {
                  onOpenChange(false)
                  onSuccess()
                }}
                onCancel={() => setTab('new')}
              />
            </TabsContent>
            <TabsContent value="new" className="mt-4">
              {!isInitialized ? (
                <div className="space-y-3 py-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ) : (
                <div className="space-y-4">
            {/* Payment date */}
            <div className="space-y-1.5">
              <Label htmlFor="payment-date">{t('payment_date_label')}</Label>
              <Input
                id="payment-date"
                type="date"
                value={paymentDate}
                max={todayIsoStockholm()}
                onChange={(e) => setPaymentDate(e.target.value)}
                className="w-full sm:w-48"
              />
            </div>

            {/* Journal entry lines */}
            <KonteringLinesEditor
              lines={lines}
              accounts={accounts}
              accountName={(number) => accountNameByNumber.get(number)}
              onAccountChange={(index, value) => updateLine(index, 'account_number', value)}
              onAmountChange={(index, field, value) => updateLine(index, field, value)}
              onAdd={addLine}
              onRemove={removeLine}
              labels={{
                account: t('account_label'),
                debit: t('debit_label'),
                credit: t('credit_label'),
                addRow: t('add_row'),
                removeRow: t('remove_row'),
              }}
            />

            {/* Balance indicator */}
            <div className="flex items-center justify-between border-t pt-3">
              <div className="flex items-center gap-2">
                {isBalanced ? (
                  <span className="text-xs text-muted-foreground">
                    {t('balanced_badge')}
                  </span>
                ) : (
                  <Badge variant="destructive">
                    {t('unbalanced_badge', { delta: formatCurrency(Math.abs(totalDebit - totalCredit)) })}
                  </Badge>
                )}
              </div>
              <div className="text-sm text-muted-foreground tabular-nums">
                {formatCurrency(totalDebit)} / {formatCurrency(totalCredit)}
              </div>
            </div>
          </div>
              )}
            </TabsContent>
          </Tabs>
        )}

        {(duplicateCandidates && duplicateCandidates.length > 0) || tab === 'new' ? (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              {t('cancel')}
            </Button>
            {duplicateCandidates && duplicateCandidates.length > 0 ? (
              <Button
                onClick={handleForceSubmit}
                disabled={!isBalanced}
                loading={isSubmitting}
              >
                {t('book_anyway')}
              </Button>
            ) : (
              <Button
                onClick={handleSubmit}
                disabled={!isBalanced || !isInitialized}
                loading={isSubmitting}
              >
                {t('confirm_and_book')}
              </Button>
            )}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
