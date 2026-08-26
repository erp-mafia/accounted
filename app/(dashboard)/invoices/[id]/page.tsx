'use client'

import { useState, useEffect, useRef, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { guardBrowserWrite } from '@/lib/company/tab-guard'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DetailSection, DefRow, DefEmpty } from '@/components/ui/detail-section'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { getVatTreatmentLabel } from '@/lib/invoices/vat-rules'
import { invoiceDisplayNumber, isTextLikeLine } from '@/lib/invoices/display'
import { getDisplayTotal, getAmountToPay } from '@/lib/invoices/rounding'
import { workTypeLabel } from '@/lib/invoices/rot-rut-rules'
import { isEditableInvoiceDraft } from '@/lib/invoices/is-editable-draft'
import { creditNoteNeedsJournalEntry } from '@/lib/invoices/issue-credit-note'
import { getCreditNoteSendMode } from '@/lib/invoices/credit-note-send-mode'
import { canCopyInvoice } from '@/lib/invoices/copy-invoice'
import {
  invoiceDocumentCaveat,
  invoiceRerenderUrl,
  paymentConfirmationPdfSource,
  resolveInvoicePdfSource,
  type InvoicePdfRerenderReason,
  type InvoicePdfSource,
} from '@/lib/invoices/invoice-pdf-source'
import { isPaymentConfirmationEligible } from '@/lib/invoices/payment-confirmation'
import { contentDispositionFilename } from '@/lib/api/content-disposition'
import {
  Loader2,
  ArrowLeft,
  Send,
  CheckCircle,
  FileCheck2,
  FileText,
  Download,
  Eye,
  XCircle,
  Mail,
  ReceiptText,
  AlertTriangle,
  Trash2,
  Lock,
  CalendarClock,
  Pencil,
  Copy,
  MoreHorizontal,
} from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useCompany, useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import PaymentBookingDialog from '@/components/invoices/PaymentBookingDialog'
import SendInvoiceDialog from '@/components/invoices/SendInvoiceDialog'
import {
  InvoiceDeliveryHistory,
  type InvoiceDeliveryView,
} from '@/components/invoices/InvoiceDeliveryHistory'
import CorrectionAffordance from '@/components/bookkeeping/CorrectionAffordance'
import { DetailPager } from '@/components/common/DetailPager'
import { listContextKey } from '@/lib/navigation/list-context'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Invoice, InvoiceItem, Customer, InvoiceStatus, InvoiceReminder, InvoiceDocumentType } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { useBranding } from '@/lib/branding/brand-context'

/** Minimized Peppol delivery projection from GET /api/invoices/[id]/peppol/deliveries. */
interface PeppolDeliveryView {
  id: string
  recipient_scheme: string
  recipient_identifier: string
  status: string
  status_at: string
  status_detail: string | null
  provider_submission_id: string | null
}
const PEPPOL_STATUS_KEYS = new Set([
  'staged', 'recipient_verified', 'submitting', 'retryable_failure', 'submission_accepted',
  'transport_succeeded', 'recipient_acknowledged', 'business_accepted', 'business_rejected',
  'no_route', 'failed',
])
const PEPPOL_SENDABLE_STATUSES = new Set<InvoiceStatus>(['draft', 'sent', 'overdue'])

// Why the downloaded file is not the invoice the customer received. One key
// per reason: "no archived copy exists" and "the archive could not be reached"
// are different facts and must not be told as the same story.
const RERENDER_CAVEAT_KEYS: Record<
  Exclude<InvoicePdfRerenderReason, 'not_sent_yet'>,
  string
> = {
  sent_outside_accounted: 'pdf_rerender_reason_sent_outside',
  no_archived_copy: 'pdf_rerender_reason_no_archive',
  archive_unreachable: 'pdf_rerender_reason_archive_unreachable',
  payment_confirmation: 'pdf_rerender_reason_payment_confirmation',
}

// A line is periodiserad when both period dates are set: the revenue was
// parked on the 29xx interim account and dissolves monthly via accrual_schedules.
const itemHasAccrual = (item: InvoiceItem): boolean =>
  !!(item.accrual_period_start && item.accrual_period_end)

const accrualMonth = (date: string): string => date.slice(0, 7)

// In-row text actions inside DefRow values: always underlined so they read as
// actions next to plain values, the hairline underline darkening on hover.
const ROW_ACTION_CLASS =
  'underline decoration-border underline-offset-4 transition-colors duration-150 hover:decoration-foreground disabled:opacity-50'

