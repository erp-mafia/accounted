'use client'

import { useState, useEffect, useMemo } from 'react'
import { useLocale, useTranslations } from 'next-intl'
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
import { HelpPopover } from '@/components/ui/help-popover'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { JournalEntryReviewContent } from '@/components/bookkeeping/JournalEntryReviewContent'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { proposeSendLines } from '@/lib/bookkeeping/propose-send-lines'
import { formatCurrency } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import { createClient } from '@/lib/supabase/client'
import { getResponseErrorMessage } from '@/lib/errors/get-error-message'
import { useCompany, useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { creditNoteNeedsJournalEntry } from '@/lib/invoices/issue-credit-note'
import { itemHasAccrual } from '@/lib/bookkeeping/accruals/account-suggestions'
import { Loader2, Mail, Plus, Send, Trash2 } from 'lucide-react'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import type { Invoice, InvoiceItem, Customer, EntityType, BASAccount } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { loadBasCatalog, type CatalogAccount } from '@/lib/bookkeeping/bas-catalog-client'
import {
  EMAIL_PATTERN,
  exceedsInvoiceEmailRecipientLimit,
  MAX_INVOICE_EMAIL_RECIPIENTS,
  parseInvoiceRecipientText,
  resolveInvoiceEmailRecipients,
} from '@/lib/invoices/email-recipients'

interface InvoiceWithRelations extends Invoice {
  customer: Customer
  items: InvoiceItem[]
}

interface SendInvoiceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoice: InvoiceWithRelations
  /** 'email' sends via email, 'manual' marks as sent without email */
  mode: 'email' | 'manual'
  onSuccess: () => void
}

