'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { useAccounts, useCashAccounts, useCompanySettings, useFiscalPeriods } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { foreignPayeeChoiceForDraft } from '@/lib/invoices/editor/payment-summary'
import { invoicePayeeAccountLabel } from '@/lib/cash-accounts/invoice-payee-rules'
import { chooseForeignInvoicePayee } from '@/lib/invoices/choose-foreign-payee'
import { useLocale, useTranslations } from 'next-intl'
import {
  Dialog,
  DialogConsequence,
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
import { Checkbox } from '@/components/ui/checkbox'
import { AttnLine } from '@/components/ui/attn-line'
import { LoadError } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { VoucherLinesTable } from '@/components/bookkeeping/VoucherLinesTable'
import { KonteringLinesEditor } from '@/components/bookkeeping/KonteringLinesEditor'
import { proposeSendLines } from '@/lib/bookkeeping/propose-send-lines'
import { getAmountToPay } from '@/lib/bookkeeping/invoice-rounding'
import { voucherLineViews } from '@/lib/bookkeeping/voucher-line-view'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { lineBalance, storedLineAmount } from '@/lib/bookkeeping/line-balance'
import { createClient } from '@/lib/supabase/client'
import { fetchSessionUser } from '@/lib/auth/session-client'
import { getResponseErrorMessage } from '@/lib/errors/get-error-message'
import { useCompany, useCapability } from '@/contexts/CompanyContext'
import { isInvoicerRole } from '@/lib/auth/invoicer-role'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { creditNoteNeedsJournalEntry, issueBooksDocument } from '@/lib/bookkeeping/booking-mode'
import { getDeductionShareBookedByPayout } from '@/lib/invoices/rot-rut-payout-recognition'
import { itemHasAccrual } from '@/lib/bookkeeping/accruals/account-suggestions'
import { explainVatTreatment, requiresSwedishVatAcknowledgement } from '@/lib/invoices/vat-rules'
import { VatTreatmentNotice } from '@/components/invoices/VatTreatmentNotice'
import { InvoiceAttachmentsSection } from '@/components/invoices/InvoiceAttachmentsSection'
import { offersInvoiceAttachments } from '@/lib/invoices/invoice-attachment-limits'
import { ChevronDownIcon } from '@/components/icons'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import type { Customer, EntityType } from '@/types'
import type { InvoiceWithRelations } from '@/components/invoices/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { loadBasCatalog, type CatalogAccount } from '@/lib/bookkeeping/bas-catalog-client'
import {
  EMAIL_PATTERN,
  exceedsInvoiceEmailRecipientLimit,
  MAX_INVOICE_EMAIL_RECIPIENTS,
  parseInvoiceRecipientText,
  resolveInvoiceEmailRecipients,
} from '@/lib/invoices/email-recipients'

interface SendInvoiceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoice: InvoiceWithRelations
  /** 'email' sends via email, 'manual' marks as sent without email */
  mode: 'email' | 'manual'
  /** `partial`: the document is sent but a follow-up step (PDF archive,
   *  periodisering, delivery history) failed and the toast says so. */
  onSuccess: (result?: { partial: boolean }) => void
  /**
   * Follow-up offered on the manual mark-sent toast (#2399): the user who
   * marks an invoice as sent by hand usually wants the issued PDF next, to
   * mail it themselves. Omitted when the caller already downloads it.
   */
  manualSuccessAction?: { label: string; onClick: () => void }
}

