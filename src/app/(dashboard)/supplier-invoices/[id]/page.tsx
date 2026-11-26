'use client'

import { useState, useEffect, useRef } from 'react'
import { useAccounts } from '@/lib/reference-data/hooks'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { DetailSection, DefRow } from '@/components/ui/detail-section'
import { FocusDocumentPreview, useDocumentMeta } from '@/components/inkorg/FocusDocumentPreview'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  ArrowUturnLeftIcon,
  BuildingLibraryIcon,
  CalendarDaysIcon,
  CheckCircleIcon,
  CreditCardIcon,
  DocumentTextIcon,
  EllipsisHorizontalIcon,
  LockClosedIcon,
  TrashIcon,
} from '@/components/icons'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { isCreditableSupplierInvoiceStatus } from '@/lib/bookkeeping/creditable-statuses'
import { supplierCreditBooksOriginalFirst, supplierInvoiceRegistrationDate } from '@/lib/bookkeeping/booking-mode'
import { formatDate, cn, formatRowAmount } from '@/lib/utils'
import Link from 'next/link'
import { AccountNumber } from '@/components/ui/account-number'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import dynamic from 'next/dynamic'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { supplierInvoiceStatusDisplay } from '@/lib/supplier-invoices/status-display'
import type { StatusChip } from '@/lib/status-display'
const PaymentFileDialog = dynamic(() => import('@/components/supplier-invoices/PaymentFileDialog'), { ssr: false })
const PayViaBankDialog = dynamic(() => import('@/components/payments/PayViaBankDialog'), { ssr: false })
import { fetchPaymentsAvailability } from '@/components/payments/payments-client'
import { SupplierPayeeAlertLine } from '@/components/payments/SupplierPayeeAlertLine'
import { readBankHeldPaymentSentences } from '@/components/payments/BankHeldPaymentNotes'
import { AccountChip } from '@/components/ui/account-chip'
import { CategoryPopover } from '@/components/transactions/CategoryPopover'
import TemplatePicker from '@/components/transactions/TemplatePicker'
import { DocumentViewButton } from '@/components/bookkeeping/DocumentViewButton'
import { AccrualLineInfo, useInvoiceAccrualSchedules } from '@/components/bookkeeping/AccrualLineInfo'
import { useCompanySettings } from '@/components/settings/useSettings'
import useSWR from 'swr'
import { StageSteps } from '@/components/supplier-invoices/StageSteps'
import { SplitButton, type SplitButtonOption } from '@/components/ui/split-button'
import { HelpPopover } from '@/components/ui/help-popover'
import { useUiState } from '@/lib/hooks/use-ui-state'
import { resolveInitialMode } from '@/lib/ui-state/client'
import {
  hasOpenBankPaymentOrder,
  openPaymentMarker,
  stagesFor,
  type InvoiceLifecycle,
  type SupplierInvoiceLadderStage,
} from '@/lib/supplier-invoices/stages'
import { paymentOrderWaitsFor } from '@/lib/payments/orders/status'
import { formatCurrency } from '@/lib/utils'
import { supplierInvoiceDisplayFigures } from '@/lib/bookkeeping/supplier-invoice-display-figures'
import {
  canApproveSupplierInvoice,
  canMarkSupplierInvoiceBankEntered,
  canMarkSupplierInvoicePaid,
  companyAttestsSupplierInvoices,
  isUnsettledSupplierInvoiceStatus,
} from '@/lib/supplier-invoices/lifecycle'
import { DetailPager } from '@/components/common/DetailPager'
import { SupplierPaymentDialog } from '@/components/supplier-invoices/SupplierPaymentDialog'
import { PaymentReferenceDialog } from '@/components/supplier-invoices/PaymentReferenceDialog'
import { SupplierInvoiceAttestPanel, useSupplierInvoiceAttest } from '@/components/supplier-invoices/SupplierInvoiceAttestPanel'
import { useAttestPolicyOn } from '@/components/supplier-invoices/use-attest-policy-on'
import { listContextKey } from '@/lib/navigation/list-context'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import type { SupplierInvoice, SupplierInvoiceItem, SupplierInvoicePayment } from '@/types'
import { DetailPageSkeleton } from '@/components/common/DetailPageSkeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { RecordHeader } from '@/components/ui/record-header'
import { PageHeaderOverflowItems } from '@/components/ui/page-header-actions'
import type { BASAccount, EntityType } from '@/types'

// A line is periodiserad when both period dates are set: the cost was parked
// on the 17xx/29xx interim account and dissolves monthly via accrual_schedules.
const itemHasAccrual = (item: SupplierInvoiceItem): boolean =>
  !!(item.accrual_period_start && item.accrual_period_end)


/**
 * The account of one invoice line, editable in place the way a category chip
 * is on a transaction. Committing moves the line and corrects the
 * registration verifikat inline; the server refuses what the period lock
 * refuses, and the cell falls back to the old account.
 */
function InlineAccountCell({
  item,
  editable,
  entityType,
  accounts,
  label,
  onCommit,
}: {
  item: { id: string; account_number: string }
  editable: boolean
  entityType: EntityType
  accounts: BASAccount[]
  label: string
  onCommit: (itemId: string, account: string) => Promise<void>
}) {
  // The category chip from Transaktioner: the account as a hue dot, its
  // name and the number, and the same anchored picker (templates, or an
  // account by search) when it is clicked. A template's debit account is
  // what the line books to; the picker sits beside the row instead of
  // swapping the cell for a combobox.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [manual, setManual] = useState('')
  const accountName = accounts.find((a) => a.account_number === item.account_number)?.account_name ?? null
  const pick = (account: string) => {
    setAnchor(null)
    if (account && account !== item.account_number) void onCommit(item.id, account)
  }
  if (!editable) return <AccountChip account={item.account_number} name={accountName} />
  return (
    <>
      <button
        type="button"
        className="-mx-1 rounded-md px-1 transition-colors duration-150 hover:bg-secondary/60"
        aria-label={label}
        onClick={(e) => {
          setManual('')
          setAnchor(e.currentTarget)
        }}
      >
        <AccountChip account={item.account_number} name={accountName} />
      </button>
      {anchor && (
        <CategoryPopover anchor={anchor} onClose={() => setAnchor(null)}>
          <div className="flex min-h-0 flex-col overflow-hidden">
            <TemplatePicker
              direction="expense"
              entityType={entityType}
              dense
              onSelect={(template) => pick(template.debit_account)}
              onSelectAccount={pick}
            />
          </div>
          {/* Any account in the company's own chart, by number or name: the
              template search covers the common ones, this covers the rest. */}
          <div className="border-t-hairline bg-background px-3 py-2">
            <AccountCombobox value={manual} accounts={accounts} onChange={setManual} onCommit={pick} />
          </div>
        </CategoryPopover>
      )}
    </>
  )
}

/**
 * The supplier's document in the page, as the file itself (V7 Inköp: an
 * external document is shown, never redrawn), with the way to open it in
 * full size under it. The same preview the inbox uses.
 */
