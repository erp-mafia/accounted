'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { useAccounts } from '@/lib/reference-data/hooks'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from '@/components/ui/badge'
import { DetailSection, DefRow, DefEmpty } from '@/components/ui/detail-section'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { HelpPopover } from '@/components/ui/help-popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { ArrowLeft, CheckCircle, CreditCard, FileText, Trash2, Lock, Undo2, Loader2, Pencil, Plus, CalendarClock, MoreHorizontal } from 'lucide-react'
import LinkVoucherPicker from '@/components/invoices/LinkVoucherPicker'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatDate, cn } from '@/lib/utils'
import Link from 'next/link'
import { AccountNumber } from '@/components/ui/account-number'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { DocumentViewButton } from '@/components/bookkeeping/DocumentViewButton'
import { useCompanySettings } from '@/components/settings/useSettings'
import { formatAmount, formatCurrency } from '@/lib/utils'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import { canApproveSupplierInvoice } from '@/lib/supplier-invoices/lifecycle'
import { DetailPager } from '@/components/common/DetailPager'
import { listContextKey } from '@/lib/navigation/list-context'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import type { SupplierInvoice, SupplierInvoiceItem, SupplierInvoicePayment } from '@/types'
import { DetailPageSkeleton } from '@/components/common/DetailPageSkeleton'

interface EditableLine {
  account_number: string
  side: 'debit' | 'credit'
  amount: string
  description: string
}