export default function SendInvoiceDialog({
  open,
  onOpenChange,
  invoice,
  mode,
  onSuccess,
  manualSuccessAction,
}: SendInvoiceDialogProps) {
  const { toast } = useToast()
  const supabase = createClient()
  const { company, role, isSandbox } = useCompany()
  const canCustomizeRecipients = role === 'owner' || role === 'admin'
  const canEmail = useCapability(CAPABILITY.email_send)
  const t = useTranslations('invoice_send_dialog')
  const tCommon = useTranslations('common')
  const tVat = useTranslations('vat_treatment_notice')
  const tPay = useTranslations('invoice_editor_pay')
  const locale = useLocale() as 'sv' | 'en'
  const isCreditNote = !!invoice.credited_invoice_id
  const isCreditRepair = isCreditNote && invoice.status === 'sent'
  // crm#1202: an offert is sent as an offert. It never books, so the dialog
  // must not title it "Skicka faktura" or show a verifikat it will not post.
  const isQuote = invoice.document_type === 'quote'
  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'

  const [isSubmitting, setIsSubmitting] = useState(false)
  // A file still uploading to the invoice's attachments holds the send.
  const [attachmentsBusy, setAttachmentsBusy] = useState(false)
  // The same rule as the editor's confirm (#79).
  const showAttachments = offersInvoiceAttachments({ channel: mode, status: invoice.status, isSandbox, canEmail, invoicer: isInvoicerRole(role) })
  // Session-cached reference data (lib/reference-data), seeded by the
  // dashboard layout: settings, the period containing the invoice date and
  // the chart are known on the first paint, so opening the dialog costs no
  // reference requests. Only the credit-note original lookup and the BAS
  // catalogue (module-cached) are still loaded in init().
  const {
    settings: companySettings,
    isLoading: settingsLoading,
    error: settingsError,
    refetch: refetchCompanySettings,
  } = useCompanySettings()
  // A foreign-currency draft with no account chosen for its currency (PH 181):
  // the send guard refuses it, so the dialog offers the accounts that can
  // carry it (a SEK account with an IBAN too) instead of a refusal toast.
  const isCompanyAdmin = role === 'owner' || role === 'admin'
  const { cashAccounts, isLoading: cashAccountsLoading } = useCashAccounts()
  const foreignPayee = useMemo(
    () =>
      foreignPayeeChoiceForDraft({
        settings: companySettings,
        invoice,
        accounts: cashAccountsLoading ? null : cashAccounts,
        canEditCompany: isCompanyAdmin,
        label: invoicePayeeAccountLabel,
      }),
    [companySettings, invoice, cashAccounts, cashAccountsLoading, isCompanyAdmin],
  )
  const [choosingPayee, setChoosingPayee] = useState(false)
  const {
    periods: fiscalPeriods,
    isLoading: periodsLoading,
    error: periodsError,
    refresh: refreshPeriods,
  } = useFiscalPeriods()
  const { accounts } = useAccounts()
  // /api/settings used to fall back to the company row's entity type when
  // company_settings.entity_type is null; the cached row does not, so the
  // fallback is explicit here (same rule as deriveSupplierInvoiceDefaults).
  const entityType: EntityType =
    (companySettings?.entity_type as EntityType | null | undefined) ??
    company?.entity_type ??
    'enskild_firma'
  const periodName = useMemo(
    () =>
      fiscalPeriods.find(
        (p) => p.period_start <= invoice.invoice_date && invoice.invoice_date <= p.period_end,
      )?.name ?? '',
    [fiscalPeriods, invoice.invoice_date],
  )
  const deferBooking = !!companySettings?.defer_invoice_booking
  const [isInitialized, setIsInitialized] = useState(false)
  // The dialog could not load what it needs: said in the dialog with
  // "Försök igen" (Stil v3, never a toast that closes it); the attempt
  // counter re-runs the load.
  const [initError, setInitError] = useState<string | null>(null)
  const [initAttempt, setInitAttempt] = useState(0)
  // A refused send says so in the footer, where the action is.
  const [submitError, setSubmitError] = useState<string | null>(null)
  // The proposed rows read as a table; "Ändra konteringen" turns them into
  // the editor. Extra copies sit behind "Fler alternativ".
  const [editingLines, setEditingLines] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [shouldBookOnIssue, setShouldBookOnIssue] = useState(true)
  // A kontantmetod ROT/RUT original whose Skatteverket share is not booked
  // yet: its credit reverses the customer's share alone.
  const [deductionBookedSek, setDeductionBookedSek] = useState<number | null>(null)
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

  // Why the VAT treatment is what it is (#2749, #2558), off the stored lines.
  // Sending Swedish VAT to an EU customer whose reverse charge is blocked
  // needs an explicit tick; a Swedish rate to a validated EU or non-EU
  // business is only warned about. A one-click VIES check inside the dialog
  // validates the customer server-side; the local copy mirrors it so the
  // sentence flips to "the lines still carry Swedish VAT" with the edit
  // link, and the page refetches after the dialog closes. Credit notes
  // mirror their original and are left alone; a non-momsregistrerad seller
  // charges nothing and has nothing to explain.
  const [validatedCustomer, setValidatedCustomer] = useState<Customer | null>(null)
  // Null when the customer was deleted (crm#263): nothing to explain then.
  const vatCustomer = validatedCustomer ?? invoice.customer
  const invoiceLineVatRates = useMemo(
    () =>
      (invoice.items ?? [])
        .filter((item) => item.line_type !== 'text')
        .map((item) => item.vat_rate ?? 0),
    [invoice.items],
  )
  const vatWarnings = useMemo(
    () =>
      isCreditNote || companySettings?.vat_registered === false || !vatCustomer
        ? []
        : explainVatTreatment(vatCustomer, invoiceLineVatRates),
    [isCreditNote, companySettings?.vat_registered, vatCustomer, invoiceLineVatRates],
  )
  const needsSwedishVatAcknowledgement = requiresSwedishVatAcknowledgement(vatWarnings, invoiceLineVatRates)
  const [swedishVatAcknowledged, setSwedishVatAcknowledged] = useState(false)

  useEffect(() => {
    if (!open) {
      setIsInitialized(false)
      setInitError(null)
      setSubmitError(null)
      setEditingLines(false)
      setMoreOpen(false)
      setAdditionalCcText('')
      setAdditionalBccText('')
      setSwedishVatAcknowledged(false)
      setValidatedCustomer(null)
      return
    }

    // Reference data still loading (no seed, first mount of the session):
    // the effect re-runs once it lands.
    if (settingsLoading || periodsLoading) return

    let cancelled = false
    setInitError(null)

    async function init() {
      try {
        if (!company?.id) throw new Error(t('no_active_company'))
        if (settingsError) throw new Error(t('company_settings_failed'))
        if (periodsError) throw new Error(t('fiscal_period_failed'))

        const [originalResult, sessionUser] = await Promise.all([
          invoice.credited_invoice_id
            ? supabase
                .from('invoices')
                .select('id, invoice_number, status, journal_entry_id, paid_at, paid_amount, total')
                .eq('id', invoice.credited_invoice_id)
                .eq('company_id', company.id)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          // Only the signed-in address is needed, as the legacy CC fallback.
          // The session is server-held, so the server answers it.
          fetchSessionUser(),
        ])

        if (originalResult.error) throw new Error(t('original_invoice_failed'))
        if (!sessionUser) throw new Error(t('load_failed_title'))

        if (cancelled) return

        const method = (companySettings?.accounting_method || 'accrual') as 'accrual' | 'cash'
        // #967: deferred companies mark-sent WITHOUT booking; ekonomi books
        // later via a separate step, so neither preview nor editor applies.
        // Only a faktura books at issue (the issue step's own predicate): a
        // proforma or an offert gets no verifikat preview (crm#1202).
        const bookOnIssue = invoice.credited_invoice_id && originalResult.data
          ? creditNoteNeedsJournalEntry(method, originalResult.data)
          : issueBooksDocument(invoice, companySettings)
        let bookedShare: number | null = null
        if (
          bookOnIssue && method === 'cash' && originalResult.data &&
          (invoice.items ?? []).some((item) => !!item.deduction_type)
        ) {
          const state = await getDeductionShareBookedByPayout(
            supabase, company.id, originalResult.data, invoice.invoice_date,
          )
          // Preview only: issueCreditNote decides again when it books.
          bookedShare = state.ok ? state.bookedSek : null
        }
        if (cancelled) return
        setDeductionBookedSek(bookedShare)

        // Line editing needs the BAS catalogue; only the accrual
        // book-at-issue path renders the editor, so skip the load elsewhere.
        let fetchedCatalog: CatalogAccount[] = []
        if (!invoice.credited_invoice_id && bookOnIssue && !hasAccrualItems) {
          fetchedCatalog = await loadBasCatalog()
        }

        if (cancelled) return

        setCatalog(fetchedCatalog)
        const legacyCc = companySettings?.email || sessionUser.email
        setFixedCc(
          companySettings?.invoice_email_cc_addresses
          ?? (legacyCc ? [legacyCc] : []),
        )
        setFixedBcc(companySettings?.invoice_email_bcc_addresses ?? [])
        setShouldBookOnIssue(bookOnIssue)
        setIsInitialized(true)
      } catch (err) {
        if (cancelled) return
        setInitError(err instanceof Error ? getUserErrorMessage(err) : t('try_again'))
      }
    }

    init()
    return () => { cancelled = true }
  // companySettings is read at init time on purpose: a background
  // revalidation of the settings row must not re-run init() mid-dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoice.id, invoice.invoice_date, company?.id, canCustomizeRecipients, settingsLoading, periodsLoading, settingsError, periodsError, initAttempt])

  const proposedLines = useMemo(() => {
    if (!isInitialized || !shouldBookOnIssue) return []

    // The whole row: the server books from all of it (item accounts and
    // dimensions, delivery_country), so the preview must read the same.
    return proposeSendLines({ invoice, entityType, deductionBookedSek })
  }, [isInitialized, shouldBookOnIssue, entityType, invoice, deductionBookedSek])

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
    to: invoice.customer?.email ?? '',
    configuredCc: fixedCc,
    configuredBcc: fixedBcc,
    customerCc: invoice.customer?.invoice_email_cc_addresses,
    customerBcc: invoice.customer?.invoice_email_bcc_addresses,
  })
  const resolvedRecipients = resolveInvoiceEmailRecipients({
    to: invoice.customer?.email ?? '',
    configuredCc: fixedCc,
    configuredBcc: fixedBcc,
    customerCc: invoice.customer?.invoice_email_cc_addresses,
    customerBcc: invoice.customer?.invoice_email_bcc_addresses,
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

  const { totalDebit, totalCredit, balanced: isBalanced } = useMemo(() => lineBalance(activeLines), [activeLines])
  // A row carrying an amount but no account would be silently dropped from
  // the POST while staying visible in the grid; block submit instead.
  const hasOrphanAmounts = activeLines.some(
    (line) => !line.account_number && (storedLineAmount(line.debit_amount) || storedLineAmount(line.credit_amount)),
  )

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
    if (mode === 'email' && attachmentsBusy) return
    if (foreignPayee) return
    if (needsSwedishVatAcknowledgement && !swedishVatAcknowledged) return
    setIsSubmitting(true)
    setSubmitError(null)

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

      onSuccess({ partial: !!data.partial })

      if (mode === 'email') {
        onOpenChange(false)
        const successMessage = data.message || t(isQuote ? 'send_quote_success_default' : 'send_success_default', {
          email: invoice.customer?.email ?? '',
        })
        toast({
          title: t(
            shouldBookOnIssue && !data.partial
              ? isCreditNote
                ? 'credit_send_book_success_title'
                : 'send_book_success_title'
              : isCreditNote
                ? 'credit_send_success_title'
                : isQuote
                  ? 'send_quote_success_title'
                  : 'send_success_title',
          ),
          description: data.partial
            ? t('partial_success', { message: successMessage })
            : isCreditNote
              ? t('credit_send_success', { email: invoice.customer?.email ?? '' })
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
                : isQuote
                  ? 'mark_quote_success_title'
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
          // A partial success asks the user to check the bookkeeping first;
          // the PDF offer would pull attention away from that.
          ...(manualSuccessAction && !data.partial
            ? {
                action: (
                  <ToastAction
                    altText={manualSuccessAction.label}
                    onClick={manualSuccessAction.onClick}
                  >
                    {manualSuccessAction.label}
                  </ToastAction>
                ),
              }
            : {}),
        })
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? getUserErrorMessage(error) : t('try_again'))
    }

    setIsSubmitting(false)
  }

  // An administrator makes the picked account the currency's default, as in
  // the editor's Betalning section (crm#1273): later invoices in the currency
  // print it too, and this draft prints it when issued. The send stays
  // blocked until the refetched settings show the choice.
  const choosePayee = async (option: { id: string; label: string; bankIban: string | null }) => {
    if (!foreignPayee) return
    const { currency } = foreignPayee
    setChoosingPayee(true)
    try {
      await chooseForeignInvoicePayee({ currency, cashAccountId: option.id, bankIban: option.bankIban, locale })
      await refetchCompanySettings()
      await invalidateReferenceData(['ref:cash-accounts', 'company_settings'])
      toast({
        title: tPay('foreign_chosen_title', { currency }),
        description: tPay('foreign_chosen_description', { account: option.label, currency }),
      })
    } catch (err) {
      toast({
        title: tPay('foreign_choose_failed'),
        description: getUserErrorMessage(err, { locale }),
        variant: 'destructive',
      })
    } finally {
      setChoosingPayee(false)
    }
  }

  const handleClose = () => {
    onOpenChange(false)
  }

  const retryInit = () => {
    if (settingsError) void refetchCompanySettings()
    if (periodsError) void refreshPeriods()
    setInitAttempt((n) => n + 1)
  }

  const showJournalPreview = shouldBookOnIssue && proposedLines.length > 0
  const customerEmail = invoice.customer?.email ?? ''
  const voucherDescription = t(isCreditNote ? 'credit_voucher_description' : 'voucher_description', {
    numberSpace: invoice.invoice_number ? ` ${invoice.invoice_number}` : '',
    customerSuffix: invoice.customer?.name ? `, ${invoice.customer.name}` : '',
  })
  // Rows that carry an amount: a blank row added in the editor is not
  // something that books (an amount without an account stays visible).
  const shownLines = activeLines.filter(
    (line) => (parseFloat(line.debit_amount) || 0) !== 0 || (parseFloat(line.credit_amount) || 0) !== 0,
  )
  const journalLabel = periodName
    ? t('journal_label_dated', { date: formatDate(invoice.invoice_date) })
    : t('journal_label')
  // Why nothing books now (an offert, kontantmetoden, a deferred booking):
  // where the document goes is the footer's job.
  const explainText = isQuote
    ? mode === 'email'
      ? t('explain_quote_email', { email: customerEmail })
      : t('explain_quote_manual')
    : !shouldBookOnIssue && isRealInvoice
      ? t(isCreditNote ? 'explain_credit_cash' : deferBooking ? 'explain_deferred' : 'explain_cash')
      : null

  // The footer's left (Stil v3): what the primary does, or why it failed.
  const footerError = submitError
    ? { title: t(isCreditNote ? 'credit_send_failed_title' : isQuote ? 'send_quote_failed_title' : 'send_failed_title'), message: submitError }
    : mode === 'email' && recipientError
      ? { title: null, message: recipientError }
      : null
  const consequence = !isInitialized
    ? null
    : mode === 'email'
      ? customerEmail
        ? t(shouldBookOnIssue ? 'consequence_email_book' : 'consequence_email', { email: customerEmail })
        : null
      : t(shouldBookOnIssue ? 'consequence_manual_book' : 'consequence_manual')

  const labelClass = 'text-[12px] font-medium leading-4 text-muted-foreground'
  const recipientRowClass = 'grid min-h-9 grid-cols-[7rem_minmax(0,1fr)_auto] items-center gap-x-4 border-b-hairline py-1.5'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form">
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
                    ? isQuote
                      ? 'title_quote_email'
                      : 'title_email'
                    : 'title_manual',
            )}
            {/* data-ph-mask: the invoice number is user data */}
            {invoice.invoice_number ? (
              <span data-ph-mask="">{t('title_suffix', { number: invoice.invoice_number })}</span>
            ) : ''}
          </DialogTitle>
          {/* The document as the context line: customer, amount, due date.
              data-ph-mask: all of it is user data. The amount is what the
              mail and the PDF ask for (getAmountToPay): öresavrundning and
              any ROT/RUT deduction applied. */}
          <DialogDescription data-ph-mask="">
            {invoice.customer?.name && <>{invoice.customer.name} · </>}
            {formatCurrency(getAmountToPay(invoice, companySettings).toPay, invoice.currency)}
            {invoice.currency !== 'SEK' && invoice.total_sek && (
              <>{t('description_sek_suffix', { amount: formatCurrency(invoice.total_sek) })}</>
            )}
            {isRealInvoice && !isCreditNote && invoice.due_date && (
              <> · {t('description_due', { date: formatDate(invoice.due_date) })}</>
            )}
          </DialogDescription>
        </DialogHeader>

        {initError ? (
          <LoadError
            title={t('load_failed_title')}
            description={initError}
            onRetry={retryInit}
            className="pt-0"
          />
        ) : !isInitialized ? (
          <LateReveal className="space-y-3 py-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/2" />
          </LateReveal>
        ) : (
          <div className="space-y-5">
            {isSandbox && mode === 'email' && (
              <AttnLine tone="info">
                E-postutskick är avstängt i sandlådan. Använd istället
                &laquo;Markera som skickad&raquo; för att testa det resterande
                flödet.
              </AttnLine>
            )}
            {!isSandbox && !canEmail && mode === 'email' && (
              <AttnLine tone="info">
                E-postutskick kräver ett abonnemang.{' '}
                <a href="/settings/billing" className="font-medium text-strong underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground/60">
                  Uppgradera
                </a>{' '}
                eller använd &laquo;Markera som skickad&raquo;.
              </AttnLine>
            )}
            {foreignPayee && !cashAccountsLoading && (
              <AttnLine>
                <p>
                  {tPay(foreignPayee.options.length > 0 ? 'foreign_missing' : 'foreign_missing_no_iban', {
                    currency: foreignPayee.currency,
                  })}
                </p>
                {foreignPayee.options.length > 0 ? (
                  isCompanyAdmin ? (
                    <div className="mt-1 flex flex-col items-start gap-1">
                      {foreignPayee.options.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          disabled={choosingPayee || isSubmitting}
                          onClick={() => void choosePayee(option)}
                          className="text-left font-medium text-strong underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground/60 disabled:opacity-50"
                          data-ph-mask=""
                        >
                          {tPay('foreign_use_account', {
                            account: option.label,
                            printed: option.printed,
                            currency: foreignPayee.currency,
                          })}
                        </button>
                      ))}
                    </div>
                  ) : (
                    // A member may pick an account for this invoice alone,
                    // which the editor saves with the draft.
                    <Link
                      href={`/invoices/${invoice.id}/edit`}
                      className="mt-1 inline-block font-medium text-strong underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground/60"
                    >
                      {t('foreign_payee_choose_in_editor')}
                    </Link>
                  )
                ) : isCompanyAdmin ? (
                  <Link
                    href="/settings/invoicing"
                    className="mt-1 inline-block font-medium text-strong underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground/60"
                  >
                    {tPay('foreign_open_settings')}
                  </Link>
                ) : (
                  <p className="text-muted-foreground">{tPay('ask_admin')}</p>
                )}
              </AttnLine>
            )}

            {/* Who gets it: the customer, then the fixed copies from the
                settings and the customer card. Convention 7: why they are
                fixed lives behind the "?". */}
            {mode === 'email' && (
              <dl className="border-t-hairline text-[13px]" data-ph-mask="">
                <div className={recipientRowClass}>
                  <dt className="text-muted-foreground">{t('recipient_to_label')}</dt>
                  {/* break-all, not truncate: the whole address shows before the send. */}
                  <dd className="min-w-0 break-all">{customerEmail}</dd>
                  <dd>
                    <HelpPopover>
                      <p>{t('recipient_help_fixed')}</p>
                      {canCustomizeRecipients && <p className="mt-2">{t('recipient_help_additional')}</p>}
                    </HelpPopover>
                  </dd>
                </div>
                <div className={recipientRowClass}>
                  <dt className="text-muted-foreground">{t('recipient_fixed_cc_label')}</dt>
                  <dd className="col-span-2 min-w-0">
                    {fixedRecipients.cc.length > 0 ? fixedRecipients.cc.join(', ') : t('recipient_none')}
                  </dd>
                </div>
                {canCustomizeRecipients && (
                  <div className={recipientRowClass}>
                    <dt className="text-muted-foreground">{t('recipient_fixed_bcc_label')}</dt>
                    <dd className="col-span-2 min-w-0">
                      {fixedRecipients.bcc.length > 0 ? fixedRecipients.bcc.join(', ') : t('recipient_none')}
                    </dd>
                  </div>
                )}
              </dl>
            )}

            {showAttachments && (
              <InvoiceAttachmentsSection
                target={{ kind: 'invoice', invoiceId: invoice.id }}
                disabled={isSubmitting}
                onBusyChange={setAttachmentsBusy}
              />
            )}

            {/* "Det här bokförs": the verifikat the send books, as a flat
                ledger table. On the accrual book-at-issue path the rows can
                be changed first ("Ändra konteringen"); what the table shows
                is what books, and the primary waits while it does not
                balance. */}
            {showJournalPreview && (
              <section className="space-y-1.5" aria-label={journalLabel}>
                <div className="flex min-h-7 items-center justify-between gap-3">
                  <span className={labelClass}>{journalLabel}</span>
                  {editable && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setEditingLines((v) => !v)}
                      aria-expanded={editingLines}
                      disabled={isSubmitting}
                      className="-mr-2.5 text-muted-foreground"
                    >
                      {editingLines ? t('edit_lines_done') : t('edit_lines')}
                    </Button>
                  )}
                </div>
                {editable && editingLines ? (
                  <KonteringLinesEditor
                    lines={editLines}
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
                ) : (
                  <div data-ph-mask="">
                    <VoucherLinesTable
                      lines={voucherLineViews(shownLines)}
                      redundantTexts={[voucherDescription]}
                      showTotals
                    />
                  </div>
                )}
                {editable && (
                  <div className="flex items-center justify-between gap-3 pt-1 text-[12px] leading-4">
                    {isBalanced ? (
                      <span className="text-muted-foreground">{t('lines_balanced')}</span>
                    ) : (
                      <span className="text-destructive">
                        {t('lines_unbalanced', { delta: formatCurrency(Math.abs(totalDebit - totalCredit)) })}
                      </span>
                    )}
                    {editingLines && (
                      <span className="tabular-nums text-muted-foreground">
                        {formatCurrency(totalDebit)} / {formatCurrency(totalCredit)}
                      </span>
                    )}
                  </div>
                )}
              </section>
            )}
            {!showJournalPreview && explainText && (
              <p className="text-[13px] text-muted-foreground">{explainText}</p>
            )}

            {vatCustomer && vatWarnings.length > 0 && (
              <div className="space-y-3">
                <VatTreatmentNotice
                  customer={vatCustomer}
                  lineVatRates={invoiceLineVatRates}
                  onValidated={(result) =>
                    setValidatedCustomer({
                      ...vatCustomer,
                      vat_number: result.vat_number,
                      vat_number_validated: true,
                      vat_number_validated_at: new Date().toISOString(),
                    })
                  }
                  editHref={`/invoices/${invoice.id}/edit`}
                />
                {needsSwedishVatAcknowledgement && (
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="send-swedish-vat-acknowledged"
                      checked={swedishVatAcknowledged}
                      onCheckedChange={(checked) => setSwedishVatAcknowledged(checked === true)}
                      className="mt-0.5"
                    />
                    <Label htmlFor="send-swedish-vat-acknowledged" className="text-[13px] font-normal leading-5">
                      {tVat('acknowledge_swedish_vat')}
                    </Label>
                  </div>
                )}
              </div>
            )}

            {/* Extra copies for this send only (owner/admin), behind "Fler
                alternativ"; an invalid address keeps them open. */}
            {mode === 'email' && canCustomizeRecipients && (
              <section className="space-y-3">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setMoreOpen((v) => !v)}
                  aria-expanded={moreOpen || !!recipientError}
                  aria-controls="send-invoice-more-options"
                  className="-ml-2.5 text-muted-foreground"
                >
                  {tCommon('more_options')}
                  <ChevronDownIcon
                    className={cn(
                      'h-3.5 w-3.5 transition-transform duration-150',
                      (moreOpen || !!recipientError) && 'rotate-180',
                    )}
                  />
                </Button>
                {(moreOpen || !!recipientError) && (
                  <div id="send-invoice-more-options" className="space-y-3">
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
                    {recipientError ? (
                      <p className="text-[12px] leading-4 text-destructive" role="alert">{recipientError}</p>
                    ) : (
                      <p className="text-[12px] leading-4 text-muted-foreground">{t('recipient_help_additional')}</p>
                    )}
                  </div>
                )}
              </section>
            )}
          </div>
        )}

        <DialogFooter>
          {footerError ? (
            <DialogConsequence role="alert" className="text-destructive">
              {footerError.title && <span className="font-medium">{footerError.title}.</span>} {footerError.message}
            </DialogConsequence>
          ) : (
            consequence && (
              <DialogConsequence>
                {/* data-ph-mask: the customer's address is user data. */}
                <span data-ph-mask="">{consequence}</span>
              </DialogConsequence>
            )
          )}
          <Button
            variant="ghost"
            onClick={handleClose}
            disabled={isSubmitting}
          >
            {t(isCreditNote ? 'later' : 'cancel')}
          </Button>
          <Button
            onClick={handleConfirm}
            loading={isSubmitting}
            disabled={
              !isInitialized ||
              (editable && (!isBalanced || hasOrphanAmounts)) ||
              (mode === 'email' && (isSandbox || !canEmail || !!recipientError || attachmentsBusy)) ||
              !!foreignPayee ||
              (needsSwedishVatAcknowledgement && !swedishVatAcknowledged)
            }
            title={
              mode === 'email' && isSandbox
                ? 'E-postutskick är avstängt i sandlådan'
                : mode === 'email' && !canEmail
                  ? 'E-postutskick kräver ett abonnemang'
                  : undefined
            }
          >
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
                      : isQuote
                        ? 'send_quote'
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