function SupplierInvoiceDocument({ documentId, openLabel }: { documentId: string; openLabel: string }) {
  const [generation, setGeneration] = useState(0)
  const { meta, state } = useDocumentMeta(documentId, generation)
  return (
    <div className="overflow-hidden rounded-lg bg-control shadow-raised">
      <FocusDocumentPreview
        meta={meta}
        state={state}
        onRetry={() => setGeneration((n) => n + 1)}
        className="h-[70vh] min-h-[420px]"
      />
      <div className="flex items-center justify-end border-t-hairline px-3 py-2">
        <DocumentViewButton documentId={documentId} label={openLabel} />
      </div>
    </div>
  )
}

export default function SupplierInvoiceDetailPage() {
  const { canWrite } = useCanWrite()
  const { settings: companySettings } = useCompanySettings()
  // Attest is a step only with the company's attest policy on
  // (companyAttestsSupplierInvoices); without one a registered invoice is
  // ready to pay as it stands.
  const attestPolicyOn = useAttestPolicyOn()
  // The invoice's place on the flow (UI v2 PR 6), derived server-side.
  const routeParams = useParams()
  const invoiceIdParam = typeof routeParams.id === 'string' ? routeParams.id : ''
  const { data: lifecycle, mutate: mutateLifecycle } = useSWR<InvoiceLifecycle | null>(
    invoiceIdParam ? `/api/supplier-invoices/lifecycle?ids=${invoiceIdParam}` : null,
    async (url: string) => {
      const res = await fetch(url)
      if (!res.ok) return null
      const json = (await res.json()) as { data: { stages: Record<string, InvoiceLifecycle> } }
      return json.data.stages[invoiceIdParam] ?? null
    },
  )
  // Where the attest stands under the company's attest policy: who attested,
  // who is left, and whether this user may attest at all.
  const { data: attestState, mutate: mutateAttest } = useSupplierInvoiceAttest(invoiceIdParam || null)
  const params = useParams()
  const router = useRouter()
  const company = useCompanyOptional()?.company ?? null
  const { toast } = useToast()
  const t = useTranslations('supplier_invoice_detail')
  const locale = useLocale()
  const tAttest = useTranslations('supplier_invoice_attest')
  const tCommon = useTranslations('common')
  // The list page's "Betald {date}" label, so the header reads like the row.
  const tList = useTranslations('supplier_invoices')
  const [invoice, setInvoice] = useState<SupplierInvoice | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  // What the last read left: nothing wrong, the invoice is gone, or the read
  // failed. A failure with this invoice not on screen says so in place of it;
  // the invoice already on screen stays, with one line above it.
  const [loadError, setLoadError] = useState<{ kind: 'not_found' } | { kind: 'failed'; description: string } | null>(
    null,
  )
  // The rows' periodisering schedules, for "Ändra periodisering".
  const accrualSchedules = useInvoiceAccrualSchedules(
    { supplierInvoiceId: invoiceIdParam },
    !!invoice?.items?.some((item) => itemHasAccrual(item as SupplierInvoiceItem)),
  )
  const [isPayDialogOpen, setIsPayDialogOpen] = useState(false)
  // Chart of accounts for the row account cells, from the session cache
  // (lib/reference-data): one request per session at most, shared with
  // every other picker, instead of a deferred fetch per detail page.
  const { accounts } = useAccounts()
  // Which action is in flight, not just whether one is: the acting button
  // shows the spinner while the others only disable. A single boolean put
  // identical pending feedback (none) on every button at once.
  const [processingAction, setProcessingAction] = useState<
    'approve' | 'book' | 'bank_entered' | 'auto_debit' | 'credit' | 'uncredit' | 'unlink_voucher' | 'delete' | null
  >(null)
  const isProcessing = processingAction !== null
  const [isFileDialogOpen, setIsFileDialogOpen] = useState(false)
  const [isBankDialogOpen, setIsBankDialogOpen] = useState(false)
  const [isOcrDialogOpen, setIsOcrDialogOpen] = useState(false)
  // Betala via banken is offered where bank payments are switched on for the
  // company (GET /api/payments/availability), beside the payment file.
  const [bankPaymentsAvailable, setBankPaymentsAvailable] = useState(false)
  // Seeds the Betala split button with the last-used pay mode.
  const { uiState, loaded: uiStateLoaded } = useUiState()
  useEffect(() => {
    let cancelled = false
    fetchPaymentsAvailability()
      .then((data) => {
        if (!cancelled) setBankPaymentsAvailable(data.available)
      })
      .catch(() => {
        if (!cancelled) setBankPaymentsAvailable(false)
      })
    return () => {
      cancelled = true
    }
  }, [])
  const { dialogProps: confirmDialogProps, confirm: confirmAction } = useDestructiveConfirm()

  // Latest-request guard for fetchInvoice. A mutation refetch can overlap the
  // pager stepping to a sibling invoice (the component stays mounted, only
  // params.id changes), and without it the older response would commit
  // invoice A's row and payment-form defaults under invoice B's URL. Only the
  // newest request may write state.
  const fetchSeqRef = useRef(0)

  // Resolves to the invoice it committed, or null when it committed none (an
  // error, or a newer fetch owns the page), so a caller can act on fresh data.
  async function fetchInvoice(): Promise<SupplierInvoice | null> {
    const seq = ++fetchSeqRef.current
    // Blocking skeleton only before the first paint (or when the pager steps
    // to a different invoice). Attest/Bokför/Markera betald/kreditera each
    // refetch after their mutation: those reconcile behind the mounted page
    // instead of swapping the whole detail for a skeleton and back.
    if (!invoice || invoice.id !== params.id) setIsLoading(true)
    // try/finally: a dropped connection or a non-JSON error page makes
    // res.json() throw, and this runs from an effect, so the rejection is
    // unhandled and isLoading would stay true: a spinner that never resolves.
    try {
      const res = await fetch(`/api/supplier-invoices/${params.id}`)
      const body = await res.json().catch(() => null)
      // A newer fetch owns the page now: commit nothing from this one.
      if (seq !== fetchSeqRef.current) return null
      // See the identical fix in suppliers/[id]: `body.error` is the canonical
      // envelope object, and rendering an object as a toast description throws
      // out of the root layout into global-error.
      if (!res.ok || body?.error || !body?.data) {
        setLoadError(
          res.status === 404
            ? { kind: 'not_found' }
            : {
                kind: 'failed',
                description: getErrorMessage(body, { statusCode: res.status, context: 'supplier_invoice' }),
              },
        )
      } else {
        setInvoice(body.data)
        setLoadError(null)
        return body.data as SupplierInvoice
      }
      return null
    } catch (err) {
      if (seq !== fetchSeqRef.current) return null
      setLoadError({ kind: 'failed', description: getErrorMessage(err, { context: 'supplier_invoice' }) })
      return null
    } finally {
      // A stale request must not stop the newest one's skeleton early: only
      // the request that still owns the page resolves the loading state.
      if (seq === fetchSeqRef.current) setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchInvoice()
  }, [params.id])

  async function handleApprove() {
    setProcessingAction('approve')
    // try/catch/finally like handleDelete: a rejected fetch()/res.json()
    // must not skip the reset below, or isProcessing keeps every invoice
    // action disabled until a full page reload.
    try {
      const res = await fetch(`/api/supplier-invoices/${params.id}/approve`, { method: 'POST' })
      const result = await res.json()
      if (!res.ok) {
        toast({ title: t('approve_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
      } else {
        // Under the attest policy in mode 'all' an approval can be one of
        // several: the invoice is attested only when the last one lands.
        const attest = result?.data?.attest as { approved?: boolean; remaining?: string[] } | undefined
        if (attest && !attest.approved && (attest.remaining?.length ?? 0) > 0) {
          toast({ title: tAttest('approved_waiting', { count: attest.remaining!.length }) })
        } else {
          toast({ title: t('approved_title'), description: t('approved_description') })
        }
        // Awaited: the Attestera button keeps its spinner until the page shows
        // the approved state (the refetch runs behind the mounted content).
        await Promise.all([fetchInvoice(), mutateAttest()])
      }
    } catch (err) {
      toast({ title: t('approve_failed_title'), description: getErrorMessage(err, { context: 'supplier_invoice' }), variant: 'destructive' })
    } finally {
      setProcessingAction(null)
    }
  }

  // "Inlagd i banken" (#2220): the payment was typed into the bank by hand.
  // A mark, not a payment: nothing is booked, so no refetch is needed; the
  // server's timestamp is the only thing that changed.
  async function handleBankEntered(entered: boolean) {
    setProcessingAction('bank_entered')
    try {
      const res = await fetch(`/api/supplier-invoices/${params.id}/bank-entered`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entered }),
      })
      const result = await res.json()
      if (!res.ok) {
        toast({ title: t('bank_entered_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
        // A refusal usually means the row moved (paid meanwhile): re-read.
        await fetchInvoice()
      } else {
        const updated = result?.data as { bank_entered_at?: string | null } | undefined
        setInvoice((prev) =>
          prev ? { ...prev, bank_entered_at: updated?.bank_entered_at ?? null } : prev,
        )
      }
    } catch (err) {
      toast({ title: t('bank_entered_failed_title'), description: getErrorMessage(err, { context: 'supplier_invoice' }), variant: 'destructive' })
    } finally {
      setProcessingAction(null)
    }
  }

  // "Dras automatiskt" (crm#1463): the supplier debits this invoice itself,
  // so it leaves the to-pay lists and payments. Metadata on the invoice, set
  // through the same update as its dates and reference.
  async function handleAutoDebit(autoDebit: boolean) {
    setProcessingAction('auto_debit')
    try {
      const res = await fetch(`/api/supplier-invoices/${params.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_debit: autoDebit }),
      })
      const result = await res.json()
      if (!res.ok) {
        toast({ title: t('auto_debit_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
      }
      await fetchInvoice()
    } catch (err) {
      toast({ title: t('auto_debit_failed_title'), description: getErrorMessage(err, { context: 'supplier_invoice' }), variant: 'destructive' })
    } finally {
      setProcessingAction(null)
    }
  }

  // #967: deferred booking: create the registration verifikat afterwards.
  // A posting action confirms up front with the outcome (as Bokför on a
  // customer invoice does), naming the date the server books it on. The date
  // comes from the invoice as it is now, not the copy this page loaded:
  // another session may have changed the invoice date since, and the server
  // books by its own fresh read.
  async function handleBook() {
    if (!invoice) return
    const current = await fetchInvoice()
    if (!current || current.registration_journal_entry_id) return
    const ok = await confirmAction({
      title: t('book_confirm_title'),
      description: t('book_confirm_description', {
        date: formatDate(supplierInvoiceRegistrationDate(current, current.supplier?.supplier_type)),
      }),
      confirmLabel: t('book_action'),
      cancelLabel: tCommon('cancel'),
      variant: 'warning',
    })
    if (!ok) return
    setProcessingAction('book')
    try {
      const res = await fetch(`/api/supplier-invoices/${params.id}/book`, { method: 'POST' })
      const result = await res.json()
      if (!res.ok) {
        toast({ title: t('book_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
      } else if (Array.isArray(result.warnings) && result.warnings.length > 0) {
        // Booked, but a follow-up is needed (e.g. periodiseringar failed).
        toast({ title: t('booked_title'), description: t('booked_with_warnings_description'), variant: 'destructive' })
        await fetchInvoice()
      } else {
        toast({ title: t('booked_title'), description: t('booked_description') })
        await fetchInvoice()
      }
    } catch (err) {
      toast({ title: t('book_failed_title'), description: getErrorMessage(err, { context: 'supplier_invoice' }), variant: 'destructive' })
    } finally {
      setProcessingAction(null)
    }
  }

  async function handleCredit() {
    // accounted#58: a deferring company's unbooked invoice is booked first,
    // on its own date, then reversed by the credit.
    const booksFirst = !!invoice && supplierCreditBooksOriginalFirst(companySettings, invoice)
    // A payment the bank holds for the invoice (Betala via banken), said
    // before the confirm: a signed one still goes out, so the credit is
    // refused until it is cancelled; an unsigned one is cancelled at the bank.
    const bankPaymentNotes =
      company && invoiceIdParam ? await readBankHeldPaymentSentences(company.id, [invoiceIdParam], 'other', locale) : []
    const ok = await confirmAction({
      title: t('credit_confirm_title'),
      description: [
        t(booksFirst ? 'credit_confirm_description_books_first' : 'credit_confirm_description'),
        ...bankPaymentNotes,
      ].join('\n\n'),
      confirmLabel: t('credit_confirm_label'),
      variant: 'warning',
    })
    if (!ok) return
    setProcessingAction('credit')
    try {
      const res = await fetch(`/api/supplier-invoices/${params.id}/credit`, { method: 'POST' })
      const result = await res.json()
      if (!res.ok) {
        toast({ title: t('credit_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
      } else {
        toast({ title: t('credit_success_title') })
        await fetchInvoice()
      }
    } catch (err) {
      toast({ title: t('credit_failed_title'), description: getErrorMessage(err, { context: 'supplier_invoice' }), variant: 'destructive' })
    } finally {
      setProcessingAction(null)
    }
  }

  async function handleDelete() {
    // The DELETE runs as the confirm's action: the dialog holds open with its
    // pending spinner until the server answers (it used to close on click and
    // leave the destructive icon button active with no feedback until the
    // route swap, permitting duplicate DELETEs).
    await confirmAction({
      title: t('delete_confirm_title'),
      description: t('delete_confirm_description'),
      confirmLabel: t('delete_confirm_label'),
      variant: 'destructive',
    }, async () => {
      setProcessingAction('delete')
      try {
        const res = await fetch(`/api/supplier-invoices/${params.id}`, { method: 'DELETE' })
        const result = await res.json()
        if (!res.ok) {
          toast({ title: t('delete_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
        } else {
          toast({ title: t('deleted_title') })
          router.push('/supplier-invoices')
          return
        }
      } catch (err) {
        toast({
          title: t('delete_failed_title'),
          description: getErrorMessage(err, { context: 'supplier_invoice' }),
          variant: 'destructive',
        })
      }
      // Only cleared on failure: on success the pending state rides through
      // the route swap instead of re-enabling the button mid-navigation.
      setProcessingAction(null)
    })
  }

  // "Koppla bort": the undo of a link to an existing verifikat (Markera som
  // betald, Befintlig verifikation). Only the payment row goes; the verifikat
  // is not touched and the invoice becomes unpaid again by the row's amount.
  async function handleUnlinkVoucher(payment: SupplierInvoicePayment) {
    const amount = formatCurrency(payment.amount, payment.currency)
    const ok = await confirmAction({
      title: t('unlink_voucher_confirm_title'),
      description: t('unlink_voucher_confirm_description', { amount }),
      confirmLabel: t('unlink_voucher_confirm_label'),
      variant: 'warning',
    })
    if (!ok) return
    setProcessingAction('unlink_voucher')
    try {
      const res = await fetch(`/api/supplier-invoices/${params.id}/unlink-voucher`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_id: payment.id }),
      })
      const result = await res.json()
      if (!res.ok) {
        toast({
          title: t('unlink_voucher_failed_title'),
          description: getErrorMessage(result, { context: 'supplier_invoice' }),
          variant: 'destructive',
        })
        // A refusal usually means the row moved since the page was read.
        await fetchInvoice()
      } else {
        const description = t('unlink_voucher_success_description', { amount })
        toast({
          title: t('unlink_voucher_success_title'),
          description: result?.data?.document_on_voucher
            ? `${description} ${t('unlink_voucher_success_document_note')}`
            : description,
        })
        await Promise.all([fetchInvoice(), mutateLifecycle()])
      }
    } catch (err) {
      toast({
        title: t('unlink_voucher_failed_title'),
        description: getErrorMessage(err, { context: 'supplier_invoice' }),
        variant: 'destructive',
      })
    } finally {
      setProcessingAction(null)
    }
  }

  async function handleUncredit() {
    const ok = await confirmAction({
      title: t('uncredit_confirm_title'),
      description: t('uncredit_confirm_description'),
      confirmLabel: t('uncredit_confirm_label'),
      variant: 'warning',
    })
    if (!ok) return
    setProcessingAction('uncredit')
    try {
      const res = await fetch(`/api/supplier-invoices/${params.id}/uncredit`, { method: 'POST' })
      const result = await res.json()
      if (!res.ok) {
        toast({
          title: t('uncredit_failed_title'),
          description: getErrorMessage(result, { context: 'supplier_invoice' }),
          variant: 'destructive',
        })
      } else {
        toast({
          title: t('uncredit_success_title'),
          description: t('uncredit_success_description'),
        })
        await fetchInvoice()
      }
    } catch (err) {
      toast({
        title: t('uncredit_failed_title'),
        description: getErrorMessage(err, { context: 'supplier_invoice' }),
        variant: 'destructive',
      })
    } finally {
      setProcessingAction(null)
    }
  }

  // ?action=credit, from a verifikat this invoice owns (Kreditera fakturan in
  // OwnedVoucherActionDialog): the Kreditera confirm opens once the invoice
  // is loaded, when this page offers it, and the parameter is dropped so a
  // reload does not ask again.
  const searchParams = useSearchParams()
  const creditOnArrival = searchParams.get('action') === 'credit'
  const creditOnArrivalHandled = useRef(false)
  useEffect(() => {
    if (!creditOnArrival || creditOnArrivalHandled.current || !invoice || invoice.id !== params.id) return
    creditOnArrivalHandled.current = true
    router.replace(`/supplier-invoices/${invoice.id}`, { scroll: false })
    if (canWrite && isCreditableSupplierInvoiceStatus(invoice.status)) void handleCredit()
  }, [creditOnArrival, invoice, params.id, canWrite, router, handleCredit])

  if (isLoading) {
    return <DetailPageSkeleton cards={3} />
  }

  // A pager step that failed leaves the previous invoice in state: never show
  // it under this id.
  if (!invoice || (loadError && invoice.id !== params.id)) {
    return (
      <div className="space-y-8">
        <PageHeader title={tList('title')} />
        {loadError?.kind === 'failed' ? (
          <LoadError
            title={t('load_failed_title')}
            description={loadError.description}
            onRetry={() => void fetchInvoice()}
          />
        ) : (
          <EmptyState title={t('not_found')} actionLabel={t('back')} actionHref="/supplier-invoices" />
        )}
      </div>
    )
  }

  // Not while the payment dialog is open: its booking rows are the ones in play.
  const lineAccountEditable = canWrite && isUnsettledSupplierInvoiceStatus(invoice.status) && !isPayDialogOpen
  // The OCR can be added or corrected until the invoice is paid: a payee
  // under hard OCR control refuses a payment without it.
  const ocrEditable = canWrite && isUnsettledSupplierInvoiceStatus(invoice.status) && !invoice.is_credit_note
  async function changeLineAccount(itemId: string, account: string) {
    try {
      const res = await fetch(`/api/supplier-invoices/${params.id}/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_number: account }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || body?.error) {
        toast({ title: t('line_account_change_failed'), description: getErrorMessage(body, { statusCode: res.status, context: 'supplier_invoice' }), variant: 'destructive' })
        return
      }
      toast({ title: t(body?.data?.corrected ? 'line_account_changed_corrected' : 'line_account_changed') })
      void fetchInvoice()
    } catch (err) {
      toast({ title: t('line_account_change_failed'), description: getErrorMessage(err, { context: 'supplier_invoice' }), variant: 'destructive' })
    }
  }
  const items = (invoice.items || []) as SupplierInvoiceItem[]
  const payments = (invoice.payments || []) as SupplierInvoicePayment[]
  const creditedOriginal =
    (invoice as SupplierInvoice & {
      credited_original?: { id: string; supplier_invoice_number: string | null; arrival_number: number } | null
    }).credited_original ?? null

  // Display-only öresavrundning: the same figures the editor and the review
  // step showed. The stored total/booked verifikat keep the exact öre; a null
  // flag resolves to off (supplier invoices never had a company-wide setting).
  const { rounding } = supplierInvoiceDisplayFigures({
    total: invoice.total,
    currency: invoice.currency,
    ore_rounding: invoice.ore_rounding,
  })

  // Document title: the supplier's own invoice number with the kind spelled
  // out ("Leverantörsfaktura 4711", "Kreditfaktura K-12"). The arrival number
  // moves to the meta line and the facts below; an invoice registered without
  // a supplier number keeps the arrival number as its title.
  const docNumber = invoice.supplier_invoice_number
  // A självfaktura (crm#1367) is titled as one: the number is the company's.
  const title = !docNumber
    ? t('arrival_header', { number: invoice.arrival_number })
    : invoice.is_credit_note
      ? t('title_credit_note', { number: docNumber })
      : invoice.is_self_billed
        ? t('title_self_billed', { number: docNumber })
        : t('title_invoice', { number: docNumber })

  // One status element, the same as the list row and the supplier page
  // (lib/supplier-invoices/status-display.ts): approved and paid render as
  // muted text, everything that deviates gets a chip.
  const attests = companyAttestsSupplierInvoices(companySettings?.accounting_method, attestPolicyOn)
  const statusDisplay = supplierInvoiceStatusDisplay(invoice.status, { attests })
  const status: { label: string; exception: boolean; variant?: StatusChip } =
    invoice.status === 'paid' && invoice.paid_at
      ? { label: tList('status_paid_date', { date: formatDate(invoice.paid_at) }), exception: false }
      : !statusDisplay
        ? { label: invoice.status, exception: true, variant: 'secondary' }
        : {
            label: tList(statusDisplay.labelKey),
            exception: statusDisplay.chip !== null,
            variant: statusDisplay.chip ?? undefined,
          }

  // The list row's marker, from the same derivation: a payment instruction
  // already covers the invoice. It links to where that payment is followed.
  const openPayment = openPaymentMarker({ ...invoice, open_payment: lifecycle ?? null })

  // Attest keys off approved_at, not the status: the overdue cron flips
  // unbooked invoices to 'overdue' just by aging, and gating on 'registered'
  // alone left them with no way through attest (#1206).
  // Only a company with an attest step is asked to attest
  // (companyAttestsSupplierInvoices: faktureringsmetoden with the attest
  // policy on). The same rule keeps the rest out of the Att göra attest count
  // (crm#1156). With the attest policy governing the invoice, only the people
  // it lets attest see the button (the server refuses everyone else anyway).
  const canApprove =
    canApproveSupplierInvoice(invoice) &&
    !invoice.is_credit_note &&
    attests &&
    (!attestState?.required || attestState.viewer.may_approve)
  // A viewer the policy names attests too (crm#1569); everyone else with
  // read access sees the button locked, as before.
  const mayAttest = canWrite || (attestState?.required === true && attestState.viewer.may_approve)
  // The strip's dates: when each done or current step happened.
  const stageDate = (s: SupplierInvoiceLadderStage): string | null => {
    switch (s) {
      case 'incoming':
      case 'registered':
        return formatDate(invoice.created_at)
      case 'approved':
        return invoice.approved_at ? formatDate(invoice.approved_at) : null
      case 'in_file': {
        // Same step, two kinds of evidence: a payment file or a bank payment.
        const opened = lifecycle?.payment_order?.created_at ?? lifecycle?.batch?.created_at
        return opened ? formatDate(opened) : null
      }
      case 'paid': {
        const paid = invoice.paid_at ?? lifecycle?.paid?.date
        return paid ? formatDate(paid) : null
      }
      case 'reconciled':
        return lifecycle?.reconciled_through ? formatDate(lifecycle.reconciled_through) : null
    }
  }
  // Markera som betald (and with it Befintlig verifikation): past attest, or
  // registered where the company has no attest step (kontantmetoden, or no
  // attest policy on), as Lägg i betalfil below (crm#1141).
  const canMarkPaid = canMarkSupplierInvoicePaid(invoice, companySettings?.accounting_method, attestPolicyOn)
  // After attest the next step is the betalfil to the bank, so that is the
  // header's one primary while the invoice is attested and in no open file.
  // Markera betald stays for the person who paid by hand, as a secondary.
  // A company without an attest step (canApprove above) has its registered
  // invoice ready to pay as it stands, as on the list.
  const canAddToFile =
    !invoice.is_credit_note &&
    !invoice.auto_debit &&
    ['registered', 'approved', 'overdue'].includes(invoice.status) &&
    (!!invoice.approved_at || !attests) &&
    !lifecycle?.batch &&
    !lifecycle?.payment_order
  // With bank payments on, Betala via banken comes first and the betalfil
  // second (same order as the list's bulk bar).
  const canPayViaBank = canAddToFile && bankPaymentsAvailable
  // "Inlagd i banken" (#2220) sits on the same rows as Markera som betald:
  // it is the step right before it. Viewers see the bock only when it is set.
  const showBankEntered =
    !invoice.auto_debit &&
    canMarkSupplierInvoiceBankEntered(invoice, companySettings?.accounting_method, attestPolicyOn) &&
    (canWrite || !!invoice.bank_entered_at)
  // "Dras automatiskt" (crm#1463): changeable while the invoice is unsettled
  // and no payment file or bank payment covers it; shown when set.
  const canSetAutoDebit =
    canWrite &&
    !invoice.is_credit_note &&
    isUnsettledSupplierInvoiceStatus(invoice.status) &&
    !lifecycle?.batch &&
    !lifecycle?.payment_order
  // Kreditera on the statuses the shared rule names (creditable-statuses.ts);
  // a company without an attest step has its registered invoice creditable
  // as it stands, as it is payable (payableSupplierInvoiceStatuses).
  const canCredit =
    isCreditableSupplierInvoiceStatus(invoice.status) ||
    (invoice.status === 'registered' && !attests)
  const canUncredit = invoice.status === 'credited' && !invoice.is_credit_note
  // Delete is allowed while nothing would be orphaned: no booking, no
  // payments (server re-checks). 'approved'/'overdue' are included because
  // the overdue cron flips unbooked invoices there and a registered-only gate
  // made them undeletable just by aging.
  const canDelete =
    ['registered', 'approved', 'overdue'].includes(invoice.status) &&
    !invoice.is_credit_note &&
    !invoice.registration_journal_entry_id &&
    payments.length === 0
  // Secondary actions collapse into one overflow menu (convention 9: one
  // obvious next step in the header, the alternatives behind a caret).
  const hasMenu = canCredit || canDelete
  // The ways to pay collapse into one split button (convention 9) whose face
  // is the last-used mode; each mode keeps its own gate above. Attest gates
  // payment, so while attest is pending the button steps back to outline and
  // the header keeps one next step (an aged-but-unattested invoice can be
  // marked paid). With a bank payment open, paying is never the next step
  // (crm#1243).
  const payDisabledTitle = !canWrite ? t('viewer_disabled_tooltip') : undefined
  const payOptions: SplitButtonOption[] = [
    ...(canPayViaBank
      ? [{ key: 'bank', label: tList('bulk_pay_via_bank'), icon: canWrite ? BuildingLibraryIcon : LockClosedIcon, onSelect: () => setIsBankDialogOpen(true) }]
      : []),
    ...(canAddToFile
      ? [{ key: 'file', label: t('add_to_payment_file'), icon: canWrite ? DocumentTextIcon : LockClosedIcon, onSelect: () => setIsFileDialogOpen(true) }]
      : []),
    ...(canMarkPaid
      ? [{ key: 'mark_paid', label: t('mark_paid'), icon: canWrite ? CreditCardIcon : LockClosedIcon, onSelect: () => setIsPayDialogOpen(true) }]
      : []),
  ].map((option) => ({ ...option, disabled: isProcessing || !canWrite, disabledTitle: payDisabledTitle }))
  const payVariant = canApprove || hasOpenBankPaymentOrder(openPayment) ? 'outline' : 'default'
  const singlePayOption = payOptions.length === 1 ? payOptions[0] : null
  // #967: registered-without-booking (deferred booking). Ekonomi books the
  // registration verifikat from here.
  const canBookAfterwards =
    companySettings?.accounting_method === 'accrual' &&
    !invoice.is_credit_note &&
    ['registered', 'approved', 'overdue'].includes(invoice.status)

  const accrualInfo = (item: SupplierInvoiceItem) =>
    itemHasAccrual(item) ? (
      <AccrualLineInfo
        start={item.accrual_period_start!}
        end={item.accrual_period_end!}
        balanceAccount={item.accrual_balance_account}
        schedule={accrualSchedules.scheduleForItem(item.id)}
        canWrite={canWrite}
        onReplan={accrualSchedules.openReplan}
      />
    ) : null

  const statusChips = (
    <>
      {status.exception ? (
        <Badge variant={status.variant}>{status.label}</Badge>
      ) : (
        <span className="text-sm text-muted-foreground">{status.label}</span>
      )}
      {items.some(itemHasAccrual) && (
        <Badge variant="outline" className="gap-1">
          <CalendarDaysIcon className="h-3 w-3" />
          {t('badge_accrued')}
        </Badge>
      )}
      {invoice.is_self_billed && <Badge variant="outline">{t('badge_self_billed')}</Badge>}
    </>
  )

  return (
    <div className="space-y-8 stagger-enter">
      {/* Header: serif title with one status element, a quiet meta line, and
          the next step on the right. Everything else lives in the ⋯ menu.
          The sidebar says where we are, so there is no back link; the
          prev/next pager sits in the bar. */}
      <RecordHeader
        parent={{ label: tList('title'), href: '/supplier-invoices' }}
        title={title}
        mask
        help={
          <HelpPopover>
            {attests
              ? t('help_body')
              : companySettings?.accounting_method === 'cash'
                ? t('help_body_cash')
                : t('help_body_no_attest')}
          </HelpPopover>
        }
        status={statusChips}
        actions={<>
          <DetailPager
            contextKey={listContextKey('supplier-invoices', company?.id)}
            basePath="/supplier-invoices"
            currentId={String(params.id)}
            className="shrink-0"
          />
          {/* The supplier's own document, reviewed in the browser (#1190). */}
          {invoice.document_id && (
            <DocumentViewButton documentId={invoice.document_id} label={t('view_document')} iconOnly />
          )}
          {/* A självfaktura is our document: rendered from the frozen parties (crm#1367). */}
          {invoice.is_self_billed && (
            <Button size="toolbar" variant="outline" asChild>
              <a href={`/api/supplier-invoices/${invoice.id}/self-billing-pdf?disposition=inline`} target="_blank" rel="noreferrer">
                <DocumentTextIcon className="mr-2 h-4 w-4" />
                {t('download_self_billing')}
              </a>
            </Button>
          )}
          {canApprove && (
            <Button size="toolbar"
              onClick={handleApprove}
              disabled={isProcessing || !mayAttest}
              loading={processingAction === 'approve'}
              title={!mayAttest ? t('viewer_disabled_tooltip') : undefined}
            >
              {processingAction === 'approve' ? null : mayAttest ? (
                <CheckCircleIcon className="h-4 w-4" />
              ) : (
                <LockClosedIcon className="h-4 w-4" />
              )}
              {t('approve')}
            </Button>
          )}
          {payOptions.length > 1 ? (
            <SplitButton
              key={`${uiStateLoaded ? 'loaded' : 'initial'}-${payOptions.map((o) => o.key).join('-')}`}
              persistKey="supplier_invoice_pay"
              initialModeKey={resolveInitialMode(
                uiState,
                'supplier_invoice_pay',
                payOptions.map((o) => o.key),
                payOptions[0].key,
              )}
              options={payOptions}
              variant={payVariant}
            />
          ) : singlePayOption ? (
            <Button
              size="toolbar"
              variant={payVariant}
              onClick={singlePayOption.onSelect}
              disabled={singlePayOption.disabled}
              title={singlePayOption.disabledTitle}
            >
              {singlePayOption.icon && <singlePayOption.icon className="h-4 w-4" />}
              {singlePayOption.label}
            </Button>
          ) : null}
          {canUncredit && (
            <Button size="toolbar"
              variant="outline"
              onClick={handleUncredit}
              disabled={isProcessing || !canWrite}
              loading={processingAction === 'uncredit'}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {processingAction === 'uncredit' ? null : canWrite ? (
                <ArrowUturnLeftIcon className="h-4 w-4" />
              ) : (
                <LockClosedIcon className="h-4 w-4" />
              )}
              {t('uncredit_button')}
            </Button>
          )}

          {hasMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-toolbar"
                  aria-label={tCommon('more_options')}
                  data-topbar-overflow-host=""
                  loading={processingAction === 'credit' || processingAction === 'delete'}
                >
                  {processingAction !== 'credit' && processingAction !== 'delete' && (
                    <EllipsisHorizontalIcon className="h-4 w-4" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[240px]">
                {/* On a phone the bar's other actions are listed here first. */}
                <PageHeaderOverflowItems />
                {canCredit && (
                  <DropdownMenuItem onSelect={() => void handleCredit()} disabled={isProcessing || !canWrite}>
                    <DocumentTextIcon className="h-4 w-4" />
                    {t('credit_note_button')}
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <>
                    {canCredit && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      onSelect={() => void handleDelete()}
                      disabled={isProcessing || !canWrite}
                      className="text-destructive focus:text-destructive"
                    >
                      <TrashIcon className="h-4 w-4" />
                      {t('delete_confirm_label')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>}
      />

      {loadError && (
        <AttnLine action={{ label: tCommon('retry'), onClick: () => void fetchInvoice() }}>
          {tCommon('refresh_failed')}
        </AttnLine>
      )}

      {lifecycle && (
        <StageSteps
          stages={stagesFor(companySettings?.accounting_method, attestPolicyOn)}
          current={lifecycle.stage}
          dateOf={stageDate}
        />
      )}

      {attestState && (
        <SupplierInvoiceAttestPanel
          state={attestState}
          onChanged={async () => {
            await Promise.all([fetchInvoice(), mutateAttest()])
          }}
        />
      )}
      {/* Bank details the invoice states that hold its payment back. */}
      {!invoice.is_credit_note && <SupplierPayeeAlertLine supplierInvoiceId={invoice.id} />}

      {/* The invoice head is one line of facts. The number is the title, the
          dates that moved are on the strip, so only the supplier and the
          document facts remain. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-muted-foreground" data-ph-mask>
        {invoice.supplier && (
          <Link href={`/suppliers/${invoice.supplier.id}`} className="text-foreground hover:underline">
            {invoice.supplier.name}
          </Link>
        )}
        {invoice.supplier?.org_number && (
          <span>
            {t('def_org_number')} <span className="tabular-nums text-foreground">{invoice.supplier.org_number}</span>
          </span>
        )}
        <span>
          {t('invoice_date_label')} <span className="tabular-nums text-foreground">{formatDate(invoice.invoice_date)}</span>
        </span>
        <span>
          {t('due_date_label')} <span className="tabular-nums text-foreground">{formatDate(invoice.due_date)}</span>
        </span>
        <span>
          {t('arrival_number_label')} <span className="tabular-nums text-foreground">#{invoice.arrival_number}</span>
        </span>
        {invoice.fortnox_number && (
          <span>
            {t('fortnox_number_label')} <span className="tabular-nums text-foreground">{invoice.fortnox_number}</span>
          </span>
        )}
        {(invoice.payment_reference || ocrEditable) && (
          <span>
            {t('ocr_reference_label')}{' '}
            {invoice.payment_reference && <span className="tabular-nums text-foreground">{invoice.payment_reference}</span>}
            {ocrEditable && (
              <button
                type="button"
                onClick={() => setIsOcrDialogOpen(true)}
                className={cn('text-foreground underline-offset-2 hover:underline', invoice.payment_reference && 'ml-1.5 text-muted-foreground')}
              >
                {invoice.payment_reference ? t('ocr_edit') : t('ocr_add')}
              </button>
            )}
          </span>
        )}
        {invoice.reverse_charge && <span>{t('reverse_charge_badge')}</span>}
        {invoice.is_credit_note && (
          <span>
            {t('def_credits')}{' '}
            {creditedOriginal ? (
              <Link href={`/supplier-invoices/${creditedOriginal.id}`} className="text-foreground hover:underline">
                {creditedOriginal.supplier_invoice_number
                  ? t('title_invoice', { number: creditedOriginal.supplier_invoice_number })
                  : t('arrival_header', { number: creditedOriginal.arrival_number })}
              </Link>
            ) : (
              t('credit_note_banner_original_fallback')
            )}
          </span>
        )}
      </div>

      {/* The document and its lines on the left, the facts about payment and
          booking in a capped column on the right (V7 Inköp: label-value rows
          do not stretch across the panel). One column below xl. */}
      <div className="grid gap-x-12 gap-y-8 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-8">
          {/* The supplier's own document, shown as the file itself. */}
          {invoice.document_id && (
            <SupplierInvoiceDocument documentId={invoice.document_id} openLabel={t('view_document')} />
          )}

          {/* Invoice lines: the list-page table idiom straight on the panel, with
              the totals as a right-aligned block and the total in the serif. */}
          <DetailSection kicker={t('rows_title')}>
            {/* overflow-x-auto: from md the eight columns can outgrow the panel (768 px
                with the sidebar leaves ~480 px); the row scrolls instead of the page. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={cn(TH_CLASS, 'pl-0')}>{t('col_description')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_quantity')}</th>
                    <th className={TH_CLASS}>{t('col_unit')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_unit_price')}</th>
                    <th className={TH_CLASS}>{t('col_account')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_vat_rate')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                    <th className={cn(TH_CLASS, 'pr-0 text-right')}>{t('col_vat')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td className={cn(TD_CLASS, 'pl-0')}>
                        {item.description}
                        {accrualInfo(item)}
                      </td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{item.quantity}</td>
                      <td className={cn(TD_CLASS, 'text-muted-foreground')}>{item.unit}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>
                        {formatRowAmount(item.unit_price, invoice.currency)}
                      </td>
                      <td className={TD_CLASS}>
                        <InlineAccountCell item={item} editable={lineAccountEditable} entityType={(company?.entity_type ?? 'aktiebolag') as EntityType} accounts={accounts} label={t('line_account_edit')} onCommit={changeLineAccount} />
                      </td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{Math.round(item.vat_rate * 100)}%</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>
                        {formatRowAmount(item.line_total, invoice.currency)}
                      </td>
                      <td className={cn(TD_CLASS, 'pr-0 text-right tabular-nums')}>
                        {formatRowAmount(item.vat_amount, invoice.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Narrow screens: one flat row per line, no numeric columns to cram. */}
            <div className="divide-y divide-border text-sm md:hidden">
              {items.map((item) => (
                <div key={item.id} className="flex items-start justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p>{item.description}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {item.quantity} {item.unit} × {formatCurrency(item.unit_price, invoice.currency)}
                    </p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      <AccountNumber number={item.account_number} />
                      {' · '}{t('vat_inline', { rate: Math.round(item.vat_rate * 100) })}
                      {' · '}{t('vat_amount_inline', { amount: formatCurrency(item.vat_amount, invoice.currency) })}
                    </p>
                    {accrualInfo(item)}
                  </div>
                  <span className="shrink-0 tabular-nums">
                    {formatCurrency(item.line_total, invoice.currency)}
                  </span>
                </div>
              ))}
            </div>

            <div className="ml-auto mt-4 w-full max-w-xs space-y-1 text-sm tabular-nums">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t('net_excl_vat')}</span>
                <span>{formatCurrency(invoice.subtotal, invoice.currency)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t('vat_label')}</span>
                <span>{formatCurrency(invoice.vat_amount, invoice.currency)}</span>
              </div>
              {rounding.applies && (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{t('ore_rounding')}</span>
                  <span>{formatCurrency(rounding.roundingDelta, invoice.currency)}</span>
                </div>
              )}
              <div className="flex items-baseline justify-between gap-4 border-t-hairline pt-2">
                <span>{t('total_label')}</span>
                <span className="font-display text-xl">{formatCurrency(rounding.displayed, invoice.currency)}</span>
              </div>
            </div>
          </DetailSection>

          {invoice.notes && (
            <DetailSection kicker={t('notes_title')}>
              <p className="py-2 text-sm text-muted-foreground whitespace-pre-wrap">{invoice.notes}</p>
            </DetailSection>
          )}
        </div>
        <div className="min-w-0 space-y-8">
          {/* Payment: paid / remaining always, plus the payment events once any
              exist, so a partly paid invoice exposes what is still open. */}
          <DetailSection kicker={t('payment_section')}>
            {lifecycle?.batch && (
              <DefRow label={t('payment_file_label')}>
                <Link href="/supplier-invoices/payment-files" className="hover:underline underline-offset-4">
                  {t('payment_file_created', { date: formatDate(lifecycle.batch.created_at) })}
                </Link>
              </DefRow>
            )}
            {/* An open bank payment, linked to where it is followed (the header
                chip that used to carry the link repeated the strip). One that
                still waits for a person says so: that page is where it is
                approved and signed. */}
            {lifecycle?.payment_order && (
              <DefRow label={t('bank_payment_label')}>
                <Link href="/payments" className="hover:underline underline-offset-4">
                  {t(paymentOrderWaitsFor(lifecycle.payment_order) ? 'bank_payment_created_unsigned' : 'bank_payment_created', {
                    date: formatDate(lifecycle.payment_order.created_at),
                  })}
                </Link>
              </DefRow>
            )}
            {(canSetAutoDebit || (invoice.auto_debit && !invoice.is_credit_note)) && (
              <DefRow label={t('payment_method_label')}>
                {canSetAutoDebit ? (
                  <label className={cn('inline-flex select-none items-center gap-2', !isProcessing ? 'cursor-pointer' : 'cursor-default', processingAction === 'auto_debit' && 'opacity-50')}>
                    <Checkbox
                      checked={!!invoice.auto_debit}
                      disabled={isProcessing}
                      onCheckedChange={(value) => void handleAutoDebit(value === true)}
                      aria-label={t('auto_debit_aria')}
                    />
                    <span className="text-muted-foreground">
                      {invoice.auto_debit ? t('auto_debit_on', { date: formatDate(invoice.due_date) }) : t('auto_debit_hint')}
                    </span>
                  </label>
                ) : (
                  <span className="text-muted-foreground">{t('auto_debit_on', { date: formatDate(invoice.due_date) })}</span>
                )}
              </DefRow>
            )}
            {/* The bock (#2220): "I have entered this payment in the bank". A
                labelled checkbox rather than a button, because it is a fact the
                user records, not an action that posts anything. */}
            {showBankEntered && !lifecycle?.batch && (!lifecycle?.payment_order || !!invoice.bank_entered_at) && (
              <DefRow label={t('bank_entered_label')}>
                <label className={cn('inline-flex select-none items-center gap-2', canWrite && !isProcessing ? 'cursor-pointer' : 'cursor-default', processingAction === 'bank_entered' && 'opacity-50')}>
                  <Checkbox
                    checked={!!invoice.bank_entered_at}
                    disabled={isProcessing || !canWrite}
                    onCheckedChange={(value) => void handleBankEntered(value === true)}
                    aria-label={t('bank_entered_aria')}
                  />
                  <span className="text-muted-foreground">
                    {invoice.bank_entered_at ? formatDate(invoice.bank_entered_at) : t('bank_entered_hint')}
                  </span>
                </label>
              </DefRow>
            )}
            <DefRow label={t('paid_label')}>
              <span className="tabular-nums">{formatCurrency(invoice.paid_amount, invoice.currency)}</span>
            </DefRow>
            <DefRow label={t('remaining_label')}>
              <span className={cn('tabular-nums', invoice.status === 'partially_paid' && 'text-attn')}>
                {formatCurrency(invoice.remaining_amount, invoice.currency)}
              </span>
            </DefRow>
            {payments.length > 0 && (
              <DefRow label={t('payment_history_title')} className="items-baseline">
                <ul className="divide-y divide-border">
                  {payments.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0">
                      <span className="tabular-nums text-muted-foreground">{formatDate(p.payment_date)}</span>
                      <span className="tabular-nums">{formatCurrency(p.amount, p.currency)}</span>
                      {p.notes && <span className="min-w-0 truncate text-muted-foreground">{p.notes}</span>}
                      {p.journal_entry_id && (
                        <Link
                          href={`/bookkeeping/${p.journal_entry_id}`}
                          className="ml-auto text-xs text-muted-foreground hover:text-foreground hover:underline"
                        >
                          {t('view_voucher')}
                        </Link>
                      )}
                      {/* Only on a plain link to an existing verifikat (the
                          server marks the row); a booked payment is undone by a
                          storno of its verifikat instead. */}
                      {p.can_unlink_voucher && canWrite && (
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50"
                          onClick={() => void handleUnlinkVoucher(p)}
                          disabled={isProcessing}
                        >
                          {t('unlink_voucher_action')}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </DefRow>
            )}
          </DetailSection>

          {/* Verifikat and underlag (sambandskrav): the booking this invoice
              produced, and the supplier's document it rests on. */}
          <DetailSection kicker={t('vouchers_title')}>
            <DefRow label={t('registration_voucher')}>
              {invoice.registration_journal_entry_id ? (
                <Link href={`/bookkeeping/${invoice.registration_journal_entry_id}`} className="hover:underline">
                  {t('view_voucher')}
                </Link>
              ) : canBookAfterwards ? (
                <span className="flex flex-wrap items-center gap-3">
                  <span className="text-muted-foreground">{t('not_booked_yet')}</span>
                  <Button
                    variant="outline"
                    className="-my-1"
                    onClick={handleBook}
                    disabled={isProcessing || !canWrite}
                    loading={processingAction === 'book'}
                    title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
                  >
                    {processingAction !== 'book' && !canWrite && <LockClosedIcon className="h-4 w-4" />}
                    {t('book_action')}
                  </Button>
                </span>
              ) : (
                <span className="text-muted-foreground">{t('no_registration_voucher')}</span>
              )}
            </DefRow>
            {invoice.payment_journal_entry_id && (
              <DefRow label={t('payment_voucher')}>
                <Link href={`/bookkeeping/${invoice.payment_journal_entry_id}`} className="hover:underline">
                  {t('view_voucher')}
                </Link>
              </DefRow>
            )}
            {invoice.document_id && (
              <DefRow label={t('document_title')}>
                <span className="text-muted-foreground">{t('document_attached')}</span>
              </DefRow>
            )}
          </DetailSection>
        </div>
      </div>

      {isBankDialogOpen && (
        <PayViaBankDialog
          open
          onOpenChange={(open) => {
            if (!open) setIsBankDialogOpen(false)
          }}
          invoiceIds={[invoice.id]}
          invoiceLabelById={new Map([[invoice.id, title]])}
          onDone={() => {
            setIsBankDialogOpen(false)
            void mutateLifecycle()
          }}
        />
      )}
      {isFileDialogOpen && (
        <PaymentFileDialog
          open
          onOpenChange={(open) => {
            if (!open) setIsFileDialogOpen(false)
          }}
          invoiceIds={[invoice.id]}
          invoiceLabelById={new Map([[invoice.id, title]])}
          onCreated={() => {
            setIsFileDialogOpen(false)
            void mutateLifecycle()
          }}
        />
      )}
      {isOcrDialogOpen && (
        <PaymentReferenceDialog
          invoiceId={invoice.id}
          current={invoice.payment_reference ?? null}
          onOpenChange={(open) => {
            if (!open) setIsOcrDialogOpen(false)
          }}
          onSaved={() => void fetchInvoice()}
        />
      )}
      <DestructiveConfirmDialog {...confirmDialogProps} />
      {accrualSchedules.replanDialog}

      <SupplierPaymentDialog
        invoice={invoice}
        open={isPayDialogOpen}
        onOpenChange={setIsPayDialogOpen}
        defaultPaymentAccount={companySettings?.last_supplier_payment_account}
        onPaid={async () => {
          await fetchInvoice()
        }}
      />
    </div>
  )
}