export default function SendInvoiceDialog({
  open,
  onOpenChange,
  invoice,
  mode,
  onSuccess,
}: SendInvoiceDialogProps) {
  const { toast } = useToast()
  const supabase = createClient()
  const { company, role, isSandbox } = useCompany()
  const canCustomizeRecipients = role === 'owner' || role === 'admin'
  const canEmail = useCapability(CAPABILITY.email_send)
  const t = useTranslations('invoice_send_dialog')
  const locale = useLocale() as 'sv' | 'en'
  const isCreditNote = !!invoice.credited_invoice_id
  const isCreditRepair = isCreditNote && invoice.status === 'sent'

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [entityType, setEntityType] = useState<EntityType>('enskild_firma')
  const [periodName, setPeriodName] = useState('')
  const [isInitialized, setIsInitialized] = useState(false)
  const [shouldBookOnIssue, setShouldBookOnIssue] = useState(true)
  const [deferBooking, setDeferBooking] = useState(false)
  const [accounts, setAccounts] = useState<BASAccount[]>([])
  const [catalog, setCatalog] = useState<CatalogAccount[]>([])
  const [editLines, setEditLines] = useState<FormLine[]>([])
  const [hasEdited, setHasEdited] = useState(false)
  const [fixedCc, setFixedCc] = useState<string[]>([])
  const [fixedBcc, setFixedBcc] = useState<string[]>([])
  const [additionalCcText, setAdditionalCcText] = useState('')
  const [additionalBccText, setAdditionalBccText] = useState('')
  const accountNameByNumber = useMemo(() => {
    const names = new Map(catalog.map((account) => [account.account_number, account.account_name]))
    for (const account of accounts) names.set(account.account_number, account.account_name)
    return names
  }, [accounts, catalog])

  // The accrual book-at-issue path (both email send and manual mark-sent)
  // lets the user adjust the proposed lines before booking (same editor as
  // PaymentBookingDialog). Credit notes keep the read-only preview, as do
  // invoices with periodiserade rows: the server generator defers those to
  // 29xx and creates dissolution schedules, which user-edited lines bypass.
  // SEK only: the generated path stamps FX metadata (currency, exchange rate)
  // on the receivable line, which custom lines cannot carry.
  const hasAccrualItems = (invoice.items ?? []).some((item) => itemHasAccrual(item))
  const editable =
    !isCreditNote && shouldBookOnIssue && !hasAccrualItems && invoice.currency === 'SEK'

  useEffect(() => {
    if (!open) {
      setIsInitialized(false)
      setAdditionalCcText('')
      setAdditionalBccText('')
      return
    }

    let cancelled = false

    async function init() {
      try {
        if (!company?.id) throw new Error(t('no_active_company'))

        const [settingsResult, periodResult, originalResult, authResult] = await Promise.all([
          supabase
            .from('company_settings')
            .select('accounting_method, entity_type, defer_invoice_booking, email, invoice_email_cc_addresses, invoice_email_bcc_addresses')
            .eq('company_id', company.id)
            .maybeSingle(),
          supabase
            .from('fiscal_periods')
            .select('name')
            .eq('company_id', company.id)
            .lte('period_start', invoice.invoice_date)
            .gte('period_end', invoice.invoice_date)
            .maybeSingle(),
          invoice.credited_invoice_id
            ? supabase
                .from('invoices')
                .select('id, invoice_number, status, journal_entry_id, paid_at, paid_amount, total')
                .eq('id', invoice.credited_invoice_id)
                .eq('company_id', company.id)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          supabase.auth.getUser(),
        ])

        if (settingsResult.error) throw new Error(t('company_settings_failed'))
        if (periodResult.error) throw new Error(t('fiscal_period_failed'))
        if (originalResult.error) throw new Error(t('original_invoice_failed'))
        if (authResult.error || !authResult.data.user) throw new Error(t('load_failed_title'))

        if (cancelled) return

        const method = (settingsResult.data?.accounting_method || 'accrual') as 'accrual' | 'cash'
        // #967: deferred companies mark-sent WITHOUT booking; ekonomi books
        // later via a separate step, so neither preview nor editor applies.
        const bookOnIssue = invoice.credited_invoice_id && originalResult.data
          ? creditNoteNeedsJournalEntry(method, originalResult.data)
          : method === 'accrual' && !settingsResult.data?.defer_invoice_booking

        // Line editing needs the chart of accounts; only the accrual
        // book-at-issue path renders the editor, so skip the fetch elsewhere.
        let fetchedAccounts: BASAccount[] = []
        let fetchedCatalog: CatalogAccount[] = []
        if (!invoice.credited_invoice_id && bookOnIssue && !hasAccrualItems) {
          const [accountsRes, catalogResult] = await Promise.all([
            fetch('/api/bookkeeping/accounts'),
            loadBasCatalog(),
          ])
          if (!accountsRes.ok) throw new Error(t('load_chart_failed'))
          const accountsData = await accountsRes.json()
          fetchedAccounts = accountsData.data || []
          fetchedCatalog = catalogResult
        }

        if (cancelled) return

        setAccounts(fetchedAccounts)
        setCatalog(fetchedCatalog)
        setEntityType((settingsResult.data?.entity_type as EntityType) || 'enskild_firma')
        const legacyCc = settingsResult.data?.email || authResult.data.user.email
        setFixedCc(
          settingsResult.data?.invoice_email_cc_addresses
          ?? (legacyCc ? [legacyCc] : []),
        )
        setFixedBcc(settingsResult.data?.invoice_email_bcc_addresses ?? [])
        setPeriodName(periodResult.data?.name || '')
        setDeferBooking(!!settingsResult.data?.defer_invoice_booking)
        setShouldBookOnIssue(bookOnIssue)
        setIsInitialized(true)
      } catch (err) {
        if (cancelled) return
        toast({
          title: t('load_failed_title'),
          description: err instanceof Error ? getUserErrorMessage(err) : t('try_again'),
          variant: 'destructive',
        })
        onOpenChange(false)
      }
    }

    init()
    return () => { cancelled = true }
  }, [open, invoice.id, invoice.invoice_date, company?.id, canCustomizeRecipients])

  const proposedLines = useMemo(() => {
    if (!isInitialized || !shouldBookOnIssue) return []

    return proposeSendLines({
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
        credited_invoice_id: invoice.credited_invoice_id,
        items: invoice.items,
        default_dimensions: invoice.default_dimensions,
      },
      entityType,
    })
  }, [isInitialized, shouldBookOnIssue, entityType, invoice])

  const additionalCc = useMemo(
    () => parseInvoiceRecipientText(additionalCcText),
    [additionalCcText],
  )
  const additionalBcc = useMemo(
    () => parseInvoiceRecipientText(additionalBccText),
    [additionalBccText],
  )
  const invalidAdditionalRecipient = [...additionalCc, ...additionalBcc]
    .find((address) => !EMAIL_PATTERN.test(address))
  const fixedRecipients = resolveInvoiceEmailRecipients({
    to: invoice.customer.email ?? '',
    configuredCc: fixedCc,
    configuredBcc: fixedBcc,
    customerCc: invoice.customer.invoice_email_cc_addresses,
    customerBcc: invoice.customer.invoice_email_bcc_addresses,
  })
  const resolvedRecipients = resolveInvoiceEmailRecipients({
    to: invoice.customer.email ?? '',
    configuredCc: fixedCc,
    configuredBcc: fixedBcc,
    customerCc: invoice.customer.invoice_email_cc_addresses,
    customerBcc: invoice.customer.invoice_email_bcc_addresses,
    additionalCc,
    additionalBcc,
  })
  const recipientError = invalidAdditionalRecipient
    ? t('recipient_invalid', { address: invalidAdditionalRecipient })
    : exceedsInvoiceEmailRecipientLimit(resolvedRecipients)
      ? t('recipient_too_many', { count: MAX_INVOICE_EMAIL_RECIPIENTS })
      : null

  // Seed the editable grid from the proposal once per open; edits must not be
  // clobbered by re-renders, so proposedLines is deliberately not a dependency.
  useEffect(() => {
    if (!open) {
      setEditLines([])
      setHasEdited(false)
      return
    }
    if (isInitialized && editable) {
      setEditLines(proposedLines.map((line) => ({ ...line })))
      setHasEdited(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isInitialized, editable])

  const activeLines = editable ? editLines : proposedLines

  const { totalDebit, totalCredit, isBalanced, hasOrphanAmounts } = useMemo(() => {
    let totalDebit = 0
    let totalCredit = 0
    // A row carrying an amount but no account would be silently dropped from
    // the POST while staying visible in the grid; block submit instead.
    let hasOrphanAmounts = false
    for (const line of activeLines) {
      // Round per line like the server does, so a payload the badge calls
      // balanced can never be rejected by the route's rounded check.
      const debit = roundOre(parseFloat(line.debit_amount) || 0)
      const credit = roundOre(parseFloat(line.credit_amount) || 0)
      if ((debit || credit) && !line.account_number) hasOrphanAmounts = true
      totalDebit += debit
      totalCredit += credit
    }
    const isBalanced = Math.round((totalDebit - totalCredit) * 100) === 0 && totalDebit > 0
    return { totalDebit, totalCredit, isBalanced, hasOrphanAmounts }
  }, [activeLines])

  const updateLine = (index: number, field: keyof FormLine, value: string) => {
    setHasEdited(true)
    setEditLines((prev) => {
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
    setHasEdited(true)
    setEditLines((prev) => [
      ...prev,
      { account_number: '', debit_amount: '', credit_amount: '', line_description: '' },
    ])
  }

  const removeLine = (index: number) => {
    if (editLines.length <= 2) return
    setHasEdited(true)
    setEditLines((prev) => prev.filter((_, i) => i !== index))
  }

  const handleConfirm = async () => {
    if (editable && (!isBalanced || hasOrphanAmounts)) return
    if (mode === 'email' && recipientError) return
    setIsSubmitting(true)

    try {
      const url = mode === 'email'
        ? `/api/invoices/${invoice.id}/send`
        : `/api/invoices/${invoice.id}/mark-sent`

      // Untouched proposal: send no body so the server generates the entry
      // itself (per-item revenue accounts, dimensions, FX metadata). Only
      // actual edits override the generator.
      const apiLines = editable && hasEdited
        ? editLines
            .filter((l) => l.account_number && (parseFloat(l.debit_amount) || parseFloat(l.credit_amount)))
            .map((l) => ({
              account_number: l.account_number,
              debit_amount: parseFloat(l.debit_amount) || 0,
              credit_amount: parseFloat(l.credit_amount) || 0,
              line_description: l.line_description || undefined,
              dimensions:
                l.dimensions && Object.keys(l.dimensions).length > 0
                  ? l.dimensions
                  : undefined,
            }))
        : undefined

      const payload = {
        ...(apiLines ? { lines: apiLines } : {}),
        ...(mode === 'email' && canCustomizeRecipients && additionalCc.length > 0
          ? { additional_cc: additionalCc }
          : {}),
        ...(mode === 'email' && canCustomizeRecipients && additionalBcc.length > 0
          ? { additional_bcc: additionalBcc }
          : {}),
      }
      const hasPayload = Object.keys(payload).length > 0

      const response = await fetch(url, {
        method: 'POST',
        ...(hasPayload
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            }
          : {}),
      })

      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(response, 'invoice', locale))
      }
      const data = await response.json()

      onSuccess()

      if (mode === 'email') {
        onOpenChange(false)
        const successMessage = data.message || t('send_success_default', { email: invoice.customer.email ?? '' })
        toast({
          title: t(
            shouldBookOnIssue && !data.partial
              ? isCreditNote
                ? 'credit_send_book_success_title'
                : 'send_book_success_title'
              : isCreditNote
                ? 'credit_send_success_title'
                : 'send_success_title',
          ),
          description: data.partial
            ? t('partial_success', { message: successMessage })
            : isCreditNote
              ? t('credit_send_success', { email: invoice.customer.email ?? '' })
              : successMessage,
        })
      } else {
        // For manual send, just close: no email to confirm
        onOpenChange(false)
        toast({
          title: t(
            isCreditRepair
              ? 'credit_repair_success_title'
              : shouldBookOnIssue && !data.partial
                ? isCreditNote
                  ? 'credit_mark_book_success_title'
                  : 'mark_book_success_title'
              : isCreditNote
                ? 'credit_mark_success_title'
                : 'mark_success_title',
          ),
          description: data.partial
            ? t('mark_partial_success')
            : isCreditNote
              ? shouldBookOnIssue
                ? t('credit_mark_success_voucher_created')
                : t('credit_mark_success_no_voucher')
              : shouldBookOnIssue
                ? t('mark_success_voucher_created')
                : undefined,
        })
      }
    } catch (error) {
      toast({
        title: t(isCreditNote ? 'credit_send_failed_title' : 'send_failed_title'),
        description: error instanceof Error ? getUserErrorMessage(error) : t('try_again'),
        variant: 'destructive',
      })
    }

    setIsSubmitting(false)
  }

  const handleClose = () => {
    onOpenChange(false)
  }

  const showJournalPreview = shouldBookOnIssue && proposedLines.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>
            {t(
              isCreditRepair
                ? 'title_credit_repair'
                : isCreditNote
                  ? mode === 'email'
                    ? 'title_credit_email'
                    : 'title_credit_manual'
                  : mode === 'email'
                    ? 'title_email'
                    : 'title_manual',
            )}
            {/* data-ph-mask: the invoice number is user data */}
            {invoice.invoice_number ? (
              <span data-ph-mask="">{t('title_suffix', { number: invoice.invoice_number })}</span>
            ) : ''}
          </DialogTitle>
          {/* data-ph-mask: amount and customer email are user data */}
          <DialogDescription data-ph-mask="">
            {formatCurrency(invoice.total, invoice.currency)}
            {invoice.currency !== 'SEK' && invoice.total_sek && (
              <>{t('description_sek_suffix', { amount: formatCurrency(invoice.total_sek) })}</>
            )}
            {mode === 'email' && invoice.customer.email && (
              <>{t('description_to_email', { email: invoice.customer.email })}</>
            )}
          </DialogDescription>
        </DialogHeader>

        {!isInitialized ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {isSandbox && mode === 'email' && (
              <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-sm text-muted-foreground">
                E-postutskick är avstängt i sandlådan. Använd istället
                &laquo;Markera som skickad&raquo; för att testa det resterande
                flödet.
              </div>
            )}
            {!isSandbox && !canEmail && mode === 'email' && (
              <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-sm text-muted-foreground">
                E-postutskick kräver ett abonnemang.{' '}
                <a href="/settings/billing" className="underline underline-offset-2">
                  Uppgradera
                </a>{' '}
                eller använd &laquo;Markera som skickad&raquo;.
              </div>
            )}
            {mode === 'email' && (
              <div className="space-y-3 rounded-lg border border-border p-3">
                <div className="space-y-1 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <p>
                      <span className="font-medium">{t('recipient_to_label')}:</span>{' '}
                      {invoice.customer.email}
                    </p>
                    {/* Convention 7: the why of fixed CC/BCC and the extra
                        address rules live behind the "?": only the actual
                        addresses stay inline. */}
                    <HelpPopover>
                      <p>{t('recipient_help_fixed')}</p>
                      {canCustomizeRecipients && (
                        <p className="mt-2">{t('recipient_help_additional')}</p>
                      )}
                    </HelpPopover>
                  </div>
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">{t('recipient_fixed_cc_label')}:</span>{' '}
                    {fixedRecipients.cc.length > 0 ? fixedRecipients.cc.join(', ') : t('recipient_none')}
                  </p>
                  {canCustomizeRecipients && (
                    <p className="text-muted-foreground">
                      <span className="font-medium text-foreground">{t('recipient_fixed_bcc_label')}:</span>{' '}
                      {fixedRecipients.bcc.length > 0 ? fixedRecipients.bcc.join(', ') : t('recipient_none')}
                    </p>
                  )}
                </div>
                {canCustomizeRecipients && (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="invoice-additional-cc">{t('recipient_additional_cc_label')}</Label>
                        <Input
                          id="invoice-additional-cc"
                          value={additionalCcText}
                          onChange={(event) => setAdditionalCcText(event.target.value)}
                          placeholder={t('recipient_additional_placeholder')}
                          aria-invalid={!!recipientError}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="invoice-additional-bcc">{t('recipient_additional_bcc_label')}</Label>
                        <Input
                          id="invoice-additional-bcc"
                          value={additionalBccText}
                          onChange={(event) => setAdditionalBccText(event.target.value)}
                          placeholder={t('recipient_additional_placeholder')}
                          aria-invalid={!!recipientError}
                        />
                      </div>
                    </div>
                    {recipientError && (
                      <p className="text-sm text-destructive" role="alert">{recipientError}</p>
                    )}
                  </>
                )}
              </div>
            )}
            {showJournalPreview && editable ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {t('journal_edit_intro')}
                </p>

                {/* Mobile card layout */}
                <div className="sm:hidden space-y-3">
                  {editLines.map((line, index) => (
                    <div key={index} className="rounded-lg border bg-card p-3 space-y-2">
                      <div className="flex items-start gap-2">
                        <div className="flex-1">
                          <AccountCombobox
                            value={line.account_number}
                            accounts={accounts}
                            onChange={(val) => updateLine(index, 'account_number', val)}
                            selectedName={accountNameByNumber.get(line.account_number)}
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 min-h-[44px] min-w-[44px] shrink-0 -mr-1 -mt-1"
                          onClick={() => removeLine(index)}
                          disabled={editLines.length <= 2}
                          aria-label={t('remove_row')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label
                            htmlFor={`send-line-${index}-debit`}
                            className="text-xs text-muted-foreground"
                          >
                            {t('debit_label')}
                          </Label>
                          <Input
                            id={`send-line-${index}-debit`}
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
                          <Label
                            htmlFor={`send-line-${index}-credit`}
                            className="text-xs text-muted-foreground"
                          >
                            {t('credit_label')}
                          </Label>
                          <Input
                            id={`send-line-${index}-credit`}
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
                  <div className="grid grid-cols-[1fr_120px_120px_32px] gap-2 text-xs font-medium text-muted-foreground px-1">
                    <span>{t('account_label')}</span>
                    <span className="text-right">{t('debit_label')}</span>
                    <span className="text-right">{t('credit_label')}</span>
                    <span />
                  </div>

                  {editLines.map((line, index) => (
                    <div key={index} className="grid grid-cols-[1fr_120px_120px_32px] gap-2 items-start">
                      <div className="min-w-0">
                        <AccountCombobox
                          value={line.account_number}
                          accounts={accounts}
                          onChange={(val) => updateLine(index, 'account_number', val)}
                          selectedName={accountNameByNumber.get(line.account_number)}
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
                        aria-label={t('debit_label')}
                      />
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0,00"
                        value={line.credit_amount}
                        onChange={(e) => updateLine(index, 'credit_amount', e.target.value)}
                        className="tabular-nums text-right"
                        aria-label={t('credit_label')}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => removeLine(index)}
                        disabled={editLines.length <= 2}
                        aria-label={t('remove_row')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}

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
                  {isBalanced ? (
                    <Badge variant="success">{t('balanced_badge')}</Badge>
                  ) : (
                    <Badge variant="destructive">
                      {t('unbalanced_badge', { delta: formatCurrency(Math.abs(totalDebit - totalCredit)) })}
                    </Badge>
                  )}
                  <div className="text-sm text-muted-foreground tabular-nums">
                    {formatCurrency(totalDebit)} / {formatCurrency(totalCredit)}
                  </div>
                </div>
              </>
            ) : showJournalPreview ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {t('journal_preview_intro')}
                </p>
                <JournalEntryReviewContent
                  periodName={periodName}
                  entryDate={invoice.invoice_date}
                  description={t(isCreditNote ? 'credit_voucher_description' : 'voucher_description', {
                    numberSpace: invoice.invoice_number ? ` ${invoice.invoice_number}` : '',
                    customerSuffix: invoice.customer.name ? `, ${invoice.customer.name}` : '',
                  })}
                  lines={proposedLines}
                  totalDebit={totalDebit}
                  totalCredit={totalCredit}
                  showBalanceBadge={true}
                  hideDate={!periodName}
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {!shouldBookOnIssue
                  ? t(
                      isCreditNote
                        ? 'explain_credit_cash'
                        : deferBooking
                          ? 'explain_deferred'
                          : 'explain_cash',
                    )
                  : mode === 'email'
                    ? t('explain_email', { email: invoice.customer.email ?? '' })
                    : t('explain_manual')}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isSubmitting}
            className="w-full sm:w-auto min-h-11"
          >
            {t(isCreditNote ? 'later' : 'cancel')}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={isSubmitting || !isInitialized || (editable && (!isBalanced || hasOrphanAmounts)) || (mode === 'email' && (isSandbox || !canEmail || !!recipientError))}
            className="w-full sm:w-auto min-h-11"
            title={
              mode === 'email' && isSandbox
                ? 'E-postutskick är avstängt i sandlådan'
                : mode === 'email' && !canEmail
                  ? 'E-postutskick kräver ett abonnemang'
                  : undefined
            }
          >
            {isSubmitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : mode === 'email' ? (
              <Mail className="mr-2 h-4 w-4" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            {t(
              isCreditRepair
                ? 'complete_credit_bookkeeping'
                : isCreditNote
                  ? mode === 'email'
                    ? shouldBookOnIssue
                      ? 'send_credit_note_and_book'
                      : 'send_credit_note'
                    : shouldBookOnIssue
                      ? 'mark_credit_note_sent_and_book'
                      : 'mark_credit_note_sent'
                  : mode === 'email'
                    ? shouldBookOnIssue
                      ? 'send_invoice_and_book'
                      : 'send_invoice'
                    : shouldBookOnIssue
                      ? 'mark_as_sent_and_book'
                      : 'mark_as_sent',
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
