'use client'

import { useState, useEffect, useMemo } from 'react'
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
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import LinkVoucherPicker from '@/components/invoices/LinkVoucherPicker'
import { proposePaymentLines, resolveInvoicePaymentSourceType } from '@/lib/bookkeeping/propose-payment-lines'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import type { Invoice, InvoiceItem, Customer, BASAccount, EntityType } from '@/types'

type DuplicateMatchReason = 'ocr_exact' | 'name_amount_fuzzy' | 'amount_only'

interface DuplicateCandidate {
  id: string
  date: string
  amount: number
  description: string | null
  merchant_name: string | null
  reference: string | null
  match_reason: DuplicateMatchReason
  match_confidence: number
}

interface InvoiceWithRelations extends Invoice {
  customer: Customer
  items: InvoiceItem[]
  // Present once an issuance verifikat has been booked (faktureringsmetoden);
  // absent on kontantmetoden invoices that recognise revenue at payment.
  journal_entry_id?: string | null
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
  const supabase = createClient()
  const { company } = useCompany()
  const t = useTranslations('invoice_payment_dialog')

  const MATCH_REASON_LABEL: Record<DuplicateMatchReason, string> = {
    ocr_exact: t('match_reason_ocr_exact'),
    name_amount_fuzzy: t('match_reason_name_amount_fuzzy'),
    amount_only: t('match_reason_amount_only'),
  }