// Same arithmetic as the list page's overdue chip, so both say the same days.
function daysOverdue(dueDateStr: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const dueDate = new Date(dueDateStr)
  dueDate.setHours(0, 0, 0, 0)
  return Math.round((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
}

interface InvoiceWithRelations extends Invoice {
  customer: Customer
  items: InvoiceItem[]
  // Optional reference to the issuance verifikation. Populated by the
  // backend when the invoice flow auto-books an entry on send; absent on
  // older invoices and on companies where issuance is not auto-booked.
  journal_entry_id?: string | null
}

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { canWrite } = useCanWrite()
  const { company, isSandbox } = useCompany()
  const canEmail = useCapability(CAPABILITY.email_send)
  const { id } = use(params)
  const router = useRouter()
  const { toast } = useToast()
  const supabase = createClient()
  const t = useTranslations('invoice_detail')
  const { appName } = useBranding()
  // Begäran status labels are shared with the payout dialog on the list page.
  const tInvoices = useTranslations('invoices')
  const tCommon = useTranslations('common')
  const locale = useLocale()

  const [invoice, setInvoice] = useState<InvoiceWithRelations | null>(null)
  const [reminders, setReminders] = useState<InvoiceReminder[]>([])
  const [deliveries, setDeliveries] = useState<InvoiceDeliveryView[]>([])
  // An empty deliveries list means "nothing was ever sent through Accounted".
  // A failed read also produces an empty list, and the two must never be
  // conflated: the archived PDF the customer received is the räkenskapsunderlag
  // (BFL 7 kap), and a freshly re-rendered one is a different document.
  const [deliveriesUnreadable, setDeliveriesUnreadable] = useState(false)
  // Set when the archived copy could not be produced, so the user is asked
  // instead of being handed a substitute that looks like the original.
  const [pdfArchiveIssue, setPdfArchiveIssue] = useState<'history' | 'document' | null>(null)
  // Which action raised that question: the dialog's fallback must do what the
  // user originally asked for (open in the browser vs save the file), not
  // silently switch mechanism (#1190).
  const [pdfIntent, setPdfIntent] = useState<'download' | 'preview'>('download')
  // Payment history backing the new Betalningsstatus card. Fetched alongside
  // the invoice itself so the card stays in sync with paid_amount /
  // remaining_amount on the invoice row.
  const [payments, setPayments] = useState<
    Array<{
      id: string
      payment_date: string
      amount: number
      currency: string
      journal_entry_id: string | null
      voucher_series: string | null
      voucher_number: number | null
    }>
  >([])
  // ROT/RUT begäran rows this invoice is part of (fakturamodellen). Empty
  // for invoices without a deduction and for claimed invoices whose begäran
  // has not been generated yet; the Skattereduktion card reads it.
  const [payoutRequests, setPayoutRequests] = useState<
    Array<{
      id: string
      requested_amount: number
      decided_amount: number | null
      status: string
      name: string
      created_at: string
      submitted_at: string | null
      decided_at: string | null
    }>
  >([])
  // Display form of the ROT/RUT personnummer (YYYYMMDD-XXXX). The row the
  // browser holds carries only ciphertext + last four digits, and it must
  // never hold both a mask and the last four (that is the full number), so
  // the mask is fetched from the server for invoices with a claim.
  // undefined = not fetched yet, null = nothing stored or unreadable.
  const [deductionPersonnummerMasked, setDeductionPersonnummerMasked] = useState<
    string | null | undefined
  >(undefined)
  const [creditNote, setCreditNote] = useState<Invoice | null>(null)
  const [originalInvoice, setOriginalInvoice] = useState<Invoice | null>(null)
  const [convertedFromInvoice, setConvertedFromInvoice] = useState<Invoice | null>(null)
  const [showPaymentDialog, setShowPaymentDialog] = useState(false)
  const [showSendDialog, setShowSendDialog] = useState(false)
  const [sendDialogMode, setSendDialogMode] = useState<'email' | 'manual'>('email')
  const [isConverting, setIsConverting] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isDownloadingPeppol, setIsDownloadingPeppol] = useState(false)
  // Betalningsbekräftelse (#1693): the paid re-render handed to the customer.
  const [isDownloadingConfirmation, setIsDownloadingConfirmation] = useState(false)
  const [showConfirmationSendDialog, setShowConfirmationSendDialog] = useState(false)
  const [isPreparingPeppol, setIsPreparingPeppol] = useState(false)
  const [isSendingPeppol, setIsSendingPeppol] = useState(false)
  const [showPeppolSendDialog, setShowPeppolSendDialog] = useState(false)
  // Whether this deployment has a contracted Access Point switched on; the
  // menu item stays a truthful "provider required" note otherwise.
  const [peppolTransportAvailable, setPeppolTransportAvailable] = useState(false)
  // Per-company grant from the operators; without it the send item explains
  // how to ask instead of pretending to work.
  const [peppolAccess, setPeppolAccess] = useState<{
    send_enabled: boolean
    max_sends: number | null
    sent_count: number
    remaining_sends: number | null
  } | null>(null)
  const [peppolDeliveries, setPeppolDeliveries] = useState<PeppolDeliveryView[]>([])
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [showFinalizeDialog, setShowFinalizeDialog] = useState(false)
  const [isFinalizing, setIsFinalizing] = useState(false)
  const [nextNumberPreview, setNextNumberPreview] = useState<string | null>(null)
  const [oreRounding, setOreRounding] = useState<boolean>(true)
  const [vatRegistered, setVatRegistered] = useState<boolean>(true)
  const [accountingMethod, setAccountingMethod] = useState<'accrual' | 'cash'>('accrual')
  // #967: register/send without booking; ekonomi books in a separate step.
  const [deferInvoiceBooking, setDeferInvoiceBooking] = useState(false)
  const [showBookConfirm, setShowBookConfirm] = useState(false)
  const [bookVoucherPreview, setBookVoucherPreview] = useState<string | null>(null)
  const [reminderDays, setReminderDays] = useState<[number, number, number]>([15, 30, 45])
  // null = settings row not loaded; don't promise a reminder schedule then.
  const [autoRemindersEnabled, setAutoRemindersEnabled] = useState<boolean | null>(null)

  const statusLabel = (status: InvoiceStatus): string => t(`status_${status}`)
  const reminderLevelLabel = (level: 1 | 2 | 3): string => t(`reminder_level_${level}`)

  // Latest-request guard for fetchInvoice. A mutation refresh can overlap the
  // pager stepping to a sibling invoice (the component stays mounted, only
  // `id` changes), and without it the older response would commit invoice A's
  // state under invoice B's URL. Only the newest request may write state.
  const fetchSeqRef = useRef(0)

  useEffect(() => {
    fetchInvoice()
  }, [id])

  // Peppol status and transport availability for invoices that can carry an
  // e-invoice; refreshed when the invoice changes state (draft -> sent).
  useEffect(() => {
    if (!invoice || invoice.id !== id) return
    const eligible = (!invoice.document_type || invoice.document_type === 'invoice')
      && !invoice.credited_invoice_id
      && !invoice.is_self_billed
    if (!eligible) return
    void loadPeppolDeliveries()
  }, [id, invoice?.id, invoice?.status, invoice?.invoice_number]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Read the delivery history, keeping "read failed" distinct from "nothing
   * has been sent". Both used to arrive as `[]`, which is what let a network
   * blip silently downgrade the invoice download from the archived PDF the
   * customer received to a freshly re-rendered one.
   */
  async function loadDeliveries(): Promise<{
    ok: boolean
    deliveries: InvoiceDeliveryView[]
  }> {
    try {
      const response = await fetch(`/api/invoices/${encodeURIComponent(id)}/deliveries`)
      if (!response.ok) return { ok: false, deliveries: [] }
      const payload = (await response.json()) as { data?: InvoiceDeliveryView[] }
      if (!Array.isArray(payload.data)) return { ok: false, deliveries: [] }
      return { ok: true, deliveries: payload.data }
    } catch {
      return { ok: false, deliveries: [] }
    }
  }

  /** Masked ROT/RUT personnummer from the server; null when absent or unreadable. */
  async function loadDeductionPersonnummerMasked(): Promise<string | null> {
    try {
      const response = await fetch(`/api/invoices/${encodeURIComponent(id)}/rot-rut`)
      if (!response.ok) return null
      const payload = (await response.json()) as {
        data?: { deduction_personnummer_masked?: string | null }
      }
      return payload.data?.deduction_personnummer_masked ?? null
    } catch {
      return null
    }
  }

  async function retryLoadDeliveries() {
    const result = await loadDeliveries()
    setDeliveries(result.deliveries)
    setDeliveriesUnreadable(!result.ok)
    return result
  }

  async function fetchInvoice() {
    const seq = ++fetchSeqRef.current
    // The blocking spinner is reserved for the first load (or stepping to a
    // different invoice via the pager). Refetches after Bokför / status
    // change / finalize / payment / send reconcile BEHIND the mounted page:
    // a one-field state change must not collapse the whole detail view to a
    // spinner, reset scroll, and remount every card.
    if (!invoice || invoice.id !== id) {
      setIsLoading(true)
      // A different invoice: never let the previous one's mask show on it.
      setDeductionPersonnummerMasked(undefined)
    }

    // Settings depend only on the active company, so start them with the main
    // invoice batch instead of waiting for the invoice row first.
    const settingsPromise = company?.id
      ? supabase
          .from('company_settings')
          .select('ore_rounding, vat_registered, accounting_method, defer_invoice_booking, reminder_days_level_1, reminder_days_level_2, reminder_days_level_3, send_invoice_reminders')
          .eq('company_id', company.id)
          .maybeSingle()
      : Promise.resolve(null)

    const deliveriesPromise = loadDeliveries()

    // Invoice, reminders, payments, and deliveries all key on the route id: one
    // parallel batch. Only the follow-ups below need the invoice row.
    const [{ data, error }, { data: reminderData }, { data: paymentData }, deliveryData, { data: payoutData }] =
      await Promise.all([
        supabase
          .from('invoices')
          .select(`
            *,
            customer:customers(*),
            items:invoice_items(*)
          `)
          .eq('id', id)
          .single(),
        supabase
          .from('invoice_reminders')
          .select('*')
          .eq('invoice_id', id)
          .order('sent_at', { ascending: false }),
        // Payment history for the Betalningsstatus card. Joins the
        // journal_entries row to get voucher_series + voucher_number so each
        // payment row can link to its verifikat. Manual payments (no tx, no
        // JE) still surface with the amount + date.
        supabase
          .from('invoice_payments')
          .select(
            'id, payment_date, amount, currency, journal_entry_id, journal_entries(voucher_series, voucher_number)',
          )
          .eq('invoice_id', id)
          .order('payment_date', { ascending: true }),
        deliveriesPromise,
        // ROT/RUT begäran this invoice belongs to (usually 0 or 1 rows).
        // RLS scopes the join to the user's companies.
        supabase
          .from('rot_rut_payout_request_items')
          .select(
            'id, requested_amount, decided_amount, request:rot_rut_payout_requests(status, name, created_at, submitted_at, decided_at)',
          )
          .eq('invoice_id', id),
      ])

    // A newer fetch owns the page now (pager step or later refresh): commit
    // nothing from this one, not even the not-found redirect.
    if (seq !== fetchSeqRef.current) return

    if (error || !data) {
      toast({
        title: t('load_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
      router.push('/invoices')
      return
    }

    // Sort items by sort_order
    if (data.items) {
      data.items.sort((a: InvoiceItem, b: InvoiceItem) => a.sort_order - b.sort_order)
    }

    setInvoice(data as InvoiceWithRelations)
    setDeliveries(deliveryData.deliveries)
    setDeliveriesUnreadable(!deliveryData.ok)

    if (reminderData) {
      setReminders(reminderData as InvoiceReminder[])
    }

    if (paymentData) {
      type PaymentRow = {
        id: string
        payment_date: string
        amount: number
        currency: string
        journal_entry_id: string | null
        journal_entries: { voucher_series: string | null; voucher_number: number | null } | null
      }
      setPayments(
        (paymentData as unknown as PaymentRow[]).map((p) => ({
          id: p.id,
          payment_date: p.payment_date,
          amount: p.amount,
          currency: p.currency,
          journal_entry_id: p.journal_entry_id,
          voucher_series: p.journal_entries?.voucher_series ?? null,
          voucher_number: p.journal_entries?.voucher_number ?? null,
        })),
      )
    }

    type PayoutRow = {
      id: string
      requested_amount: number
      decided_amount: number | null
      request:
        | { status: string; name: string; created_at: string; submitted_at: string | null; decided_at: string | null }
        | { status: string; name: string; created_at: string; submitted_at: string | null; decided_at: string | null }[]
        | null
    }
    setPayoutRequests(
      ((payoutData ?? []) as unknown as PayoutRow[]).flatMap((row) => {
        const req = Array.isArray(row.request) ? row.request[0] : row.request
        if (!req) return []
        return [
          {
            id: row.id,
            requested_amount: Number(row.requested_amount),
            decided_amount: row.decided_amount === null ? null : Number(row.decided_amount),
            status: req.status,
            name: req.name,
            created_at: req.created_at,
            submitted_at: req.submitted_at,
            decided_at: req.decided_at,
          },
        ]
      }),
    )

    const settingsRes = await settingsPromise
    if (seq !== fetchSeqRef.current) return
    if (settingsRes) {
      const settings = settingsRes.data
      setOreRounding(settings?.ore_rounding ?? true)
      if (typeof settings?.vat_registered === 'boolean') {
        setVatRegistered(settings.vat_registered)
      }
      setAccountingMethod(settings?.accounting_method === 'cash' ? 'cash' : 'accrual')
      setDeferInvoiceBooking(!!settings?.defer_invoice_booking)
      setReminderDays([
        settings?.reminder_days_level_1 ?? 15,
        settings?.reminder_days_level_2 ?? 30,
        settings?.reminder_days_level_3 ?? 45,
      ])
      if (settings) {
        setAutoRemindersEnabled(settings.send_invoice_reminders ?? true)
      }
    }

    // Related documents need the invoice row but do not gate the main detail
    // view. Resolve them together after first paint and fill their links in.
    setIsLoading(false)
    void Promise.all([
        (data.deduction_total ?? 0) > 0
          ? loadDeductionPersonnummerMasked()
          : Promise.resolve(null),
        !data.credited_invoice_id &&
        ['sent', 'paid', 'overdue', 'credited'].includes(data.status)
          ? supabase
              .from('invoices')
              .select('id, invoice_number, status')
              .eq('credited_invoice_id', id)
              .neq('status', 'cancelled')
              .maybeSingle()
          : Promise.resolve(null),
        data.credited_invoice_id
          ? supabase
              .from('invoices')
              .select('id, invoice_number, status, journal_entry_id, paid_at, paid_amount, total')
              .eq('id', data.credited_invoice_id)
              .single()
          : Promise.resolve(null),
        data.converted_from_id
          ? supabase
              .from('invoices')
              .select('id, invoice_number')
              .eq('id', data.converted_from_id)
              .single()
          : Promise.resolve(null),
      ]).then(([personnummerMasked, creditNoteRes, originalRes, convertedRes]) => {
        // Deferred writes need the same guard: they land after first paint
        // and would otherwise attach the previous invoice's related documents
        // to the one the pager has since navigated to.
        if (seq !== fetchSeqRef.current) return
        setDeductionPersonnummerMasked(personnummerMasked)
        setCreditNote(creditNoteRes?.data ? (creditNoteRes.data as Invoice) : null)
        if (originalRes?.data) {
          setOriginalInvoice(originalRes.data as Invoice)
        }
        if (convertedRes?.data) {
          setConvertedFromInvoice(convertedRes.data as Invoice)
        }
      })
  }

  // #967: deferred booking: create the revenue verifikat afterwards.
  // Confirm-before-posting (convention 10): booking an invoice writes an
  // immutable verifikat, so describe the outcome first. The predicted voucher
  // number is indicative; the toast afterwards reports what actually landed.
  function openBookConfirm() {
    setShowBookConfirm(true)
    setBookVoucherPreview(null)
    fetch('/api/bookkeeping/voucher-sequences/next')
      .then((r) => r.json())
      .then(({ data }) => {
        if (data?.next != null) setBookVoucherPreview(`${data.series}${data.next}`)
      })
      .catch(() => {})
  }

  async function handleBook() {
    if (!invoice) return
    setIsUpdating(true)
    try {
      const response = await fetch(`/api/invoices/${invoice.id}/book`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) {
        // data.error is a structured object for this route; only strings are
        // usable as a toast message.
        const message =
          typeof data.error === 'string'
            ? data.error
            : typeof data.error?.message === 'string'
              ? data.error.message
              : t('book_failed_fallback')
        throw new Error(message)
      }
      if (Array.isArray(data.warnings) && data.warnings.length > 0) {
        // Booked, but a follow-up is needed (e.g. periodiseringar failed).
        toast({ title: t('booked_title'), description: t('booked_with_warnings_description'), variant: 'destructive' })
      } else {
        toast({ title: t('booked_title'), description: t('booked_description') })
      }
      // Awaited so the Bokför button's pending state covers the in-place
      // refresh: the spinner stops when the page shows the booked state.
      await fetchInvoice()
    } catch (error) {
      toast({
        title: t('book_failed_title'),
        description: error instanceof Error ? getUserErrorMessage(error) : t('fallback_try_again'),
        variant: 'destructive',
      })
    } finally {
      setIsUpdating(false)
    }
  }

  async function updateStatus(status: InvoiceStatus) {
    if (!invoice) return
    // Cross-tab guard (WL-09): the direct Supabase branches below bypass the
    // patched window.fetch, so consult the tab guard explicitly. On a
    // mismatch the blocking dialog raised by guardBrowserWrite is the user
    // feedback; nothing is written.
    if (!guardBrowserWrite()) return

    setIsUpdating(true)

    try {
      if (status === 'sent') {
        // Use mark-sent API for proper bookkeeping
        const response = await fetch(`/api/invoices/${invoice.id}/mark-sent`, {
          method: 'POST',
        })
        if (!response.ok) {
          const data = await response.json()
          throw new Error(data.error || t('mark_sent_failed_fallback'))
        }
      } else if (status === 'cancelled') {
        // Only drafts and proformas can be cancelled directly: sent/overdue/paid
        // invoices have committed journal entries and require a credit note instead
        if (invoice.status !== 'draft') {
          const docType = ((invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice') as InvoiceDocumentType
          if (docType !== 'proforma') {
            throw new Error(t('cancel_posted_error'))
          }
        }
        const { error } = await supabase
          .from('invoices')
          .update({ status })
          .eq('id', invoice.id)
        if (error) throw new Error(error.message)
      } else {
        const { error } = await supabase
          .from('invoices')
          .update({ status })
          .eq('id', invoice.id)
        if (error) throw new Error(error.message)
      }

      toast({
        title: t('status_update_toast_title'),
        description: t('status_update_toast_description', { status: statusLabel(status).toLowerCase() }),
      })
      // Awaited: the acting button keeps its pending state until the page
      // reflects the new status (the refetch runs behind the mounted content).
      await fetchInvoice()
    } catch (error) {
      toast({
        title: t('status_update_failed_title'),
        description: error instanceof Error ? getUserErrorMessage(error) : t('fallback_try_again'),
        variant: 'destructive',
      })
    }

    setIsUpdating(false)
  }

  function openSendDialog(mode: 'email' | 'manual') {
    setSendDialogMode(mode)
    setShowSendDialog(true)
  }

  async function convertToInvoice() {
    if (!invoice) return
    setIsConverting(true)

    try {
      const response = await fetch(`/api/invoices/${invoice.id}/convert`, {
        method: 'POST',
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || t('convert_failed_fallback'))
      }

      toast({
        title: t('converted_toast_title'),
        description: t('converted_toast_description', { number: data.data.invoice_number }),
      })

      router.push(`/invoices/${data.data.id}`)
    } catch (error) {
      toast({
        title: t('convert_failed_title'),
        description: error instanceof Error ? getUserErrorMessage(error) : t('fallback_try_again'),
        variant: 'destructive',
      })
    }

    setIsConverting(false)
  }

  /**
   * Fetch and save one specific document, then say truthfully which one it was.
   *
   * The archived delivery is the invoice the customer actually received and is
   * the räkenskapsunderlag kept for 7 years (BFL 7 kap). A re-render comes off
   * today's invoice row, customer row, company settings and logo, so it is a
   * different document whenever any of those moved. It may be served when it
   * is the only thing that exists, but never under the plain "nedladdad" toast
   * that reads as "here is what you sent".
   */
  async function runInvoiceDownload(source: InvoicePdfSource) {
    if (!invoice) return

    if (source.kind === 'unavailable') {
      setPdfIntent('download')
      setPdfArchiveIssue('history')
      return
    }

    setIsDownloading(true)

    try {
      const response = await fetch(source.url)

      if (!response.ok) {
        // A missing archive is not a generation failure and must not offer a
        // silent substitute: hand the choice back to the user.
        if (source.kind === 'archived') {
          setPdfIntent('download')
          setPdfArchiveIssue('document')
          return
        }
        throw new Error(t('pdf_generate_failed'))
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = contentDispositionFilename(response.headers.get('Content-Disposition'))
        ?? `faktura-${invoice.invoice_number ?? `utkast-${invoice.id.slice(0, 8)}`}.pdf`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)

      const caveat = invoiceDocumentCaveat(source)
      if (caveat) {
        toast({
          title: t('pdf_rerender_downloaded_title'),
          description: t(RERENDER_CAVEAT_KEYS[caveat], { appName }),
        })
      } else {
        toast({
          title: t('pdf_downloaded_title'),
          description: invoice.invoice_number
            ? t('pdf_downloaded_with_number', { number: invoice.invoice_number })
            : t('pdf_downloaded_draft'),
        })
      }
    } catch (error) {
      toast({
        title: t('pdf_download_failed_title'),
        description: error instanceof Error ? getUserErrorMessage(error) : t('fallback_try_again'),
        variant: 'destructive',
      })
    } finally {
      setIsDownloading(false)
    }
  }

  async function downloadPDF() {
    if (!invoice) return
    setPdfArchiveIssue(null)
    await runInvoiceDownload(
      resolveInvoicePdfSource({
        invoiceId: invoice.id,
        invoiceStatus: invoice.status,
        deliveriesLoaded: !deliveriesUnreadable,
        deliveries,
      }),
    )
  }

  /**
   * Download the betalningsbekräftelse (#1693). Always a fresh render with the
   * BETALD stamp, never the archived original: the file is named and toasted
   * as a payment confirmation so it is not mistaken for the invoice sent.
   */
  async function downloadPaymentConfirmation() {
    if (!invoice) return
    const source = paymentConfirmationPdfSource(invoice.id)
    setIsDownloadingConfirmation(true)

    try {
      const response = await fetch(source.url)
      if (!response.ok) {
        const body = await response.json().catch(() => null) as {
          error?: { code?: string; message?: string; message_en?: string }
        } | null
        throw body?.error ?? new Error(t('pdf_generate_failed'))
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = contentDispositionFilename(response.headers.get('Content-Disposition'))
        ?? `Betalningsbekraftelse-${invoice.invoice_number ?? invoice.id.slice(0, 8)}.pdf`
      document.body.appendChild(anchor)
      anchor.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(anchor)

      toast({
        title: t('payment_confirmation_downloaded_title'),
        description: t(RERENDER_CAVEAT_KEYS.payment_confirmation),
      })
    } catch (error) {
      toast({
        title: t('pdf_download_failed_title'),
        description: getUserErrorMessage(error, {
          context: 'invoice',
          locale: locale.startsWith('sv') ? 'sv' : 'en',
        }),
        variant: 'destructive',
      })
    } finally {
      setIsDownloadingConfirmation(false)
    }
  }

  /** Email the betalningsbekräftelse to the customer; confirmed up front. */
  async function sendPaymentConfirmation() {
    if (!invoice) return
    try {
      const response = await fetch(`/api/invoices/${invoice.id}/send-payment-confirmation`, {
        method: 'POST',
      })
      const body = await response.json().catch(() => null) as {
        error?: { code?: string; message?: string; message_en?: string }
      } | null
      if (!response.ok) {
        throw body?.error ?? new Error(t('payment_confirmation_send_failed_description'))
      }

      toast({
        title: t('payment_confirmation_sent_title'),
        description: t('payment_confirmation_sent_description', {
          email: invoice.customer?.email ?? '',
        }),
      })
    } catch (error) {
      toast({
        title: t('payment_confirmation_send_failed_title'),
        description: getUserErrorMessage(error, {
          context: 'invoice',
          locale: locale.startsWith('sv') ? 'sv' : 'en',
        }),
        variant: 'destructive',
      })
    }
  }

  async function downloadPeppolXml() {
    if (!invoice) return
    setIsDownloadingPeppol(true)

    try {
      const response = await fetch(`/api/invoices/${invoice.id}/peppol`)
      if (!response.ok) {
        const body = await response.json().catch(() => null) as {
          error?: { code?: string; message?: string; message_en?: string }
        } | null
        throw body?.error ?? new Error(t('peppol_download_failed_description'))
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = contentDispositionFilename(response.headers.get('Content-Disposition'))
        ?? `peppol-invoice-${invoice.invoice_number ?? invoice.id}.xml`
      document.body.appendChild(anchor)
      anchor.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(anchor)

      toast({
        title: t('peppol_downloaded_title'),
        description: t('peppol_downloaded_description'),
      })
    } catch (error) {
      toast({
        title: t('peppol_download_failed_title'),
        description: error instanceof Error
          ? getUserErrorMessage(error, { locale: locale.startsWith('sv') ? 'sv' : 'en' })
          : getUserErrorMessage(error, {
              context: 'invoice',
              locale: locale.startsWith('sv') ? 'sv' : 'en',
            }),
        variant: 'destructive',
      })
    } finally {
      setIsDownloadingPeppol(false)
    }
  }

  async function preparePeppolDelivery() {
    if (!invoice) return
    setIsPreparingPeppol(true)

    try {
      const response = await fetch(`/api/invoices/${invoice.id}/peppol`, { method: 'POST' })
      const body = await response.json().catch(() => null) as {
        error?: { code?: string; message?: string; message_en?: string }
      } | null
      if (!response.ok) {
        throw body?.error ?? new Error(t('peppol_prepare_failed_description'))
      }

      toast({
        title: t('peppol_prepared_title'),
        description: t('peppol_prepared_description'),
      })
    } catch (error) {
      toast({
        title: t('peppol_prepare_failed_title'),
        description: error instanceof Error
          ? getUserErrorMessage(error, { locale: locale.startsWith('sv') ? 'sv' : 'en' })
          : getUserErrorMessage(error, {
              context: 'invoice',
              locale: locale.startsWith('sv') ? 'sv' : 'en',
            }),
        variant: 'destructive',
      })
    } finally {
      setIsPreparingPeppol(false)
    }
  }

  async function loadPeppolDeliveries() {
    try {
      const response = await fetch(`/api/invoices/${encodeURIComponent(id)}/peppol/deliveries`)
      if (!response.ok) return
      const payload = (await response.json()) as {
        data?: PeppolDeliveryView[]
        transport?: { available?: boolean }
        access?: { send_enabled: boolean; max_sends: number | null; sent_count: number; remaining_sends: number | null }
      }
      const rows = Array.isArray(payload.data) ? [...payload.data] : []
      rows.sort((a, b) => (a.status_at < b.status_at ? 1 : a.status_at > b.status_at ? -1 : 0))
      setPeppolDeliveries(rows)
      setPeppolTransportAvailable(payload.transport?.available === true)
      setPeppolAccess(payload.access ?? null)
    } catch {
      // Peppol status is supplementary; the page stays usable without it.
    }
  }

  async function sendViaPeppol() {
    if (!invoice) return
    setIsSendingPeppol(true)

    try {
      const response = await fetch(`/api/invoices/${invoice.id}/peppol/send`, { method: 'POST' })
      const body = await response.json().catch(() => null) as {
        data?: { already_submitted?: boolean; issuance?: { ok: boolean } | null }
        error?: { code?: string; message?: string; message_en?: string }
      } | null
      if (!response.ok) {
        throw body?.error ?? new Error(t('peppol_send_failed_description'))
      }

      setShowPeppolSendDialog(false)
      const issuanceFailed = !!body?.data?.issuance && !body.data.issuance.ok
      toast({
        title: t('peppol_sent_title'),
        description: body?.data?.already_submitted
          ? t('peppol_already_sent_description')
          : issuanceFailed
            ? t('peppol_issue_failed_description')
            : t('peppol_sent_description'),
        ...(issuanceFailed ? { variant: 'destructive' as const } : {}),
      })
      await fetchInvoice()
      await loadPeppolDeliveries()
    } catch (error) {
      toast({
        title: t('peppol_send_failed_title'),
        description: error instanceof Error
          ? getUserErrorMessage(error, { locale: locale.startsWith('sv') ? 'sv' : 'en' })
          : getUserErrorMessage(error, {
              context: 'invoice',
              locale: locale.startsWith('sv') ? 'sv' : 'en',
            }),
        variant: 'destructive',
      })
    } finally {
      setIsSendingPeppol(false)
    }
  }

  /**
   * Show one specific document in the browser instead of saving it (#1190):
   * granskning should not require leaving the app for the Downloads folder.
   *
   * Which document may be shown is the same question as for the download, and
   * gets the same answer: the archived delivery when it exists, a re-render only
   * with the caveat spelled out, and a question rather than a guess when the
   * delivery history could not be read. Only the mechanism differs, so a tab is
   * opened synchronously (before any await) to keep the click's user activation
   * and stay clear of the popup blocker.
   */
  function runInvoicePreview(source: InvoicePdfSource) {
    if (!invoice) return

    if (source.kind === 'unavailable') {
      setPdfIntent('preview')
      setPdfArchiveIssue('history')
      return
    }

    const url =
      source.kind === 'archived' ? source.url : invoiceRerenderUrl(invoice.id, { inline: true })

    if (!window.open(url, '_blank', 'noopener,noreferrer')) {
      toast({
        title: t('pdf_preview_blocked_title'),
        description: t('pdf_preview_blocked_description', { appName }),
        variant: 'destructive',
      })
      return
    }

    const caveat = invoiceDocumentCaveat(source)
    if (caveat) {
      toast({
        title: t('pdf_rerender_preview_title'),
        description: t(RERENDER_CAVEAT_KEYS[caveat], { appName }),
      })
    }
  }

  function previewPDF() {
    if (!invoice) return
    setPdfArchiveIssue(null)
    runInvoicePreview(
      resolveInvoicePdfSource({
        invoiceId: invoice.id,
        invoiceStatus: invoice.status,
        deliveriesLoaded: !deliveriesUnreadable,
        deliveries,
      }),
    )
  }

  // "Försök igen" from the archive dialog. Re-reads the delivery history first
  // so a transient list failure resolves back to the archived copy instead of
  // getting stuck on the stale empty state.
  async function retryArchivedDownload() {
    if (!invoice) return
    setIsDownloading(true)
    const result = await retryLoadDeliveries()
    setIsDownloading(false)
    setPdfArchiveIssue(null)
    const source = resolveInvoicePdfSource({
      invoiceId: invoice.id,
      invoiceStatus: invoice.status,
      deliveriesLoaded: result.ok,
      deliveries: result.deliveries,
    })
    // The retry is a second attempt at what the user asked for, not a switch to
    // the other mechanism. A preview retry re-resolves the source first, so the
    // tab it opens is no longer inside the original click's activation window;
    // a blocked popup is reported rather than swallowed.
    if (pdfIntent === 'preview') {
      runInvoicePreview(source)
      return
    }
    await runInvoiceDownload(source)
  }

  // The user explicitly accepted a re-render after being told it is not the
  // document that was sent. The toast still says so.
  async function downloadRerenderAnyway() {
    if (!invoice) return
    setPdfArchiveIssue(null)
    const source = {
      kind: 'rerender' as const,
      url: invoiceRerenderUrl(invoice.id),
      reason: 'archive_unreachable' as const,
    }
    if (pdfIntent === 'preview') {
      runInvoicePreview(source)
      return
    }
    await runInvoiceDownload(source)
  }

  // Open the finalize dialog and peek the next F-number so the user can see
  // which number they'll get before committing. Read-only (peek_next_invoice_number);
  // the real number is allocated atomically on confirm and may differ by one if
  // another invoice is created in between.
  async function openFinalizeDialog() {
    setNextNumberPreview(null)
    setShowFinalizeDialog(true)
    try {
      const r = await fetch('/api/invoices/next-number?document_type=invoice')
      if (r.ok) {
        const json = await r.json()
        const preview = json?.data?.preview
        // Only show a value that looks like a real invoice number. Guards the
        // preview against an unexpected/oversized API response being rendered
        // verbatim, a short alphanumeric token (optional series prefix), never
        // free-form text.
        setNextNumberPreview(
          typeof preview === 'string' && /^[A-Za-z0-9-]{1,32}$/.test(preview) ? preview : null
        )
      }
    } catch {
      // Best-effort preview; the dialog still works without it.
    }
  }

  // "Granska & skapa": finalize an unnumbered draft into a real invoice:
  // allocate the F-number and emit invoice.created. After this the invoice
  // behaves like any draft (send / makulera), no longer hard-deletable.
  async function finalizeInvoice() {
    if (!invoice) return

    setIsFinalizing(true)

    try {
      const response = await fetch(`/api/invoices/${invoice.id}/finalize`, {
        method: 'POST',
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error?.message || t('fallback_try_again'))
      }

      toast({
        title: t('finalized_toast_title'),
        description: t('finalized_toast_description', { number: data.data?.invoice_number ?? '' }),
      })

      setShowFinalizeDialog(false)
      await fetchInvoice()
    } catch (error) {
      toast({
        title: t('finalize_failed_title'),
        description: error instanceof Error ? getUserErrorMessage(error) : t('fallback_try_again'),
        variant: 'destructive',
      })
    } finally {
      setIsFinalizing(false)
    }
  }

  async function deleteInvoice() {
    if (!invoice) return

    setIsDeleting(true)

    try {
      const response = await fetch(`/api/invoices/${invoice.id}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error?.message || t('cancel_failed_fallback'))
      }

      // Unnumbered drafts are hard deleted ("Ta bort"); numbered drafts are
      // makulerade and keep their number in the series.
      toast(
        invoice.invoice_number && !invoice.credited_invoice_id
          ? {
              title: t('cancelled_toast_title'),
              description: t('cancelled_with_number', { number: invoice.invoice_number }),
            }
          : {
              title: t('removed_toast_title'),
              description: t('removed_toast_description'),
            }
      )

      router.push(
        invoice.credited_invoice_id
          ? `/invoices/${invoice.credited_invoice_id}`
          : '/invoices',
      )
    } catch (error) {
      toast({
        title: t('cancel_failed_title'),
        description: error instanceof Error ? getUserErrorMessage(error) : t('fallback_try_again'),
        variant: 'destructive',
      })
    }

    setIsDeleting(false)
    setShowDeleteDialog(false)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!invoice) {
    return null
  }

  const customer = invoice.customer
  const customerHasEmail = !!customer.email
  const docType = ((invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice') as InvoiceDocumentType
  const isProforma = docType === 'proforma'
  const isDeliveryNote = docType === 'delivery_note'
  const isRealInvoice = docType === 'invoice'
  // #1693: only a fully paid faktura has a betalningsbekräftelse to offer.
  const canSendPaymentConfirmation = isPaymentConfirmationEligible(invoice)
  const isCreditNote = !!invoice.credited_invoice_id
  const booksOnIssue = isCreditNote
    ? !!originalInvoice && creditNoteNeedsJournalEntry(accountingMethod, originalInvoice)
    : accountingMethod === 'accrual' && !deferInvoiceBooking
  // #967: sent under deferred booking; ekonomi books the revenue verifikat
  // from here afterwards.
  const canBookAfterwards =
    isRealInvoice &&
    !isCreditNote &&
    !invoice.journal_entry_id &&
    accountingMethod === 'accrual' &&
    ['sent', 'overdue'].includes(invoice.status)
  const preferredSendMode = getCreditNoteSendMode({
    customerHasEmail,
    isSandbox,
    canEmail,
  })
  const creditNoteNeedsRepair =
    isCreditNote &&
    invoice.status === 'sent' &&
    !!originalInvoice &&
    (
      originalInvoice.status !== 'credited' ||
      (
        creditNoteNeedsJournalEntry(accountingMethod, originalInvoice) &&
        !invoice.journal_entry_id
      )
    )
  // An unnumbered draft is one saved via "Spara som utkast" that hasn't been
  // finalized: no F-number yet, so it can still be reviewed-and-created or
  // hard-deleted. Once finalized it gets a number and behaves like any draft.
  const isUnnumberedDraft = invoice.status === 'draft' && !invoice.invoice_number && isRealInvoice
  // A numbered draft is issued-but-unsent ("Ej skickad"), distinct from an
  // unnumbered draft ("Utkast"). Display-only: the DB status stays 'draft'.
  const isUnsentNumberedInvoice = invoice.status === 'draft' && !!invoice.invoice_number && isRealInvoice
  // Self-billing invoices we received: the document is the counterparty's, so
  // there is no own PDF to render and no send step: it arrives already booked.
  const isSelfBilled = !!invoice.is_self_billed
  // A draft (no committed verifikat, not sent, not self-billed) can be edited
  // in place (header + lines) via /invoices/{id}/edit. Sent/paid invoices are
  // immutable (BFL); they are corrected with a credit note instead.
  const isEditableDraft = isEditableInvoiceDraft(invoice)
  const isCopyable = canCopyInvoice(invoice)
  // ROT/RUT (fakturamodellen): the customer owes total minus the deduction and
  // the rest is claimed from Skatteverket. Same helper as the PDF and the
  // invoice email so all three surfaces state the same "Att betala".
  const amountToPay = getAmountToPay(invoice, { ore_rounding: oreRounding })
  const deductionItems = invoice.items.filter(
    (i) => i.deduction_type === 'rot' || i.deduction_type === 'rut',
  )
  const hasRot = deductionItems.some((i) => i.deduction_type === 'rot')
  const hasRut = deductionItems.some((i) => i.deduction_type === 'rut')
  const deductionKindLabel = hasRot && hasRut ? 'ROT/RUT' : hasRot ? 'ROT' : 'RUT'
  const showDeduction = amountToPay.deductionApplies && !isDeliveryNote
  // Fastighetsbeteckning / lägenhet live on the ROT lines (one property per
  // invoice in practice); the first ROT line carries the value.
  const rotItem = deductionItems.find((i) => i.deduction_type === 'rot')
  const rotHousing = rotItem?.housing_designation ?? null
  const rotApartment = rotItem?.apartment_number ?? null
  const rotBrf = rotItem?.brf_org_number ?? null
  const skvClaimable = invoice.status === 'paid' && payoutRequests.length === 0
  // "RUT · Städning · 4 tim" under a claimed line, so the claim is visible on
  // the item itself, not only in the PDF. The amount lives in the totals block.
  const deductionLineInfo = (item: InvoiceItem): string => {
    const parts = [item.deduction_type === 'rot' ? 'ROT' : 'RUT']
    const label = workTypeLabel(item.work_type)
    if (label) parts.push(label)
    if (item.labor_hours && item.labor_hours > 0) {
      parts.push(t('deduction_line_hours', { hours: item.labor_hours }))
    }
    return parts.join(' · ')
  }
  const hasAccruedItems = invoice.items.some(itemHasAccrual)
  const latestCompletedDelivery = deliveries.find(
    (delivery) => delivery.status === 'sent' || delivery.status === 'marked_sent',
  )

  // Document title: the number with its kind spelled out ("Faktura 4",
  // "Kreditfaktura K-5", "Proforma 3"), so the doc-type chips the header used
  // to carry become the title itself.
  const titleNumber = invoice.invoice_number ?? ''
  const title = isSelfBilled
    ? t('title_self_billed', { number: invoiceDisplayNumber(invoice as Invoice) })
    : isCreditNote
      ? invoice.invoice_number
        ? t('title_credit_note', { number: titleNumber })
        : t('title_credit_draft')
      : isProforma
        ? t('title_proforma', { number: invoiceDisplayNumber(invoice as Invoice) })
        : isDeliveryNote
          ? t('title_delivery_note', { number: invoiceDisplayNumber(invoice as Invoice) })
          : invoice.invoice_number
            ? t('title_invoice', { number: titleNumber })
            : t('title_draft')

  // One status element, same rule as the list page (chips mark exceptions):
  // sent and paid render as muted text, everything that deviates gets a chip.
  const status: { label: string; exception: boolean; variant?: 'secondary' | 'outline' | 'warning' } =
    invoice.status === 'cancelled'
      ? { label: statusLabel('cancelled'), exception: true, variant: 'secondary' }
      : invoice.status === 'credited'
        ? { label: statusLabel('credited'), exception: true, variant: 'secondary' }
        : invoice.status === 'draft'
          ? isUnsentNumberedInvoice
            ? { label: t('status_unsent'), exception: true, variant: 'outline' }
            : { label: statusLabel('draft'), exception: true, variant: 'secondary' }
          : invoice.status === 'partially_paid'
            ? { label: statusLabel('partially_paid'), exception: true, variant: 'warning' }
            : invoice.status === 'overdue' && invoice.due_date
              ? {
                  label: tInvoices('status_overdue_days', { days: Math.max(1, daysOverdue(invoice.due_date)) }),
                  exception: true,
                  variant: 'warning',
                }
              : invoice.status === 'paid'
                ? {
                    label: invoice.paid_at
                      ? tInvoices('status_paid_date', { date: formatDate(invoice.paid_at) })
                      : statusLabel('paid'),
                    exception: false,
                  }
                : { label: statusLabel('sent'), exception: false }

  const metaParts = [
    customer.name,
    t('created_at', { date: formatDate(invoice.created_at) }),
    latestCompletedDelivery?.sent_at
      ? t('sent_on', { date: formatDate(latestCompletedDelivery.sent_at) })
      : null,
  ].filter(Boolean)

  // Secondary actions collapse into one overflow menu (convention 9: one
  // obvious next step in the header, the alternatives behind a caret).
  const showManualSendAlternative =
    !isProforma &&
    !isDeliveryNote &&
    isUnsentNumberedInvoice &&
    preferredSendMode === 'email'
  const canCreateCreditNote =
    (invoice.status === 'sent' || invoice.status === 'overdue' || invoice.status === 'paid') &&
    isRealInvoice &&
    !creditNote
  // Download/prepare need the F-number (the XML carries it); sending a draft
  // assigns the number server-side, so the menu shows once a provider is on.
  const showPeppolActions = !isSelfBilled && isRealInvoice && !isCreditNote
    && (!!invoice.invoice_number || peppolTransportAvailable)
  const peppolSendGranted = !!peppolAccess?.send_enabled
  const peppolSendsLeft = peppolAccess?.remaining_sends === null || peppolAccess?.remaining_sends === undefined
    ? true
    : peppolAccess.remaining_sends > 0
  const canSendPeppol = peppolTransportAvailable && peppolSendGranted && peppolSendsLeft
    && PEPPOL_SENDABLE_STATUSES.has(invoice.status)
  const peppolRecipientLabel = invoice.customer?.org_number
    ? `0007:${invoice.customer.org_number.replace(/\D/g, '')}`
    : '0007'
  const peppolStatusLabel = (status: string) =>
    PEPPOL_STATUS_KEYS.has(status) ? t(`peppol_status_${status}`) : status
  const latestPeppolDelivery = peppolDeliveries[0] ?? null
  const showDestructive =
    invoice.status !== 'cancelled' &&
    invoice.status !== 'credited' &&
    (!invoice.credited_invoice_id || invoice.status === 'draft') &&
    (isProforma || invoice.status === 'draft')
  const hasMenu =
    !isSelfBilled ||
    (isCopyable && canWrite) ||
    showManualSendAlternative ||
    canCreateCreditNote ||
    showPeppolActions ||
    showDestructive

  // Aggregated VAT per rate for the totals block. Shown when at least one
  // rate applies; a VAT-exempt company with a zero-VAT invoice shows no row.
  const vatRows = (() => {
    const vatByRate = new Map<number, number>()
    for (const item of invoice.items) {
      const rate = item.vat_rate ?? 0
      const lineVat = Math.round(item.line_total * (rate / 100) * 100) / 100
      vatByRate.set(rate, (vatByRate.get(rate) || 0) + lineVat)
    }
    const entries = Array.from(vatByRate.entries())
      .filter(([, vat]) => vat > 0)
      .sort(([a], [b]) => b - a)
    if (entries.length > 0) {
      return entries.map(([rate, vat]) => ({ key: String(rate), label: t('vat_at_rate', { rate }), amount: vat }))
    }
    if (vatRegistered === false && invoice.vat_amount === 0) return []
    return [{ key: 'zero', label: t('vat_label'), amount: 0 }]
  })()
  const { rounding } = amountToPay

  const lineSubInfo = (item: InvoiceItem) => (
    <>
      {itemHasAccrual(item) && (
        <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
          <CalendarClock className="h-3 w-3 shrink-0" />
          {t('accrual_line_info', {
            from: accrualMonth(item.accrual_period_start!),
            to: accrualMonth(item.accrual_period_end!),
          })}
          {item.accrual_balance_account && ` · ${item.accrual_balance_account}`}
        </span>
      )}
      {item.deduction_type && (
        <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
          {deductionLineInfo(item)}
        </span>
      )}
    </>
  )

  return (
    <div className="space-y-8 stagger-enter">
      {/* Back link + prev/next record pager on their own quiet row, so the
          title below keeps a stable position while stepping between records */}
      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </button>
        <DetailPager
          contextKey={listContextKey('invoices', company?.id)}
          basePath="/invoices"
          currentId={id}
        />
      </div>

      {/* Header: serif title with one status element, a quiet meta line, and
          the next step on the right. Everything else lives in the ⋯ menu. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            {/* data-ph-mask: the title carries the invoice number */}
            <h1 data-ph-mask="" className="font-display text-2xl leading-8 tracking-tight">{title}</h1>
            {status.exception ? (
              <Badge variant={status.variant}>{status.label}</Badge>
            ) : (
              <span className="text-sm text-muted-foreground">{status.label}</span>
            )}
            {hasAccruedItems && (
              <Badge variant="outline" className="gap-1">
                <CalendarClock className="h-3 w-3" />
                {t('badge_accrued')}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{metaParts.join(' · ')}</p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {isEditableDraft && canWrite && (
            <Button variant="outline" asChild>
              <Link href={`/invoices/${invoice.id}/edit`}>
                <Pencil className="mr-2 h-4 w-4" />
                {t('edit_draft')}
              </Link>
            </Button>
          )}
          {/* Review in the browser (#1190); the download lives in the menu. */}
          {!isSelfBilled && (
            <Button variant="outline" onClick={previewPDF}>
              <Eye className="mr-2 h-4 w-4" />
              {t('preview_pdf')}
            </Button>
          )}
          {isProforma && invoice.status !== 'cancelled' && (
            <Button
              onClick={convertToInvoice}
              disabled={isConverting || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {isConverting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : !canWrite ? (
                <Lock className="mr-2 h-4 w-4" />
              ) : (
                <FileText className="mr-2 h-4 w-4" />
              )}
              {t('convert_to_invoice')}
            </Button>
          )}
          {isUnnumberedDraft && (
            <Button
              onClick={openFinalizeDialog}
              disabled={isFinalizing || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {canWrite ? <FileText className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
              {t('finalize_action')}
            </Button>
          )}
          {invoice.status === 'draft' && !isDeliveryNote && invoice.invoice_number && (
            preferredSendMode === 'email' ? (
              <Button
                onClick={() => openSendDialog('email')}
                disabled={!canWrite}
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              >
                {canWrite ? <Mail className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                {t(booksOnIssue ? 'send_via_email_and_book' : 'send_via_email')}
              </Button>
            ) : (
              <Button
                onClick={() => openSendDialog('manual')}
                disabled={!canWrite}
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              >
                {canWrite ? <Send className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                {t(booksOnIssue ? 'mark_sent_and_book' : 'mark_as_sent')}
              </Button>
            )
          )}
          {creditNoteNeedsRepair && (
            <Button
              onClick={() => openSendDialog('manual')}
              disabled={!canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {canWrite ? <AlertTriangle className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
              {t('complete_credit_bookkeeping')}
            </Button>
          )}
          {isDeliveryNote && invoice.status === 'draft' && (
            <Button
              onClick={() => updateStatus('sent')}
              disabled={isUpdating || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {isUpdating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : canWrite ? (
                <Send className="mr-2 h-4 w-4" />
              ) : (
                <Lock className="mr-2 h-4 w-4" />
              )}
              {t('mark_as_sent')}
            </Button>
          )}
          {/* partially_paid included (#1717): completes a stuck partial, e.g.
              a sub-krona öresavrundning remaining, via the same dialog. */}
          {(invoice.status === 'sent' || invoice.status === 'overdue' || invoice.status === 'partially_paid') && isRealInvoice && !isCreditNote && (
            <Button
              onClick={() => setShowPaymentDialog(true)}
              disabled={isUpdating || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {canWrite ? <CheckCircle className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
              {t('mark_as_paid')}
            </Button>
          )}

          {hasMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={tCommon('more_options')}>
                  {isDownloading || isDownloadingPeppol || isPreparingPeppol ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <MoreHorizontal className="h-4 w-4" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[240px]">
                {!isSelfBilled && (
                  <DropdownMenuItem onSelect={() => void downloadPDF()} disabled={isDownloading}>
                    <Download className="h-4 w-4" />
                    {t('download_pdf')}
                  </DropdownMenuItem>
                )}
                {isCopyable && canWrite && (
                  <DropdownMenuItem asChild>
                    <Link href={`/invoices?copy=${invoice.id}`}>
                      <Copy className="h-4 w-4" />
                      {t('copy_invoice')}
                    </Link>
                  </DropdownMenuItem>
                )}
                {/* The header offers "Skicka via e-post" as the next step; the
                    manual path stays reachable for invoices sent another way. */}
                {showManualSendAlternative && (
                  <DropdownMenuItem
                    onSelect={() => openSendDialog('manual')}
                    disabled={!canWrite}
                    className="items-start"
                  >
                    <Send className="mt-0.5 h-4 w-4" />
                    <span className="min-w-0">
                      <span className="block">{t(booksOnIssue ? 'mark_sent_and_book' : 'mark_as_sent')}</span>
                      <span className="block text-[11px] leading-snug text-muted-foreground">
                        {t('send_manual_hint_with_email')}
                      </span>
                    </span>
                  </DropdownMenuItem>
                )}
                {canCreateCreditNote && (
                  <DropdownMenuItem asChild>
                    <Link href={`/invoices/${invoice.id}/credit`}>
                      <ReceiptText className="h-4 w-4" />
                      {t('create_credit_note')}
                    </Link>
                  </DropdownMenuItem>
                )}
                {showPeppolActions && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => void downloadPeppolXml()}
                      disabled={isDownloadingPeppol || !invoice.invoice_number}
                    >
                      <FileText className="h-4 w-4" />
                      {t('download_peppol_xml')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => void preparePeppolDelivery()}
                      disabled={isPreparingPeppol || !canWrite || !invoice.invoice_number}
                    >
                      <FileCheck2 className="h-4 w-4" />
                      {t('prepare_peppol_delivery')}
                    </DropdownMenuItem>
                    {peppolTransportAvailable && peppolSendGranted && peppolSendsLeft ? (
                      <DropdownMenuItem
                        onSelect={() => setShowPeppolSendDialog(true)}
                        disabled={isSendingPeppol || !canWrite || !canSendPeppol}
                      >
                        <Send className="h-4 w-4" />
                        {t('send_via_peppol')}
                      </DropdownMenuItem>
                    ) : peppolTransportAvailable ? (
                      <DropdownMenuItem disabled className="items-start">
                        <Send className="mt-0.5 h-4 w-4" />
                        <span className="min-w-0">
                          <span className="block">{t('send_via_peppol')}</span>
                          <span className="block text-[11px] leading-snug text-muted-foreground">
                            {peppolSendGranted ? t('peppol_send_limit_reached') : t('peppol_access_required')}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem disabled className="items-start">
                        <Send className="mt-0.5 h-4 w-4" />
                        <span className="min-w-0">
                          <span className="block">{t('send_via_peppol')}</span>
                          <span className="block text-[11px] leading-snug text-muted-foreground">
                            {t('peppol_provider_required')}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    )}
                  </>
                )}
                {showDestructive && (
                  <>
                    <DropdownMenuSeparator />
                    {isProforma ? (
                      <DropdownMenuItem
                        onSelect={() => void updateStatus('cancelled')}
                        disabled={isUpdating || !canWrite}
                        className="text-destructive focus:text-destructive"
                      >
                        <XCircle className="h-4 w-4" />
                        {t('cancel_action')}
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        onSelect={() => setShowDeleteDialog(true)}
                        disabled={isDeleting || !canWrite}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                        {isUnnumberedDraft
                          ? t('remove_action')
                          : t(isCreditNote ? 'remove_credit_draft' : 'delete_draft')}
                      </DropdownMenuItem>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Kund and Detaljer side by side like an invoice head: who it is for
          on the left, the facts on the right. */}
      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-2">
        <DetailSection kicker={t('customer_card_title')}>
          <DefRow label={t('def_customer')}>
            <Link href={`/customers/${customer.id}`} className="hover:underline">
              {customer.name}
            </Link>
          </DefRow>
          {customer.customer_type !== 'individual' && customer.org_number && (
            <DefRow label={t('def_org_number')}>
              <span className="tabular-nums">{customer.org_number}</span>
            </DefRow>
          )}
          {customer.customer_type !== 'individual' && customer.vat_number && (
            <DefRow label={t('def_vat_number')}>{customer.vat_number}</DefRow>
          )}
          <DefRow label={t('def_email')}>
            {customer.email ? (
              <a href={`mailto:${customer.email}`} className="hover:underline">
                {customer.email}
              </a>
            ) : (
              <DefEmpty />
            )}
          </DefRow>
          {customer.phone && <DefRow label={t('def_phone')}>{customer.phone}</DefRow>}
          <DefRow label={t('def_address')}>
            {customer.address_line1 || customer.city ? (
              <div>
                {customer.address_line1 && <p>{customer.address_line1}</p>}
                {customer.address_line2 && <p>{customer.address_line2}</p>}
                <p>
                  {[customer.postal_code, customer.city].filter(Boolean).join(' ')}
                  {customer.country && customer.country !== 'SE' && `, ${customer.country}`}
                </p>
              </div>
            ) : (
              <DefEmpty />
            )}
          </DefRow>
          {invoice.your_reference && (
            <DefRow label={t('your_reference_label')}>
              {invoice.your_reference.split(',').map((ref) => ref.trim()).join(', ')}
            </DefRow>
          )}
        </DetailSection>

        <DetailSection kicker={t('details_card_title')}>
          {isSelfBilled && (
            <DefRow label={t('external_number_label')}>
              {invoiceDisplayNumber(invoice as Invoice)}
            </DefRow>
          )}
          {isSelfBilled && (invoice as Invoice).self_billing_agreement_ref && (
            <DefRow label={t('agreement_ref_label')}>
              {(invoice as Invoice).self_billing_agreement_ref}
            </DefRow>
          )}
          <DefRow label={t('invoice_date_label')}>
            <span className="tabular-nums">{formatDate(invoice.invoice_date)}</span>
          </DefRow>
          <DefRow label={t('due_date_label')}>
            <span className="tabular-nums">{formatDate(invoice.due_date)}</span>
          </DefRow>
          <DefRow label={t('currency_label')}>{invoice.currency}</DefRow>
          <DefRow label={t('vat_treatment_label')}>{getVatTreatmentLabel(invoice.vat_treatment)}</DefRow>
          {invoice.our_reference && (
            <DefRow label={t('our_reference_label')}>
              {invoice.our_reference.split(',').map((ref) => ref.trim()).join(', ')}
            </DefRow>
          )}

          {/* ROT/RUT (fakturamodellen): the underlag Skatteverket needs and
              where the begäran om utbetalning stands, as plain rows. The
              amounts live in the totals block; nothing is repeated here. */}
          {showDeduction && (
            <>
              <DefRow label={t('deduction_personnummer_label')}>
                {deductionPersonnummerMasked ? (
                  <span className="tabular-nums">{deductionPersonnummerMasked}</span>
                ) : !invoice.deduction_personnummer_last4 ? (
                  <span className="text-attn">{t('deduction_personnummer_missing')}</span>
                ) : deductionPersonnummerMasked === undefined ? (
                  // Stored; the mask is still on its way from the server.
                  // Never print the last four digits meanwhile.
                  <Skeleton className="h-4 w-24" />
                ) : (
                  // Stored but the server could not read it back.
                  <span className="text-muted-foreground">{t('deduction_personnummer_unreadable')}</span>
                )}
              </DefRow>
              {hasRot && (
                <DefRow label={t('deduction_property_label')}>
                  {rotHousing ? (
                    <span>
                      {rotHousing}
                      {rotApartment && (
                        <span className="text-muted-foreground tabular-nums">
                          {' · '}{t('deduction_apartment_value', { number: rotApartment })}
                        </span>
                      )}
                    </span>
                  ) : rotBrf ? (
                    <span>
                      {t('deduction_brf_value', { org: rotBrf })}
                      {rotApartment && (
                        <span className="text-muted-foreground tabular-nums">
                          {' · '}{t('deduction_apartment_value', { number: rotApartment })}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-attn">{t('deduction_housing_missing')}</span>
                  )}
                </DefRow>
              )}
              <DefRow label={t('deduction_status_label')}>
                {payoutRequests.length === 0 ? (
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-muted-foreground">{t('deduction_claim_none')}</span>
                    {skvClaimable && (
                      <Link href="/invoices?rot-rut=1" className={cn(ROW_ACTION_CLASS, 'whitespace-nowrap')}>
                        {t('deduction_claim_cta')}
                      </Link>
                    )}
                  </span>
                ) : (
                  <span className="flex flex-col gap-1 tabular-nums">
                    {payoutRequests.map((req) => (
                      <span key={req.id}>
                        {tInvoices(`rot_rut_status_${req.status}`)}
                        {' '}
                        {formatDate(req.decided_at ?? req.submitted_at ?? req.created_at)}
                        {req.decided_amount !== null &&
                          ` · ${formatCurrency(req.decided_amount, invoice.currency)}`}
                      </span>
                    ))}
                  </span>
                )}
              </DefRow>
            </>
          )}

          {canBookAfterwards && (
            <DefRow label={t('bookkeeping_label')}>
              <span className="flex flex-wrap items-center gap-3">
                <span className="text-muted-foreground">{t('not_booked_yet')}</span>
                {canWrite && (
                  <Button size="sm" variant="outline" className="-my-1" onClick={openBookConfirm} disabled={isUpdating}>
                    {isUpdating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('book_action')}
                  </Button>
                )}
              </span>
            </DefRow>
          )}
          {invoice.journal_entry_id && (
            <DefRow label={t('bookkeeping_label')}>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link href={`/bookkeeping/${invoice.journal_entry_id}`} className={ROW_ACTION_CLASS}>
                  {t('view_voucher')}
                </Link>
                {canWrite && (
                  <CorrectionAffordance
                    journalEntryId={invoice.journal_entry_id}
                    onCorrected={fetchInvoice}
                  >
                    {({ open, isLoading }) => (
                      <button
                        type="button"
                        onClick={open}
                        disabled={isLoading}
                        className="text-xs text-muted-foreground hover:text-foreground hover:underline disabled:opacity-50"
                      >
                        {isLoading ? t('correction_loading') : t('correction_prompt')}
                      </button>
                    )}
                  </CorrectionAffordance>
                )}
              </span>
            </DefRow>
          )}

          {/* Related documents as rows, not cards: the credit note that
              cancels this invoice, the invoice a credit note cancels, the
              proforma this invoice was converted from. */}
          {creditNote && (
            <DefRow label={t('def_credit_note')}>
              <Link href={`/invoices/${creditNote.id}`} className="hover:underline">
                {creditNote.invoice_number ?? statusLabel('draft')}
              </Link>
              {creditNote.status === 'draft' && creditNote.invoice_number && (
                <span className="text-muted-foreground">{' · '}{statusLabel('draft')}</span>
              )}
            </DefRow>
          )}
          {invoice.credited_invoice_id && originalInvoice && (
            <DefRow label={t('def_credits')}>
              <Link href={`/invoices/${originalInvoice.id}`} className="hover:underline">
                {t('title_invoice', { number: originalInvoice.invoice_number ?? '' })}
              </Link>
            </DefRow>
          )}
          {convertedFromInvoice && (
            <DefRow label={t('def_converted_from')}>
              <Link href={`/invoices/${convertedFromInvoice.id}`} className="hover:underline">
                {t('title_proforma', { number: convertedFromInvoice.invoice_number ?? '' })}
              </Link>
            </DefRow>
          )}
        </DetailSection>
      </div>

      {/* Invoice lines: the list-page table idiom straight on the panel, with
          the totals as a right-aligned block and the amount due in the serif. */}
      <DetailSection kicker={t('items_card_title')}>
        <table className="hidden w-full border-collapse text-[13px] sm:table">
          <thead>
            <tr>
              <th className={cn(TH_CLASS, 'pl-0')}>{t('th_description')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('th_quantity')}</th>
              <th className={TH_CLASS}>{t('th_unit')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('th_unit_price')}</th>
              <th className={cn(TH_CLASS, 'pr-0 text-right')}>{t('th_amount')}</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item) =>
              isTextLikeLine(item) ? (
                <tr key={item.id}>
                  <td colSpan={5} className={cn(TD_CLASS, 'pl-0 pr-0 text-muted-foreground')}>
                    {item.description || ' '}
                  </td>
                </tr>
              ) : (
                <tr key={item.id}>
                  <td className={cn(TD_CLASS, 'pl-0')}>
                    {item.description}
                    {lineSubInfo(item)}
                  </td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{item.quantity}</td>
                  <td className={cn(TD_CLASS, 'text-muted-foreground')}>{item.unit}</td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums')}>
                    {formatCurrency(item.unit_price, invoice.currency)}
                  </td>
                  <td className={cn(TD_CLASS, 'pr-0 text-right tabular-nums')}>
                    {formatCurrency(item.line_total, invoice.currency)}
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>

        {/* Mobile: one flat row per line, no numeric columns to cram. */}
        <div className="divide-y divide-border text-sm sm:hidden">
          {invoice.items.map((item) =>
            isTextLikeLine(item) ? (
              <p key={item.id} className="py-3 text-muted-foreground">{item.description || ' '}</p>
            ) : (
              <div key={item.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p>{item.description}</p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {item.quantity} {item.unit} × {formatCurrency(item.unit_price, invoice.currency)}
                  </p>
                  {lineSubInfo(item)}
                </div>
                <span className="shrink-0 tabular-nums">
                  {formatCurrency(item.line_total, invoice.currency)}
                </span>
              </div>
            )
          )}
        </div>

        <div className="ml-auto mt-4 w-full max-w-xs space-y-1 text-sm tabular-nums">
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">{t('subtotal')}</span>
            <span>{formatCurrency(invoice.subtotal, invoice.currency)}</span>
          </div>
          {vatRows.map((row) => (
            <div key={row.key} className="flex justify-between gap-4">
              <span className="text-muted-foreground">{row.label}</span>
              <span>{formatCurrency(row.amount, invoice.currency)}</span>
            </div>
          ))}
          {rounding.applies && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">{t('ore_rounding')}</span>
              <span>{formatCurrency(rounding.roundingDelta, 'SEK')}</span>
            </div>
          )}
          {/* ROT/RUT (fakturamodellen): the invoice total stands, the
              deduction is shown as a reduction and the headline becomes what
              the customer actually pays, exactly as on the PDF and in the
              invoice email. */}
          {showDeduction ? (
            <>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t('total')}</span>
                <span>{formatCurrency(rounding.displayed, invoice.currency)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t('deduction_row', { kind: deductionKindLabel })}</span>
                <span>{formatCurrency(-Math.abs(invoice.deduction_total ?? 0), invoice.currency)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
                <span>{t('amount_to_pay')}</span>
                <span className="font-display text-xl">{formatCurrency(amountToPay.toPay, invoice.currency)}</span>
              </div>
            </>
          ) : (
            <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
              <span>{t('total')}</span>
              <span className="font-display text-xl">{formatCurrency(rounding.displayed, invoice.currency)}</span>
            </div>
          )}
          {invoice.currency !== 'SEK' && invoice.total_sek && (
            <div className="flex justify-between gap-4 text-muted-foreground">
              <span>{t('in_sek', { rate: invoice.exchange_rate ?? 1 })}</span>
              <span>{formatCurrency(invoice.total_sek)}</span>
            </div>
          )}
        </div>
      </DetailSection>

      {(invoice.notes || invoice.reverse_charge_text) && (
        <DetailSection kicker={t('notes_card_title')}>
          {invoice.reverse_charge_text && (
            <DefRow label={t('reverse_charge_label')}>
              <span className="text-muted-foreground">{invoice.reverse_charge_text}</span>
            </DefRow>
          )}
          {invoice.notes && (
            <p className="py-2 text-sm text-muted-foreground whitespace-pre-wrap">{invoice.notes}</p>
          )}
        </DetailSection>
      )}

      {/* Payment: shown for paid and partially paid alike, so a partly paid
          invoice always exposes paid / remaining and the payment events. */}
      {(invoice.status === 'paid' || invoice.status === 'partially_paid') && (
        <DetailSection
          kicker={t('payment_section')}
          aside={
            invoice.status === 'paid' && invoice.paid_at ? (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {t('paid_received_at', { date: formatDate(invoice.paid_at) })}
              </span>
            ) : undefined
          }
        >
          <DefRow label={t('payment_status_paid_label')}>
            <span className="tabular-nums">{formatCurrency(invoice.paid_amount ?? 0, invoice.currency)}</span>
          </DefRow>
          <DefRow label={t('payment_status_remaining_label')}>
            <span className={cn('tabular-nums', invoice.status === 'partially_paid' && 'text-attn')}>
              {formatCurrency(
                invoice.remaining_amount ??
                  Math.max(0, invoice.total - (invoice.paid_amount ?? 0)),
                invoice.currency,
              )}
            </span>
          </DefRow>
          <DefRow label={t('payment_status_payments_heading')} className="items-baseline">
            {payments.length === 0 ? (
              <span className="text-muted-foreground">{t('payment_status_empty')}</span>
            ) : (
              <ul className="divide-y divide-border">
                {payments.map((p) => {
                  const voucherLabel =
                    p.voucher_series && p.voucher_number != null
                      ? `${p.voucher_series}-${p.voucher_number}`
                      : null
                  return (
                    <li key={p.id} className="flex items-center gap-4 py-1.5 first:pt-0 last:pb-0">
                      <span className="tabular-nums text-muted-foreground">{formatDate(p.payment_date)}</span>
                      <span className="tabular-nums">{formatCurrency(p.amount, p.currency)}</span>
                      {p.journal_entry_id && voucherLabel ? (
                        <Link
                          href={`/bookkeeping/${p.journal_entry_id}`}
                          className="ml-auto text-xs text-muted-foreground hover:text-foreground hover:underline tabular-nums"
                        >
                          {t('payment_status_view_voucher', { label: voucherLabel })}
                        </Link>
                      ) : (
                        <span className="ml-auto text-xs text-muted-foreground">
                          {t('payment_status_view_voucher_unlinked')}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </DefRow>
          {/* Betalningsbekräftelse (#1693): a fresh BETALD render the customer
              can be handed. It belongs to the payment, not the invoice, and
              is a different document from the archived original. */}
          {canSendPaymentConfirmation && (
            <DefRow label={t('payment_confirmation_label')}>
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <button
                  type="button"
                  onClick={downloadPaymentConfirmation}
                  disabled={isDownloadingConfirmation}
                  title={t('payment_confirmation_hint')}
                  className={cn(ROW_ACTION_CLASS, 'inline-flex items-center gap-1')}
                >
                  {isDownloadingConfirmation && <Loader2 className="h-3 w-3 animate-spin" />}
                  {t('payment_confirmation_download_short')}
                </button>
                <button
                  type="button"
                  onClick={() => setShowConfirmationSendDialog(true)}
                  disabled={!canWrite || !customerHasEmail || !canEmail}
                  title={
                    !canWrite
                      ? t('viewer_disabled_tooltip')
                      : !customerHasEmail
                        ? t('payment_confirmation_no_email')
                        : t('payment_confirmation_hint')
                  }
                  className={ROW_ACTION_CLASS}
                >
                  {t('payment_confirmation_send_short')}
                </button>
              </span>
            </DefRow>
          )}
        </DetailSection>
      )}

      {(invoice.status === 'sent' || invoice.status === 'overdue' || reminders.length > 0) && (
        <DetailSection
          kicker={t('reminders_card_title')}
          aside={
            autoRemindersEnabled !== null ? (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {autoRemindersEnabled
                  ? t('reminders_schedule_aside', {
                      day1: reminderDays[0],
                      day2: reminderDays[1],
                      day3: reminderDays[2],
                    })
                  : t('reminders_disabled_aside')}
              </span>
            ) : undefined
          }
        >
          {reminders.length > 0 ? (
            <ul className="divide-y divide-border text-sm">
              {reminders.map((reminder) => (
                <li key={reminder.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                  <span className="tabular-nums text-muted-foreground">{formatDate(reminder.sent_at)}</span>
                  <span>{reminderLevelLabel(reminder.reminder_level as 1 | 2 | 3)}</span>
                  <span className="min-w-0 truncate text-muted-foreground">{reminder.email_to}</span>
                  {/* Chips mark exceptions: an objection is the deviation;
                      "kunden markerat som betald" reads as muted text. */}
                  {reminder.response_type === 'disputed' ? (
                    <Badge variant="destructive" className="ml-auto">{t('reminder_objection')}</Badge>
                  ) : reminder.response_type === 'marked_paid' ? (
                    <span className="ml-auto text-xs text-muted-foreground">{t('reminder_marked_paid')}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('reminders_empty')}</p>
          )}
        </DetailSection>
      )}

      {/* The legacy empty state asserts "sent before delivery history
          existed". A failed read produces the same empty list, so that
          claim would be a guess: say what actually happened instead. */}
      {latestPeppolDelivery && (
        <DetailSection kicker={t('peppol_status_title')}>
          <DefRow label={t('peppol_status_recipient')}>
            <span className="tabular-nums">
              {latestPeppolDelivery.recipient_scheme}:{latestPeppolDelivery.recipient_identifier}
            </span>
          </DefRow>
          <DefRow label={t('peppol_status_label')}>
            <span>{peppolStatusLabel(latestPeppolDelivery.status)}</span>
            {latestPeppolDelivery.status_detail && (
              <span className="block text-xs text-muted-foreground">
                {latestPeppolDelivery.status_detail}
              </span>
            )}
          </DefRow>
          <DefRow label={t('peppol_status_updated')}>
            <span className="tabular-nums">{formatDate(latestPeppolDelivery.status_at)}</span>
          </DefRow>
        </DetailSection>
      )}

      {isRealInvoice && !isSelfBilled && deliveriesUnreadable && (
        <DetailSection kicker={t('delivery_history_title')}>
          <p className="text-sm text-muted-foreground">
            {t('delivery_history_unreadable_description')}{' '}
            <button
              type="button"
              onClick={() => void retryLoadDeliveries()}
              className={cn(ROW_ACTION_CLASS, 'text-foreground')}
            >
              {t('delivery_history_unreadable_retry')}
            </button>
          </p>
        </DetailSection>
      )}

      {isRealInvoice && !isSelfBilled && !deliveriesUnreadable && (
        <InvoiceDeliveryHistory
          deliveries={deliveries}
          showLegacyEmptyState={[
            'sent',
            'paid',
            'partially_paid',
            'overdue',
            'credited',
          ].includes(invoice.status)}
        />
      )}

      {/* Remove/cancel confirmation. An unissued credit-note draft and an
          unnumbered invoice draft are hard deleted; other numbered drafts are
          retained as cancelled to preserve their number series. */}
      {/* Peppol send confirmation (convention 10: confirm up front). */}
      <Dialog open={showPeppolSendDialog} onOpenChange={setShowPeppolSendDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('peppol_send_confirm_title')}</DialogTitle>
            <DialogDescription>
              {t('peppol_send_confirm_description', { recipient: peppolRecipientLabel })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowPeppolSendDialog(false)}
              disabled={isSendingPeppol}
            >
              {t('delete_dialog_cancel')}
            </Button>
            <Button onClick={() => void sendViaPeppol()} disabled={isSendingPeppol}>
              {isSendingPeppol && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSendingPeppol ? t('peppol_sending') : t('peppol_send_confirm_action')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isCreditNote
                ? t('remove_credit_dialog_title')
                : invoice.invoice_number
                  ? t('delete_dialog_title')
                  : t('remove_dialog_title')}
            </DialogTitle>
            <DialogDescription>
              {isCreditNote ? (
                t('remove_credit_dialog_desc')
              ) : invoice.invoice_number ? (
                <>
                  {t('delete_dialog_desc_with_number_1')}
                  <strong>{t('delete_dialog_status_makulerad')}</strong>
                  {t('delete_dialog_desc_with_number_2')}
                  {/* data-ph-mask: interpolates the invoice number */}
                  <span data-ph-mask="" className="mt-2 block text-muted-foreground">
                    {t('delete_dialog_number_kept', { number: invoice.invoice_number })}
                  </span>
                </>
              ) : (
                <>
                  {t('remove_dialog_desc')}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)} disabled={isDeleting}>
              {t('delete_dialog_cancel')}
            </Button>
            <Button variant="destructive" onClick={deleteInvoice} disabled={isDeleting}>
              {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isCreditNote
                ? t('remove_credit_dialog_confirm')
                : invoice.invoice_number
                  ? t('delete_dialog_confirm')
                  : t('remove_dialog_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Finalize confirmation, "Granska & skapa". Allocates the F-number and
          turns the unnumbered draft into a real, issued invoice. */}
      <Dialog open={showFinalizeDialog} onOpenChange={setShowFinalizeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('finalize_dialog_title')}</DialogTitle>
            <DialogDescription>{t('finalize_dialog_desc')}</DialogDescription>
          </DialogHeader>
          {nextNumberPreview && (
            <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/40 px-4 py-3">
              <span className="text-sm text-muted-foreground">{t('finalize_dialog_number_label')}</span>
              <span className="text-base font-medium tabular-nums">{nextNumberPreview}</span>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowFinalizeDialog(false)} disabled={isFinalizing}>
              {t('finalize_dialog_cancel')}
            </Button>
            <Button onClick={finalizeInvoice} disabled={isFinalizing}>
              {isFinalizing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('finalize_dialog_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The archived PDF the customer received could not be produced. Nothing
          has been downloaded at this point: a re-render is a different
          document, so the user chooses it deliberately or not at all. */}
      <Dialog
        open={pdfArchiveIssue !== null}
        onOpenChange={(open) => {
          if (!open) setPdfArchiveIssue(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('pdf_archive_issue_title')}</DialogTitle>
            <DialogDescription>
              {pdfArchiveIssue === 'document'
                ? t('pdf_archive_issue_document_desc')
                : t('pdf_archive_issue_history_desc', { appName })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPdfArchiveIssue(null)}
              disabled={isDownloading}
            >
              {t('pdf_archive_issue_cancel')}
            </Button>
            <Button
              variant="secondary"
              onClick={downloadRerenderAnyway}
              disabled={isDownloading}
            >
              {pdfIntent === 'preview'
                ? t('pdf_archive_issue_rerender_preview')
                : t('pdf_archive_issue_rerender')}
            </Button>
            <Button onClick={retryArchivedDownload} disabled={isDownloading}>
              {isDownloading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('pdf_archive_issue_retry')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PaymentBookingDialog
        open={showPaymentDialog}
        onOpenChange={setShowPaymentDialog}
        invoice={invoice}
        onSuccess={() => {
          fetchInvoice()
          toast({
            title: t('paid_toast_title'),
            description: t('paid_toast_description', { number: invoice.invoice_number ?? '' }),
          })
        }}
      />
      {invoice && (
        <SendInvoiceDialog
          open={showSendDialog}
          onOpenChange={setShowSendDialog}
          invoice={invoice}
          mode={sendDialogMode}
          onSuccess={() => fetchInvoice()}
        />
      )}

      {/* Confirm-before-posting (convention 10): booking writes an immutable
          verifikat, so the outcome is described before the POST, not narrated
          in a toast afterwards. */}
      <ConfirmDialog
        open={showConfirmationSendDialog}
        onOpenChange={setShowConfirmationSendDialog}
        title={t('payment_confirmation_confirm_title')}
        description={t('payment_confirmation_confirm_description', {
          number: invoiceDisplayNumber(invoice as Invoice),
          email: invoice.customer?.email ?? '',
        })}
        confirmLabel={t('payment_confirmation_confirm_action')}
        onConfirm={sendPaymentConfirmation}
      />

      <ConfirmDialog
        open={showBookConfirm}
        onOpenChange={setShowBookConfirm}
        title={t('confirm_book_title')}
        description={
          bookVoucherPreview
            ? t('confirm_book_description', {
                voucher: bookVoucherPreview,
                number: invoiceDisplayNumber(invoice as Invoice),
                amount: formatCurrency(
                  getDisplayTotal(invoice, { ore_rounding: oreRounding }).displayed,
                  invoice.currency,
                ),
              })
            : t('confirm_book_description_generic', {
                number: invoiceDisplayNumber(invoice as Invoice),
              })
        }
        confirmLabel={t('book_action')}
        onConfirm={handleBook}
      />
    </div>
  )
}
