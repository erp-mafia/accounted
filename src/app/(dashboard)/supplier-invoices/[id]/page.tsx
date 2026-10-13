'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { useAccounts } from '@/lib/reference-data/hooks'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { DetailSection, DefRow } from '@/components/ui/detail-section'
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
import { CheckCircle, CreditCard, FileText, Trash2, Lock, Undo2, CalendarClock, MoreHorizontal, Landmark } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatDate, cn } from '@/lib/utils'
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
import { AccountChip } from '@/components/ui/account-chip'
import { CategoryPopover } from '@/components/transactions/CategoryPopover'
import TemplatePicker from '@/components/transactions/TemplatePicker'
import { DocumentViewButton } from '@/components/bookkeeping/DocumentViewButton'
import { useCompanySettings } from '@/components/settings/useSettings'
import useSWR from 'swr'
import { StageSteps } from '@/components/supplier-invoices/StageSteps'
import { stagesFor, type InvoiceLifecycle, type SupplierInvoiceLadderStage } from '@/lib/supplier-invoices/stages'
import { formatCurrency } from '@/lib/utils'
import { supplierInvoiceDisplayFigures } from '@/lib/supplier-invoices/display-figures'
import {
  canApproveSupplierInvoice,
  canMarkSupplierInvoiceBankEntered,
  companyAttestsSupplierInvoices,
  isUnsettledSupplierInvoiceStatus,
} from '@/lib/supplier-invoices/lifecycle'
import { DetailPager } from '@/components/common/DetailPager'
import { SupplierPaymentDialog } from '@/components/supplier-invoices/SupplierPaymentDialog'
import { listContextKey } from '@/lib/navigation/list-context'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import type { SupplierInvoice, SupplierInvoiceItem, SupplierInvoicePayment } from '@/types'
import { DetailPageSkeleton } from '@/components/common/DetailPageSkeleton'
import type { BASAccount, EntityType } from '@/types'

// A line is periodiserad when both period dates are set: the cost was parked
// on the 17xx interim account and dissolves monthly via accrual_schedules.
const itemHasAccrual = (item: SupplierInvoiceItem): boolean =>
  !!(item.accrual_period_start && item.accrual_period_end)

const accrualMonth = (date: string): string => date.slice(0, 7)

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
        className="-mx-1 rounded-full px-1 transition-colors duration-150 hover:bg-secondary/60"
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
          <div className="border-t border-border bg-background px-3 py-2">
            <AccountCombobox value={manual} accounts={accounts} onChange={setManual} onCommit={pick} />
          </div>
        </CategoryPopover>
      )}
    </>
  )
}