function parseAmount(s: string): number {
  const n = Number(s.replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

interface PreviewLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
}

interface MarkPaidPreview {
  entry_type: 'clearing' | 'cash'
  lines: PreviewLine[]
  invoice_already_booked: boolean
  accounting_method: 'accrual' | 'cash'
}

// A line is periodiserad when both period dates are set: the cost was parked
// on the 17xx interim account and dissolves monthly via accrual_schedules.
const itemHasAccrual = (item: SupplierInvoiceItem): boolean =>
  !!(item.accrual_period_start && item.accrual_period_end)

const accrualMonth = (date: string): string => date.slice(0, 7)

// Chips mark exceptions (design.md convention 5): approved and paid render as
// muted text in the header; these are the states that deviate and get a chip.
// Same variants as the list page so the two surfaces read the same.
const EXCEPTION_STATUS_VARIANTS: Record<string, 'secondary' | 'outline' | 'warning' | 'destructive'> = {
  registered: 'outline',
  partially_paid: 'warning',
  overdue: 'destructive',
  disputed: 'warning',
  credited: 'secondary',
  reversed: 'secondary',
}

export default function SupplierInvoiceDetailPage() {
  const { canWrite } = useCanWrite()
  const { settings: companySettings } = useCompanySettings()
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
  const [payTab, setPayTab] = useState<'new' | 'existing'>('new')
  const [payAmount, setPayAmount] = useState('')
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().split('T')[0])
  const [paymentAccount, setPaymentAccount] = useState('1930')
  // Chart of accounts for the payment dialog, from the session cache
  // (lib/reference-data): one request per session at most, shared with
  // every other picker, instead of a deferred fetch per detail page.
  const { accounts, isLoading: areAccountsLoading } = useAccounts()
  // Which action is in flight, not just whether one is: the acting button
  // shows the spinner while the others only disable. A single boolean put
  // identical pending feedback (none) on every button at once.
  const [processingAction, setProcessingAction] = useState<
    'approve' | 'book' | 'mark_paid' | 'credit' | 'uncredit' | 'delete' | null
  >(null)
  const isProcessing = processingAction !== null
  const [duplicateCandidates, setDuplicateCandidates] = useState<
    Array<{
      id: string
      date: string
      amount: number
      description: string | null
      merchant_name: string | null
      /** `already_booked`: the row is already a verifikat; the remedy is a rättelse, not a link. */
      match_reason?: string
      journal_entry_id?: string | null
    }> | null
  >(null)
  const [markPaidPreview, setMarkPaidPreview] = useState<MarkPaidPreview | null>(null)
  const [markPaidPreviewFailed, setMarkPaidPreviewFailed] = useState(false)
  const [isEditingLines, setIsEditingLines] = useState(false)
  const [editLines, setEditLines] = useState<EditableLine[]>([])
  const { dialogProps: confirmDialogProps, confirm: confirmAction } = useDestructiveConfirm()

  // Latest-request guard for fetchInvoice. A mutation refetch can overlap the
  // pager stepping to a sibling invoice (the component stays mounted, only
  // params.id changes), and without it the older response would commit
  // invoice A's row and payment-form defaults under invoice B's URL. Only the
  // newest request may write state.
  const fetchSeqRef = useRef(0)

  const statusLabels = useMemo<Record<string, string>>(() => ({
    registered: t('status_registered'),
    approved: t('status_approved'),
    paid: t('status_paid'),
    partially_paid: t('status_partially_paid'),
    overdue: t('status_overdue'),
    disputed: t('status_disputed'),
    credited: t('status_credited'),
    reversed: t('status_reversed'),
  }), [t])

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
        setPayAmount(String(body.data.remaining_amount))
        setPaymentDate(new Date().toISOString().split('T')[0])
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

  // When the dialog closes, drop any in-progress edits so reopening starts
  // from the server's default booking again.
  useEffect(() => {
    if (!isPayDialogOpen) {
      setIsEditingLines(false)
      setEditLines([])
    }
  }, [isPayDialogOpen])

  // Mirror the preview into the editable working copy. Only resets when not
  // currently editing: otherwise typing in the inputs would clobber on
  // every keystroke since the preview refetches on input change.
  useEffect(() => {
    if (!isEditingLines && markPaidPreview) {
      setEditLines(
        markPaidPreview.lines.map((l) => {
          const isDebit = l.debit_amount > 0
          return {
            account_number: l.account_number,
            side: isDebit ? 'debit' : 'credit',
            amount: String(isDebit ? l.debit_amount : l.credit_amount),
            description: l.description,
          }
        }),
      )
    }
  }, [markPaidPreview, isEditingLines])

  const editValidation = useMemo(() => {
    if (!isEditingLines) return { isBalanced: true, isValid: true, diff: 0, totalDebit: 0, totalCredit: 0, accountInvalid: false }
    const totalDebit = round2(editLines.filter((l) => l.side === 'debit').reduce((s, l) => s + parseAmount(l.amount), 0))
    const totalCredit = round2(editLines.filter((l) => l.side === 'credit').reduce((s, l) => s + parseAmount(l.amount), 0))
    const isBalanced = totalDebit === totalCredit && totalDebit > 0
    const accountInvalid = editLines.some((l) => !/^\d{4}$/.test(l.account_number.trim()))
    return {
      isBalanced,
      accountInvalid,
      isValid: isBalanced && !accountInvalid,
      diff: round2(totalDebit - totalCredit),
      totalDebit,
      totalCredit,
    }
  }, [isEditingLines, editLines])

  const updateEditLine = (i: number, patch: Partial<EditableLine>) =>
    setEditLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  const removeEditLine = (i: number) =>
    setEditLines((prev) => prev.filter((_, idx) => idx !== i))
  const addEditLine = () =>
    setEditLines((prev) => [...prev, { account_number: '', side: 'debit', amount: '', description: '' }])
  const resetEditLines = () => {
    if (!markPaidPreview) return
    setEditLines(
      markPaidPreview.lines.map((l) => {
        const isDebit = l.debit_amount > 0
        return {
          account_number: l.account_number,
          side: isDebit ? 'debit' : 'credit',
          amount: String(isDebit ? l.debit_amount : l.credit_amount),
          description: l.description,
        }
      }),
    )
  }

  // Load a preview of the JE that mark-paid would post. Refetches when the
  // user changes amount or payment account so the displayed Debet/Kredit
  // lines always reflect the current dialog inputs.
  useEffect(() => {
    if (!isPayDialogOpen || !invoice) {
      setMarkPaidPreview(null)
      setMarkPaidPreviewFailed(false)
      return
    }
    const amountNum = Number(payAmount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setMarkPaidPreview(null)
      return
    }
    let cancelled = false
    const ctrl = new AbortController()
    ;(async () => {
      setMarkPaidPreviewFailed(false)
      try {
        const qs = new URLSearchParams({
          amount: String(amountNum),
          payment_account: paymentAccount,
        })
        const res = await fetch(
          `/api/supplier-invoices/${invoice.id}/mark-paid/preview?${qs.toString()}`,
          { signal: ctrl.signal },
        )
        if (!res.ok) {
          if (!cancelled) setMarkPaidPreviewFailed(true)
          return
        }
        const data = (await res.json()) as MarkPaidPreview
        if (!cancelled) setMarkPaidPreview(data)
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
        if (!cancelled) setMarkPaidPreviewFailed(true)
      }
    })()
    return () => {
      cancelled = true
      ctrl.abort()
    }
  }, [isPayDialogOpen, invoice, payAmount, paymentAccount])

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

  async function handleMarkPaid(force: boolean = false) {
    setProcessingAction('mark_paid')
    // When the user has edited the booking rows in this session, forward
    // them so the server validates balance and posts via createJournalEntry
    // directly. Otherwise the server picks the default routing (clearing
    // or cash) based on the SI's booking state.
    const linesPayload =
      isEditingLines && editValidation.isValid
        ? editLines.map((l) => {
            const amount = round2(parseAmount(l.amount))
            return {
              account_number: l.account_number.trim(),
              debit_amount: l.side === 'debit' ? amount : 0,
              credit_amount: l.side === 'credit' ? amount : 0,
              line_description: l.description?.trim() || undefined,
            }
          })
        : undefined

    try {
      const res = await fetch(`/api/supplier-invoices/${params.id}/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: parseFloat(payAmount),
          payment_date: paymentDate,
          payment_account: paymentAccount,
          ...(force ? { force: true } : {}),
          ...(linesPayload ? { lines: linesPayload } : {}),
        }),
      })
      const result = await res.json()
      if (!res.ok) {
        if (result?.error?.code === 'SI_PAID_LIKELY_DUPLICATE' && Array.isArray(result.error.details?.candidates)) {
          setDuplicateCandidates(result.error.details.candidates)
          setIsPayDialogOpen(false)
        } else {
          toast({ title: t('payment_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
        }
      } else {
        toast({
          title: result.status === 'paid' ? t('paid_title') : t('partial_payment_title'),
          // The paid amount is in the invoice's currency (the dialog's helper
          // text says so): the toast must not relabel it as kr.
          description: t('amount_registered_description', {
            amount: formatCurrency(parseFloat(payAmount), invoice?.currency || 'SEK'),
          }),
        })
        setIsPayDialogOpen(false)
        setDuplicateCandidates(null)
        await fetchInvoice()
      }
    } catch (err) {
      toast({ title: t('payment_failed_title'), description: getErrorMessage(err, { context: 'supplier_invoice' }), variant: 'destructive' })
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

  const items = (invoice.items || []) as SupplierInvoiceItem[]
  const payments = (invoice.payments || []) as SupplierInvoicePayment[]
  const creditedOriginal =
    (invoice as SupplierInvoice & {
      credited_original?: { id: string; supplier_invoice_number: string; arrival_number: number } | null
    }).credited_original ?? null

  // Display-only öresavrundning. The stored total/booked verifikat keep the
  // exact öre; this only adjusts the rendered total. Supplier invoices never
  // had rounding historically, so a null flag resolves to off (company arg
  // false); only an explicit per-invoice `true` rounds the display.
  const rounding = getDisplayTotal(
    { total: invoice.total, currency: invoice.currency, ore_rounding: invoice.ore_rounding },
    { ore_rounding: false },
  )

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

  // One status element, same rule as the list page (chips mark exceptions):
  // approved and paid render as muted text, everything that deviates (waiting
  // for attest, overdue, partly paid, credited, ...) gets a chip.
  const status: { label: string; exception: boolean; variant?: 'secondary' | 'outline' | 'warning' | 'destructive' } =
    invoice.status === 'paid'
      ? {
          label: invoice.paid_at
            ? tList('status_paid_date', { date: formatDate(invoice.paid_at) })
            : statusLabels.paid,
          exception: false,
        }
      : invoice.status === 'approved'
        ? { label: statusLabels.approved, exception: false }
        : {
            label: statusLabels[invoice.status] || invoice.status,
            exception: true,
            variant: EXCEPTION_STATUS_VARIANTS[invoice.status] || 'secondary',
          }

  const metaParts = [
    invoice.supplier?.name ?? null,
    docNumber ? t('arrival_header', { number: invoice.arrival_number }) : null,
    t('created_at', { date: formatDate(invoice.created_at) }),
  ].filter(Boolean)

  // Attest keys off approved_at, not the status: the overdue cron flips
  // unbooked invoices to 'overdue' just by aging, and gating on 'registered'
  // alone left them with no way through attest (#1206).
  const canApprove = canApproveSupplierInvoice(invoice) && !invoice.is_credit_note
  const canMarkPaid = ['approved', 'overdue', 'partially_paid'].includes(invoice.status)
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
      {/* Back link + prev/next record pager on their own quiet row, so the
          title below keeps a stable position while stepping between records */}
      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => router.push('/supplier-invoices')}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          aria-label={t('back_aria')}
        >
          <ArrowLeft className="h-4 w-4" />
          {tCommon('back')}
        </button>
        <DetailPager
          contextKey={listContextKey('supplier-invoices', company?.id)}
          basePath="/supplier-invoices"
          currentId={String(params.id)}
          className="shrink-0"
        />
      </div>

      {/* Header: serif title with one status element, a quiet meta line, and
          the next step on the right. Everything else lives in the ⋯ menu. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            {/* data-ph-mask: the title carries the supplier's invoice number */}
            <h1 data-ph-mask="" className="font-display text-2xl leading-8 tracking-tight">{title}</h1>
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
          <p className="mt-1 text-sm text-muted-foreground">{metaParts.join(' · ')}</p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {/* The supplier's own document, reviewed in the browser (#1190). */}
          {invoice.document_id && (
            <DocumentViewButton
              documentId={invoice.document_id}
              label={t('view_document')}
              className="text-[13px]"
            />
          )}
          {canApprove && (
            <Button
              onClick={handleApprove}
              disabled={isProcessing || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {processingAction === 'approve' ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : canWrite ? (
                <CheckCircle className="mr-2 h-4 w-4" />
              ) : (
                <Lock className="mr-2 h-4 w-4" />
              )}
              {t('approve')}
            </Button>
          )}
          {/* Attest gates payment: while attest is still pending, Markera
              betald steps back to a secondary so the header keeps one next
              step (an aged-but-unattested invoice can have both). */}
          {canMarkPaid && (
            <Button
              variant={canApprove ? 'outline' : 'default'}
              onClick={() => setIsPayDialogOpen(true)}
              disabled={isProcessing || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {canWrite ? <CreditCard className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
              {t('mark_paid')}
            </Button>
          )}
          {canUncredit && (
            <Button
              variant="outline"
              onClick={handleUncredit}
              disabled={isProcessing || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {processingAction === 'uncredit' ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : canWrite ? (
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
                <Button variant="ghost" size="icon" aria-label={tCommon('more_options')}>
                  {processingAction === 'credit' || processingAction === 'delete' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
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

      {/* Leverantör and Fakturainformation side by side like an invoice head:
          who sent it on the left, the facts on the right. */}
      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-2">
        {invoice.supplier && (
          <DetailSection kicker={t('supplier_section_title')}>
            <DefRow label={t('def_name')}>
              <Link href={`/suppliers/${invoice.supplier.id}`} className="hover:underline">
                {invoice.supplier.name}
              </Link>
            </DefRow>
            {invoice.supplier.org_number && (
              <DefRow label={t('def_org_number')}>
                <span className="tabular-nums">{invoice.supplier.org_number}</span>
              </DefRow>
            )}
            <DefRow label={t('def_email')}>
              {invoice.supplier.email ? (
                <a href={`mailto:${invoice.supplier.email}`} className="hover:underline">
                  {invoice.supplier.email}
                </a>
              ) : (
                <DefEmpty />
              )}
            </DefRow>
          </DetailSection>
        )}

        <DetailSection
          kicker={t('invoice_info_title')}
          // A credit note carries no edit/delete affordances of its own; the
          // way to undo it lives on the original, explained behind the "?".
          help={invoice.is_credit_note ? <HelpPopover>{t('credit_note_help')}</HelpPopover> : undefined}
        >
          <DefRow label={t('arrival_number_label')}>
            <span className="tabular-nums">{invoice.arrival_number}</span>
          </DefRow>
          <DefRow label={t('invoice_number_label')}>
            {invoice.supplier_invoice_number || <DefEmpty />}
          </DefRow>
          <DefRow label={t('invoice_date_label')}>
            <span className="tabular-nums">{formatDate(invoice.invoice_date)}</span>
          </DefRow>
          <DefRow label={t('due_date_label')}>
            <span className="tabular-nums">{formatDate(invoice.due_date)}</span>
          </DefRow>
          {invoice.delivery_date && (
            <DefRow label={t('delivery_date_label')}>
              <span className="tabular-nums">{formatDate(invoice.delivery_date)}</span>
            </DefRow>
          )}
          {invoice.payment_reference && (
            <DefRow label={t('ocr_reference_label')}>
              <span className="tabular-nums">{invoice.payment_reference}</span>
            </DefRow>
          )}
          {invoice.reverse_charge && (
            <DefRow label={t('vat_label')}>{t('reverse_charge_badge')}</DefRow>
          )}
          {/* The invoice a credit note cancels, as a row, not a banner. */}
          {invoice.is_credit_note && (
            <DefRow label={t('def_credits')}>
              {creditedOriginal ? (
                <Link href={`/supplier-invoices/${creditedOriginal.id}`} className="hover:underline">
                  {creditedOriginal.supplier_invoice_number
                    ? t('title_invoice', { number: creditedOriginal.supplier_invoice_number })
                    : t('arrival_header', { number: creditedOriginal.arrival_number })}
                </Link>
              ) : (
                <span className="text-muted-foreground">{t('credit_note_banner_original_fallback')}</span>
              )}
            </DefRow>
          )}
        </DetailSection>
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
                <td className={TD_CLASS}><AccountNumber number={item.account_number} /></td>
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
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              >
                {processingAction === 'book' ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : !canWrite ? (
                  <Lock className="mr-2 h-4 w-4" />
                ) : null}
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

      <DestructiveConfirmDialog {...confirmDialogProps} />

      {/* Pay Dialog */}
      <Dialog
        open={isPayDialogOpen}
        onOpenChange={(open) => {
          setIsPayDialogOpen(open)
          if (open && companySettings?.last_supplier_payment_account) {
            setPaymentAccount(companySettings.last_supplier_payment_account)
          }
          if (!open) setPayTab('new')
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('pay_dialog_title')}</DialogTitle>
          </DialogHeader>
          <Tabs value={payTab} onValueChange={(v) => setPayTab(v as 'new' | 'existing')}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="new">{t('tab_new_payment')}</TabsTrigger>
              <TabsTrigger value="existing">{t('tab_existing_voucher')}</TabsTrigger>
            </TabsList>
            <TabsContent value="new" className="mt-4">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="payment-date">{t('payment_date_label')}</Label>
                  <Input
                    id="payment-date"
                    type="date"
                    value={paymentDate}
                    max={new Date().toISOString().split('T')[0]}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    className="w-full sm:w-48"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="payment-amount">{t('payment_amount_label')}</Label>
                  <Input
                    id="payment-amount"
                    type="number"
                    step="0.01"
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('remaining_to_pay', { amount: formatAmount(invoice.remaining_amount), currency: invoice.currency })}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="payment-account">Betalkonto</Label>
                  {areAccountsLoading ? (
                    <Skeleton className="h-10 w-full" />
                  ) : (
                    <AccountCombobox
                      value={paymentAccount}
                      accounts={accounts}
                      onChange={setPaymentAccount}
                    />
                  )}
                  <p className="text-xs text-muted-foreground">
                    T.ex. 1930 bankkonto, 1940 övrigt bankkonto, 2018 egna uttag (EF), 2893 ägarlån (AB).
                  </p>
                </div>

                {/* Bokföringspreview: visar exakt vad som kommer postas.
                    Redigerbar via "Redigera"-knappen så användaren kan välja
                    andra konton eller flytta belopp mellan debet/kredit. */}
                {(markPaidPreview || markPaidPreviewFailed) && (
                  <div className="rounded-lg border p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">Bokföring</p>
                      {markPaidPreview && (
                        <div className="flex gap-2">
                          {isEditingLines && (
                            <Button variant="ghost" size="sm" onClick={resetEditLines} disabled={isProcessing}>
                              Återställ
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setIsEditingLines((v) => !v)}
                            disabled={isProcessing}
                          >
                            {isEditingLines ? 'Klart' : (
                              <>
                                <Pencil className="h-3 w-3 mr-1" />
                                Redigera
                              </>
                            )}
                          </Button>
                        </div>
                      )}
                    </div>

                    {markPaidPreviewFailed && !markPaidPreview && (
                      <p className="text-sm text-muted-foreground">
                        Kunde inte förhandsgranska bokföringen. Fortsätt eller avbryt.
                      </p>
                    )}

                    {markPaidPreview && !isEditingLines && (
                      <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 gap-y-1 text-sm tabular-nums">
                        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Konto</div>
                        <div />
                        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground text-right">Debet</div>
                        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground text-right">Kredit</div>
                        {markPaidPreview.lines.map((line, i) => (
                          <div key={i} className="contents">
                            <div className="font-medium">{line.account_number}</div>
                            <div className="text-muted-foreground truncate">{line.description}</div>
                            <div className="text-right">
                              {line.debit_amount > 0 ? formatCurrency(line.debit_amount, invoice.currency) : ''}
                            </div>
                            <div className="text-right">
                              {line.credit_amount > 0 ? formatCurrency(line.credit_amount, invoice.currency) : ''}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {markPaidPreview && isEditingLines && (
                      <div className="space-y-2">
                        {editLines.map((line, i) => (
                          <div
                            key={i}
                            className="grid grid-cols-[minmax(180px,1.6fr)_minmax(0,1fr)_140px_110px_28px] gap-2 items-center"
                          >
                            <AccountCombobox
                              value={line.account_number}
                              accounts={accounts}
                              onChange={(acc) => updateEditLine(i, { account_number: acc })}
                            />
                            <Input
                              value={line.description}
                              onChange={(e) => updateEditLine(i, { description: e.target.value })}
                              placeholder="Beskrivning"
                            />
                            <div className="inline-flex rounded-lg border bg-background overflow-hidden h-9">
                              <button
                                type="button"
                                onClick={() => updateEditLine(i, { side: 'debit' })}
                                className={cn(
                                  'flex-1 px-2 text-xs font-medium transition-colors',
                                  line.side === 'debit' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/60',
                                )}
                                aria-pressed={line.side === 'debit'}
                              >
                                Debet
                              </button>
                              <button
                                type="button"
                                onClick={() => updateEditLine(i, { side: 'credit' })}
                                className={cn(
                                  'flex-1 px-2 text-xs font-medium border-l transition-colors',
                                  line.side === 'credit' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/60',
                                )}
                                aria-pressed={line.side === 'credit'}
                              >
                                Kredit
                              </button>
                            </div>
                            <Input
                              inputMode="decimal"
                              value={line.amount}
                              onChange={(e) => updateEditLine(i, { amount: e.target.value })}
                              className="text-right tabular-nums"
                              placeholder="0"
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => removeEditLine(i)}
                              disabled={editLines.length <= 2}
                              aria-label="Ta bort rad"
                              className="h-8 w-8"
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        ))}

                        <div className="flex items-center justify-between pt-1">
                          <Button variant="ghost" size="sm" onClick={addEditLine}>
                            <Plus className="h-3 w-3 mr-1" />
                            Lägg till rad
                          </Button>
                          <div className="text-xs tabular-nums text-muted-foreground">
                            Debet {formatCurrency(editValidation.totalDebit, invoice.currency)}
                            {' / '}
                            Kredit {formatCurrency(editValidation.totalCredit, invoice.currency)}
                          </div>
                        </div>

                        {!editValidation.isBalanced && (
                          <p className="text-xs text-destructive">
                            Debet och kredit måste vara lika och större än noll. Differens:{' '}
                            {formatCurrency(Math.abs(editValidation.diff), invoice.currency)}
                          </p>
                        )}
                        {editValidation.accountInvalid && (
                          <p className="text-xs text-destructive">Kontonummer måste vara 4 siffror.</p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setIsPayDialogOpen(false)}>
                    {t('cancel')}
                  </Button>
                  <Button
                    onClick={() => handleMarkPaid(false)}
                    disabled={isProcessing || (isEditingLines && !editValidation.isValid)}
                  >
                    {isProcessing ? t('processing') : t('register_payment')}
                  </Button>
                </div>
              </div>
            </TabsContent>
            <TabsContent value="existing" className="mt-4">
              <LinkVoucherPicker
                mode="supplier_invoice"
                invoiceId={invoice.id}
                invoiceCurrency={invoice.currency}
                onLinked={() => {
                  setIsPayDialogOpen(false)
                  setPayTab('new')
                  fetchInvoice()
                }}
                onCancel={() => setPayTab('new')}
              />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Duplicate-payment warning dialog */}
      <Dialog
        open={duplicateCandidates !== null}
        onOpenChange={(open) => {
          if (!open) setDuplicateCandidates(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('duplicate_payment_title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {duplicateCandidates?.every((c) => c.match_reason === 'already_booked')
                ? t('duplicate_payment_already_booked_description')
                : duplicateCandidates?.length === 1
                  ? t('duplicate_payment_description_one')
                  : t('duplicate_payment_description_many')}
            </p>
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
              {duplicateCandidates?.map((c) => {
                // A row that is already a verifikat: "link it" is the wrong
                // remedy (the money would be booked twice), so point at the
                // existing voucher instead of the transaction list.
                const alreadyBooked = c.match_reason === 'already_booked' && !!c.journal_entry_id
                return (
                  <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium tabular-nums">{formatDate(c.date)}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {c.merchant_name || c.description || t('bank_transaction_fallback')}
                      </div>
                      {alreadyBooked && (
                        <div className="text-xs text-muted-foreground">
                          {t('duplicate_payment_already_booked_hint')}
                        </div>
                      )}
                    </div>
                    <div className="tabular-nums font-medium">
                      {formatCurrency(Math.abs(c.amount), invoice.currency)}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        router.push(
                          alreadyBooked
                            ? `/bookkeeping/${c.journal_entry_id}`
                            : `/transactions?highlight=${c.id}`,
                        )
                      }
                    >
                      {alreadyBooked ? t('duplicate_payment_show_voucher') : t('go_to')}
                    </Button>
                  </div>
                )
              })}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setDuplicateCandidates(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="outline"
                onClick={() => handleMarkPaid(true)}
                disabled={isProcessing}
              >
                {isProcessing ? t('processing') : t('create_voucher_anyway')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