  const [accounts, setAccounts] = useState<BASAccount[]>([])
  const [lines, setLines] = useState<FormLine[]>([])
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().split('T')[0])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)
  const [duplicateCandidates, setDuplicateCandidates] = useState<DuplicateCandidate[] | null>(null)
  const [tab, setTab] = useState<'new' | 'existing'>('new')
  // Drives the "Befintlig verifikation" picker copy: cash links against a 19xx
  // debit, accrual against a 1510 credit.
  const [accountingMethod, setAccountingMethod] = useState<'accrual' | 'cash'>('accrual')
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

    let cancelled = false

    async function init() {
      try {
        // Fetch accounts
        const accountsRes = await fetch('/api/bookkeeping/accounts')
        if (!accountsRes.ok) throw new Error(t('load_chart_failed'))
        const accountsData = await accountsRes.json()
        const fetchedAccounts: BASAccount[] = accountsData.data || []

        if (!company?.id) throw new Error(t('no_active_company'))

        // Fetch company settings
        const { data: settings, error: settingsError } = await supabase
          .from('company_settings')
          .select('accounting_method, entity_type')
          .eq('company_id', company.id)
          .maybeSingle()

        if (settingsError) throw new Error(t('load_settings_failed'))
        if (cancelled) return

        setAccounts(fetchedAccounts)

        const accountingMethod = (settings?.accounting_method || 'accrual') as 'accrual' | 'cash'
        const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

        setAccountingMethod(accountingMethod)

        setSourceType(
          resolveInvoicePaymentSourceType({
            invoiceAlreadyBooked: !!invoice.journal_entry_id,
            accountingMethod,
          }),
        )

        const proposed = proposePaymentLines({
          invoice: {
            invoice_number: invoice.invoice_number,
            total: invoice.total,
            total_sek: invoice.total_sek,
            subtotal: invoice.subtotal,
            subtotal_sek: invoice.subtotal_sek,
            vat_amount: invoice.vat_amount,
            vat_amount_sek: invoice.vat_amount_sek,
            currency: invoice.currency,
            exchange_rate: invoice.exchange_rate,
            vat_treatment: invoice.vat_treatment,
            items: invoice.items,
            default_dimensions: invoice.default_dimensions,
          },
          accountingMethod,
          entityType,
        })

        setLines(proposed)
        setPaymentDate(new Date().toISOString().split('T')[0])
        setIsInitialized(true)
      } catch (err) {
        if (cancelled) return
        toast({
          title: t('load_dialog_failed_title'),
          description: err instanceof Error ? err.message : t('try_again'),
          variant: 'destructive',
        })
        onOpenChange(false)
      }
    }

    init()
    return () => { cancelled = true }
  }, [open, invoice.id, company?.id])

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
  const { totalDebit, totalCredit, isBalanced } = useMemo(() => {
    let totalDebit = 0
    let totalCredit = 0
    for (const line of lines) {
      totalDebit += parseFloat(line.debit_amount) || 0
      totalCredit += parseFloat(line.credit_amount) || 0
    }
    const isBalanced = Math.round((totalDebit - totalCredit) * 100) === 0 && totalDebit > 0
    return { totalDebit, totalCredit, isBalanced }
  }, [lines])

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
    setLines((prev) => [...prev, { ...BLANK_LINE }])
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
      <DialogContent className="sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>
            {t('title')}{invoice.invoice_number ? t('title_suffix', { number: invoice.invoice_number }) : ''}
            {nextVoucher && (
              <span className="ml-1 text-muted-foreground tabular-nums">
                ({nextVoucher.series}{nextVoucher.next})
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {formatCurrency(invoice.total, invoice.currency)}
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
                const reasonVariant: 'success' | 'secondary' | 'outline' =
                  c.match_reason === 'ocr_exact'
                    ? 'success'
                    : c.match_reason === 'name_amount_fuzzy'
                      ? 'secondary'
                      : 'outline'
                return (
                  <li
                    key={c.id}
                    className="flex flex-col gap-2 rounded-lg border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={reasonVariant}>{MATCH_REASON_LABEL[c.match_reason]}</Badge>
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
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleLinkExisting(c.id)}
                      className="shrink-0"
                    >
                      {t('link_transaction')}
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
                accountingMethod={accountingMethod}
                onLinked={() => {
                  onOpenChange(false)
                  onSuccess()
                }}
                onCancel={() => setTab('new')}
              />
            </TabsContent>
            <TabsContent value="new" className="mt-4">
              {!isInitialized ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
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
                onChange={(e) => setPaymentDate(e.target.value)}
                className="w-full sm:w-48"
              />
            </div>

            {/* Journal entry lines */}
            {/* Mobile card layout */}
            <div className="sm:hidden space-y-3">
              {lines.map((line, index) => (
                <div key={index} className="rounded-lg border bg-card p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <AccountCombobox
                        value={line.account_number}
                        accounts={accounts}
                        onChange={(val) => updateLine(index, 'account_number', val)}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 min-h-[44px] min-w-[44px] shrink-0 -mr-1 -mt-1"
                      onClick={() => removeLine(index)}
                      disabled={lines.length <= 2}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">{t('debit_label')}</Label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0,00"
                        value={line.debit_amount}
                        onChange={(e) => updateLine(index, 'debit_amount', e.target.value)}
                        className="tabular-nums text-right"
                        inputMode="decimal"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">{t('credit_label')}</Label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0,00"
                        value={line.credit_amount}
                        onChange={(e) => updateLine(index, 'credit_amount', e.target.value)}
                        className="tabular-nums text-right"
                        inputMode="decimal"
                      />
                    </div>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={addLine} className="w-full">
                <Plus className="mr-1 h-3.5 w-3.5" /> {t('add_row')}
              </Button>
            </div>

            {/* Desktop table layout */}
            <div className="hidden sm:block space-y-2">
              {/* Header */}
              <div className="grid grid-cols-[1fr_120px_120px_32px] gap-2 text-xs font-medium text-muted-foreground px-1">
                <span>{t('account_label')}</span>
                <span className="text-right">{t('debit_label')}</span>
                <span className="text-right">{t('credit_label')}</span>
                <span />
              </div>

              {/* Lines */}
              {lines.map((line, index) => (
                <div key={index} className="grid grid-cols-[1fr_120px_120px_32px] gap-2 items-start">
                  <div className="min-w-0">
                    <AccountCombobox
                      value={line.account_number}
                      accounts={accounts}
                      onChange={(val) => updateLine(index, 'account_number', val)}
                    />
                  </div>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0,00"
                    value={line.debit_amount}
                    onChange={(e) => updateLine(index, 'debit_amount', e.target.value)}
                    className="tabular-nums text-right"
                  />
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0,00"
                    value={line.credit_amount}
                    onChange={(e) => updateLine(index, 'credit_amount', e.target.value)}
                    className="tabular-nums text-right"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => removeLine(index)}
                    disabled={lines.length <= 2}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}

              {/* Add row */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={addLine}
                className="text-muted-foreground"
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                {t('add_row')}
              </Button>
            </div>

            {/* Balance indicator */}
            <div className="flex items-center justify-between border-t pt-3">
              <div className="flex items-center gap-2">
                {isBalanced ? (
                  <Badge variant="success">
                    {t('balanced_badge')}
                  </Badge>
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
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting} className="w-full sm:w-auto min-h-11">
              {t('cancel')}
            </Button>
            {duplicateCandidates && duplicateCandidates.length > 0 ? (
              <Button
                onClick={handleForceSubmit}
                disabled={!isBalanced || isSubmitting}
                className="w-full sm:w-auto min-h-11"
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('book_anyway')}
              </Button>
            ) : (
              <Button
                onClick={handleSubmit}
                disabled={!isBalanced || isSubmitting || !isInitialized}
                className="w-full sm:w-auto min-h-11"
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('confirm_and_book')}
              </Button>
            )}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