export default function SupplierInvoiceDetailPage() {
  const { canWrite } = useCanWrite()
  const { settings: companySettings } = useCompanySettings()
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
  const params = useParams()
  const router = useRouter()
  const company = useCompanyOptional()?.company ?? null
  const { toast } = useToast()
  const t = useTranslations('supplier_invoice_detail')
  const tCommon = useTranslations('common')
  // The list page's "Betald {date}" label, so the header reads like the row.
  const tList = useTranslations('supplier_invoices')
  const [invoice, setInvoice] = useState<SupplierInvoice | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isPayDialogOpen, setIsPayDialogOpen] = useState(false)
  // Chart of accounts for the row account cells, from the session cache
  // (lib/reference-data): one request per session at most, shared with
  // every other picker, instead of a deferred fetch per detail page.
  const { accounts } = useAccounts()
  // Which action is in flight, not just whether one is: the acting button
  // shows the spinner while the others only disable. A single boolean put
  // identical pending feedback (none) on every button at once.
  const [processingAction, setProcessingAction] = useState<
    'approve' | 'book' | 'bank_entered' | 'credit' | 'uncredit' | 'delete' | null
  >(null)
  const isProcessing = processingAction !== null
  const [isFileDialogOpen, setIsFileDialogOpen] = useState(false)
  const [isBankDialogOpen, setIsBankDialogOpen] = useState(false)
  // Betala via banken is offered where bank payments are switched on for the
  // company (GET /api/payments/availability), beside the payment file.
  const [bankPaymentsAvailable, setBankPaymentsAvailable] = useState(false)
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

  async function fetchInvoice() {
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
      if (seq !== fetchSeqRef.current) return
      // See the identical fix in suppliers/[id]: `body.error` is the canonical
      // envelope object, and rendering an object as a toast description throws
      // out of the root layout into global-error.
      if (!res.ok || body?.error || !body?.data) {
        toast({
          title: t('load_failed_title'),
          description: getErrorMessage(body, { statusCode: res.status, context: 'supplier_invoice' }),
          variant: 'destructive',
        })
      } else {
        setInvoice(body.data)
      }
    } catch (err) {
      if (seq !== fetchSeqRef.current) return
      toast({
        title: t('load_failed_title'),
        description: getErrorMessage(err, { context: 'supplier_invoice' }),
        variant: 'destructive',
      })
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
        toast({ title: t('approved_title'), description: t('approved_description') })
        // Awaited: the Attestera button keeps its spinner until the page shows
        // the approved state (the refetch runs behind the mounted content).
        await fetchInvoice()
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

  // #967: deferred booking: create the registration verifikat afterwards.
  async function handleBook() {
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
    const ok = await confirmAction({
      title: t('credit_confirm_title'),
      description: t('credit_confirm_description'),
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

  if (isLoading) {
    return <DetailPageSkeleton cards={3} />
  }

  if (!invoice) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">{t('not_found')}</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push('/supplier-invoices')}>
          {t('back')}
        </Button>
      </div>
    )
  }

  // Not while the payment dialog is open: its booking rows are the ones in play.
  const lineAccountEditable = canWrite && isUnsettledSupplierInvoiceStatus(invoice.status) && !isPayDialogOpen
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
  const title = !docNumber
    ? t('arrival_header', { number: invoice.arrival_number })
    : invoice.is_credit_note
      ? t('title_credit_note', { number: docNumber })
      : t('title_invoice', { number: docNumber })

  // One status element, the same as the list row and the supplier page
  // (lib/supplier-invoices/status-display.ts): approved and paid render as
  // muted text, everything that deviates gets a chip.
  const statusDisplay = supplierInvoiceStatusDisplay(invoice.status)
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

  const metaParts = [
    invoice.supplier?.name ?? null,
    docNumber ? t('arrival_header', { number: invoice.arrival_number }) : null,
    t('created_at', { date: formatDate(invoice.created_at) }),
    // The mellanlage (#2220) reads as a dated fact here, next to the bock.
    invoice.bank_entered_at
      ? t('bank_entered_meta', { date: formatDate(invoice.bank_entered_at) })
      : null,
  ].filter(Boolean)

  // Attest keys off approved_at, not the status: the overdue cron flips
  // unbooked invoices to 'overdue' just by aging, and gating on 'registered'
  // alone left them with no way through attest (#1206).
  // Kontantmetod companies never attest: the debt is not booked before payment.
  // The same rule keeps them out of the Att göra attest count (crm#1156).
  const canApprove =
    canApproveSupplierInvoice(invoice) &&
    !invoice.is_credit_note &&
    companyAttestsSupplierInvoices(companySettings?.accounting_method)
  const stripText = (s: SupplierInvoiceLadderStage, state: 'done' | 'now' | 'todo'): string => {
    if (state === 'todo') return t(`strip_pending_${s}`)
    switch (s) {
      case 'incoming':
        return t('strip_incoming', { date: formatDate(invoice.created_at) })
      case 'registered':
        return invoice.registration_journal_entry_id
          ? t('strip_registered', { date: formatDate(invoice.created_at) })
          : t('strip_registered_unbooked', { date: formatDate(invoice.created_at) })
      case 'approved':
        return invoice.approved_at ? t('strip_approved', { date: formatDate(invoice.approved_at) }) : t('strip_skipped')
      case 'in_file':
        // Same step, two kinds of evidence: a payment file or a bank payment.
        return lifecycle?.payment_order
          ? t('strip_in_bank_payment', { date: formatDate(lifecycle.payment_order.created_at) })
          : t('strip_in_file', { date: lifecycle?.batch ? formatDate(lifecycle.batch.created_at) : '' })
      case 'paid':
        return t('strip_paid', {
          date: invoice.paid_at ? formatDate(invoice.paid_at) : lifecycle?.paid ? formatDate(lifecycle.paid.date) : '',
        })
      case 'reconciled':
        return t('strip_reconciled', { date: lifecycle?.reconciled_through ? formatDate(lifecycle.reconciled_through) : '' })
    }
  }
  const canMarkPaid = ['approved', 'overdue', 'partially_paid'].includes(invoice.status)
  // After attest the next step is the betalfil to the bank, so that is the
  // header's one primary while the invoice is attested and in no open file.
  // Markera betald stays for the person who paid by hand, as a secondary.
  const canAddToFile =
    !invoice.is_credit_note &&
    ['approved', 'overdue'].includes(invoice.status) &&
    !!invoice.approved_at &&
    !lifecycle?.batch &&
    !lifecycle?.payment_order
  // With bank payments on, Betala via banken is the primary and the betalfil
  // steps back to a secondary (same order as the list's bulk bar).
  const canPayViaBank = canAddToFile && bankPaymentsAvailable
  // "Inlagd i banken" (#2220) sits on the same rows as Markera som betald:
  // it is the step right before it. Viewers see the bock only when it is set.
  const showBankEntered =
    canMarkSupplierInvoiceBankEntered(invoice) && (canWrite || !!invoice.bank_entered_at)
  const canCredit = canMarkPaid && invoice.status !== 'partially_paid'
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
  // #967: registered-without-booking (deferred booking). Ekonomi books the
  // registration verifikat from here.
  const canBookAfterwards =
    companySettings?.accounting_method === 'accrual' &&
    !invoice.is_credit_note &&
    ['registered', 'approved', 'overdue'].includes(invoice.status)

  const accrualInfo = (item: SupplierInvoiceItem) =>
    itemHasAccrual(item) ? (
      <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
        <CalendarClock className="h-3 w-3 shrink-0" />
        {t('accrual_line_info', {
          from: accrualMonth(item.accrual_period_start!),
          to: accrualMonth(item.accrual_period_end!),
        })}
        {item.accrual_balance_account && ` · ${item.accrual_balance_account}`}
      </span>
    ) : null

  return (
    <div className="space-y-8 stagger-enter">
      {/* Header: serif title with one status element, a quiet meta line, and
          the next step on the right. Everything else lives in the ⋯ menu.
          The sidebar says where we are, so there is no back link; the
          prev/next pager sits in the bar. */}
      <div className="page-header flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="page-header-lead min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            {/* data-ph-mask: the title carries the supplier's invoice number */}
            <h1 data-ph-mask="" className="page-header-title font-display text-2xl leading-8 tracking-tight">{title}</h1>
            {status.exception ? (
              <Badge variant={status.variant}>{status.label}</Badge>
            ) : (
              <span className="text-sm text-muted-foreground">{status.label}</span>
            )}
            {items.some(itemHasAccrual) && (
              <Badge variant="outline" className="gap-1">
                <CalendarClock className="h-3 w-3" />
                {t('badge_accrued')}
              </Badge>
            )}
          </div>
          <p className="page-header-desc mt-1 text-sm text-muted-foreground">{metaParts.join(' · ')}</p>
        </div>

        <div className="page-header-action flex shrink-0 flex-wrap items-center gap-2">
          <DetailPager
            contextKey={listContextKey('supplier-invoices', company?.id)}
            basePath="/supplier-invoices"
            currentId={String(params.id)}
            className="shrink-0"
          />
          {/* The supplier's own document, reviewed in the browser (#1190). */}
          {invoice.document_id && (
            <DocumentViewButton
              documentId={invoice.document_id}
              label={t('view_document')}
              className="text-[13px]"
            />
          )}
          {canApprove && (
            <Button size="sm"
              onClick={handleApprove}
              disabled={isProcessing || !canWrite}
              loading={processingAction === 'approve'}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {processingAction === 'approve' ? null : canWrite ? (
                <CheckCircle className="mr-2 h-4 w-4" />
              ) : (
                <Lock className="mr-2 h-4 w-4" />
              )}
              {t('approve')}
            </Button>
          )}
          {canPayViaBank && (
            <Button size="sm" onClick={() => setIsBankDialogOpen(true)} disabled={isProcessing || !canWrite} title={!canWrite ? t('viewer_disabled_tooltip') : undefined}>
              {canWrite ? <Landmark className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
              {tList('bulk_pay_via_bank')}
            </Button>
          )}
          {canAddToFile && (
            <Button size="sm" variant={canPayViaBank ? 'outline' : 'default'} onClick={() => setIsFileDialogOpen(true)} disabled={isProcessing || !canWrite} title={!canWrite ? t('viewer_disabled_tooltip') : undefined}>
              {canWrite ? <FileText className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
              {t('add_to_payment_file')}
            </Button>
          )}
          {/* Attest gates payment: while attest is still pending, Markera
              betald steps back to a secondary so the header keeps one next
              step (an aged-but-unattested invoice can have both). */}
          {canMarkPaid && (
            <Button size="sm"
              variant={canApprove || canAddToFile ? 'outline' : 'default'}
              onClick={() => setIsPayDialogOpen(true)}
              disabled={isProcessing || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {canWrite ? <CreditCard className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
              {t('mark_paid')}
            </Button>
          )}
          {canUncredit && (
            <Button size="sm"
              variant="outline"
              onClick={handleUncredit}
              disabled={isProcessing || !canWrite}
              loading={processingAction === 'uncredit'}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {processingAction === 'uncredit' ? null : canWrite ? (
                <Undo2 className="mr-2 h-4 w-4" />
              ) : (
                <Lock className="mr-2 h-4 w-4" />
              )}
              {t('uncredit_button')}
            </Button>
          )}

          {hasMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={tCommon('more_options')}
                  loading={processingAction === 'credit' || processingAction === 'delete'}
                >
                  {processingAction !== 'credit' && processingAction !== 'delete' && (
                    <MoreHorizontal className="h-4 w-4" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[240px]">
                {canCredit && (
                  <DropdownMenuItem onSelect={() => void handleCredit()} disabled={isProcessing || !canWrite}>
                    <FileText className="h-4 w-4" />
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
                      <Trash2 className="h-4 w-4" />
                      {t('delete_confirm_label')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {lifecycle && (
        <StageSteps
          stages={stagesFor(companySettings?.accounting_method)}
          current={lifecycle.stage}
          detail={stripText}
        />
      )}

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
        {invoice.payment_reference && (
          <span>
            {t('ocr_reference_label')} <span className="tabular-nums text-foreground">{invoice.payment_reference}</span>
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

      {/* Invoice lines: the list-page table idiom straight on the panel, with
          the totals as a right-aligned block and the total in the serif. */}
      <DetailSection kicker={t('rows_title')}>
        <table className="hidden w-full border-collapse text-[13px] md:table">
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
                  {formatCurrency(item.unit_price, invoice.currency)}
                </td>
                <td className={TD_CLASS}>
                  <InlineAccountCell item={item} editable={lineAccountEditable} entityType={(company?.entity_type ?? 'aktiebolag') as EntityType} accounts={accounts} label={t('line_account_edit')} onCommit={changeLineAccount} />
                </td>
                <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{Math.round(item.vat_rate * 100)}%</td>
                <td className={cn(TD_CLASS, 'text-right tabular-nums')}>
                  {formatCurrency(item.line_total, invoice.currency)}
                </td>
                <td className={cn(TD_CLASS, 'pr-0 text-right tabular-nums')}>
                  {formatCurrency(item.vat_amount, invoice.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

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
          <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
            <span>{t('total_label')}</span>
            <span className="font-display text-xl">{formatCurrency(rounding.displayed, invoice.currency)}</span>
          </div>
        </div>
      </DetailSection>

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
        {/* The bock (#2220): "I have entered this payment in the bank". A
            labelled checkbox rather than a button, because it is a fact the
            user records, not an action that posts anything. */}
        {showBankEntered && !lifecycle?.batch && (
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
                size="sm"
                variant="outline"
                className="-my-1"
                onClick={handleBook}
                disabled={isProcessing || !canWrite}
                loading={processingAction === 'book'}
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              >
                {processingAction !== 'book' && !canWrite && <Lock className="mr-2 h-4 w-4" />}
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

      {invoice.notes && (
        <DetailSection kicker={t('notes_title')}>
          <p className="py-2 text-sm text-muted-foreground whitespace-pre-wrap">{invoice.notes}</p>
        </DetailSection>
      )}

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
      <DestructiveConfirmDialog {...confirmDialogProps} />

      <SupplierPaymentDialog
        invoice={invoice}
        open={isPayDialogOpen}
        onOpenChange={setIsPayDialogOpen}
        defaultPaymentAccount={companySettings?.last_supplier_payment_account}
        onPaid={fetchInvoice}
      />
    </div>
  )
}
