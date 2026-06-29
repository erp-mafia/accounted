'use client'

import { useState, useEffect, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { ArrowLeft, CheckCircle, CreditCard, FileText, Trash2, Lock, Undo2, Info, Pencil, Plus, CalendarClock } from 'lucide-react'
import AgentSparkleButton from '@/components/agent/AgentSparkleButton'
import LinkVoucherPicker from '@/components/invoices/LinkVoucherPicker'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatDate, cn } from '@/lib/utils'
import Link from 'next/link'
import { AccountNumber } from '@/components/ui/account-number'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { formatCurrency } from '@/lib/utils'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import type { SupplierInvoice, SupplierInvoiceItem, SupplierInvoicePayment, BASAccount } from '@/types'

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

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// A line is periodiserad when both period dates are set — the cost was parked
// on the 17xx interim account and dissolves monthly via accrual_schedules.
const itemHasAccrual = (item: SupplierInvoiceItem): boolean =>
  !!(item.accrual_period_start && item.accrual_period_end)

const accrualMonth = (date: string): string => date.slice(0, 7)

const statusVariants: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  registered: 'secondary',
  approved: 'default',
  paid: 'success',
  partially_paid: 'warning',
  overdue: 'destructive',
  disputed: 'destructive',
  credited: 'secondary',
  reversed: 'secondary',
}

export default function SupplierInvoiceDetailPage() {
  const { canWrite } = useCanWrite()
  const params = useParams()
  const router = useRouter()
  const { toast } = useToast()
  const t = useTranslations('supplier_invoice_detail')
  const [invoice, setInvoice] = useState<SupplierInvoice | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isPayDialogOpen, setIsPayDialogOpen] = useState(false)
  const [payTab, setPayTab] = useState<'new' | 'existing'>('new')
  const [payAmount, setPayAmount] = useState('')
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().split('T')[0])
  const [paymentAccount, setPaymentAccount] = useState('1930')
  const [accounts, setAccounts] = useState<BASAccount[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [duplicateCandidates, setDuplicateCandidates] = useState<
    Array<{
      id: string
      date: string
      amount: number
      description: string | null
      merchant_name: string | null
    }> | null
  >(null)
  const [markPaidPreview, setMarkPaidPreview] = useState<MarkPaidPreview | null>(null)
  const [markPaidPreviewFailed, setMarkPaidPreviewFailed] = useState(false)
  const [isEditingLines, setIsEditingLines] = useState(false)
  const [editLines, setEditLines] = useState<EditableLine[]>([])
  const { dialogProps: confirmDialogProps, confirm: confirmAction } = useDestructiveConfirm()

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
    setIsLoading(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}`)
    const { data, error } = await res.json()
    if (error) {
      toast({ title: t('load_failed_title'), description: error, variant: 'destructive' })
    } else {
      setInvoice(data)
      setPayAmount(String(data.remaining_amount))
      setPaymentDate(new Date().toISOString().split('T')[0])
    }
    setIsLoading(false)
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
  // currently editing — otherwise typing in the inputs would clobber on
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

  // Load chart of accounts and remember the last picked payment account so the
  // dialog defaults to the user's previous choice instead of re-defaulting to
  // 1930 every time.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [accountsRes, settingsRes] = await Promise.all([
        fetch('/api/bookkeeping/accounts'),
        fetch('/api/settings'),
      ])
      if (cancelled) return
      if (accountsRes.ok) {
        const { data } = await accountsRes.json()
        if (Array.isArray(data)) setAccounts(data as BASAccount[])
      }
      if (settingsRes.ok) {
        const { data } = await settingsRes.json()
        const last = (data as { last_supplier_payment_account?: string | null } | null)?.last_supplier_payment_account
        if (last) setPaymentAccount(last)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleApprove() {
    setIsProcessing(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}/approve`, { method: 'POST' })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: t('approve_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
    } else {
      toast({ title: t('approved_title'), description: t('approved_description') })
      fetchInvoice()
    }
    setIsProcessing(false)
  }

  async function handleMarkPaid(force: boolean = false) {
    setIsProcessing(true)
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
        description: t('amount_registered_description', { amount: formatAmount(parseFloat(payAmount)) }),
      })
      setIsPayDialogOpen(false)
      setDuplicateCandidates(null)
      fetchInvoice()
    }
    setIsProcessing(false)
  }

  async function handleCredit() {
    const ok = await confirmAction({
      title: t('credit_confirm_title'),
      description: t('credit_confirm_description'),
      confirmLabel: t('credit_confirm_label'),
      variant: 'warning',
    })
    if (!ok) return
    setIsProcessing(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}/credit`, { method: 'POST' })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: t('credit_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
    } else {
      toast({ title: t('credit_success_title') })
      fetchInvoice()
    }
    setIsProcessing(false)
  }

  async function handleDelete() {
    const ok = await confirmAction({
      title: t('delete_confirm_title'),
      description: t('delete_confirm_description'),
      confirmLabel: t('delete_confirm_label'),
      variant: 'destructive',
    })
    if (!ok) return
    const res = await fetch(`/api/supplier-invoices/${params.id}`, { method: 'DELETE' })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: t('delete_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
    } else {
      toast({ title: t('deleted_title') })
      router.push('/supplier-invoices')
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
    setIsProcessing(true)
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
      fetchInvoice()
    }
    setIsProcessing(false)
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Card><CardContent className="p-6"><Skeleton className="h-48 w-full" /></CardContent></Card>
      </div>
    )
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

  // Display-only öresavrundning. The stored total/booked verifikat keep the
  // exact öre; this only adjusts the rendered total. Supplier invoices never
  // had rounding historically, so a null flag resolves to off (company arg
  // false) — only an explicit per-invoice `true` rounds the display.
  const rounding = getDisplayTotal(
    { total: invoice.total, currency: invoice.currency, ore_rounding: invoice.ore_rounding },
    { ore_rounding: false },
  )

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <Button variant="ghost" size="icon" className="shrink-0" onClick={() => router.push('/supplier-invoices')} aria-label={t('back_aria')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <h1 className="font-display text-2xl sm:text-3xl tracking-tight">
                {t('arrival_header', { number: invoice.arrival_number })}
              </h1>
              <Badge variant={statusVariants[invoice.status] || 'secondary'}>
                {statusLabels[invoice.status] || invoice.status}
              </Badge>
              {items.some(itemHasAccrual) && (
                <Badge variant="outline" className="gap-1">
                  <CalendarClock className="h-3 w-3" />
                  {t('badge_accrued')}
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground text-sm sm:text-base truncate">
              {t('header_subtitle', {
                supplier: invoice.supplier?.name ?? '',
                number: invoice.supplier_invoice_number,
              })}
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <AgentSparkleButton
            intentId="supplier_invoice.review"
            intentArgs={{ supplier_invoice_id: invoice.id }}
            contextRef={`supplier_invoice:${invoice.id}`}
            size="default"
          />
          {invoice.status === 'registered' && !invoice.is_credit_note && (
            <>
              <Button
                onClick={handleApprove}
                disabled={isProcessing || !canWrite}
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              >
                {canWrite ? <CheckCircle className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                {t('approve')}
              </Button>
              <Button
                variant="destructive"
                size="icon"
                onClick={handleDelete}
                disabled={isProcessing || !canWrite}
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
                aria-label={t('delete_confirm_label')}
              >
                {canWrite ? <Trash2 className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
              </Button>
            </>
          )}
          {['approved', 'overdue', 'partially_paid'].includes(invoice.status) && (
            <>
              <Button
                onClick={() => setIsPayDialogOpen(true)}
                disabled={isProcessing || !canWrite}
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              >
                {canWrite ? <CreditCard className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                {t('mark_paid')}
              </Button>
              {invoice.status !== 'partially_paid' && (
                <Button
                  variant="outline"
                  onClick={handleCredit}
                  disabled={isProcessing || !canWrite}
                  title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
                >
                  {canWrite ? <FileText className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                  {t('credit_note_button')}
                </Button>
              )}
            </>
          )}
          {invoice.status === 'credited' && !invoice.is_credit_note && (
            <Button
              variant="outline"
              onClick={handleUncredit}
              disabled={isProcessing || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {canWrite ? <Undo2 className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
              {t('uncredit_button')}
            </Button>
          )}
        </div>
      </div>

      {/* Credit note banner — explain why this row has no edit/delete affordances and where to undo */}
      {invoice.is_credit_note && (
        <div className="rounded-lg border bg-muted/40 p-4 flex gap-3 text-sm">
          <Info className="h-5 w-5 shrink-0 text-muted-foreground mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium">{t('credit_note_banner_title')}</p>
            <p className="text-muted-foreground">
              {t('credit_note_banner_prefix')}{' '}
              {(invoice as SupplierInvoice & { credited_original?: { id: string; supplier_invoice_number: string; arrival_number: number } }).credited_original ? (
                <Link
                  href={`/supplier-invoices/${(invoice as SupplierInvoice & { credited_original: { id: string; supplier_invoice_number: string; arrival_number: number } }).credited_original.id}`}
                  className="text-primary hover:underline font-medium"
                >
                  {t('credit_note_banner_link', { number: (invoice as SupplierInvoice & { credited_original: { id: string; supplier_invoice_number: string; arrival_number: number } }).credited_original.supplier_invoice_number })}
                </Link>
              ) : (
                <span>{t('credit_note_banner_original_fallback')}</span>
              )}
              {t('credit_note_banner_suffix')}
            </p>
          </div>
        </div>
      )}

      {/* Invoice details */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('invoice_info_title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('arrival_number_label')}</span>
              <span className="font-mono">{invoice.arrival_number}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('invoice_number_label')}</span>
              <span>{invoice.supplier_invoice_number}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('invoice_date_label')}</span>
              <span className="tabular-nums">{formatDate(invoice.invoice_date)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('due_date_label')}</span>
              <span className="tabular-nums">{formatDate(invoice.due_date)}</span>
            </div>
            {invoice.delivery_date && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('delivery_date_label')}</span>
                <span className="tabular-nums">{formatDate(invoice.delivery_date)}</span>
              </div>
            )}
            {invoice.payment_reference && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('ocr_reference_label')}</span>
                <span className="font-mono">{invoice.payment_reference}</span>
              </div>
            )}
            {invoice.reverse_charge && (
              <div className="mt-2">
                <Badge variant="warning">{t('reverse_charge_badge')}</Badge>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('amounts_title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('net_excl_vat')}</span>
              <span className="tabular-nums">{formatAmount(invoice.subtotal)} {invoice.currency}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('vat_label')}</span>
              <span className="tabular-nums">{formatAmount(invoice.vat_amount)} {invoice.currency}</span>
            </div>
            {rounding.applies && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('ore_rounding')}</span>
                <span className="tabular-nums">{formatAmount(rounding.roundingDelta)} {invoice.currency}</span>
              </div>
            )}
            <div className="flex justify-between font-semibold text-base pt-2 border-t">
              <span>{t('total_label')}</span>
              <span className="tabular-nums">{formatAmount(rounding.displayed)} {invoice.currency}</span>
            </div>
            <div className="flex justify-between pt-2">
              <span className="text-muted-foreground">{t('paid_label')}</span>
              <span className="tabular-nums text-success">{formatAmount(invoice.paid_amount)} {invoice.currency}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>{t('remaining_label')}</span>
              <span className="tabular-nums">{formatAmount(invoice.remaining_amount)} {invoice.currency}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Supplier info */}
      {invoice.supplier && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('supplier_section_title')}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <Link href={`/suppliers/${invoice.supplier.id}`} className="text-primary hover:underline font-medium">
              {invoice.supplier.name}
            </Link>
            <div className="text-muted-foreground mt-1">
              {invoice.supplier.org_number && <span>{t('org_number_inline', { number: invoice.supplier.org_number })}</span>}
              {invoice.supplier.email}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Line items */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('rows_title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Desktop table */}
          <div className="hidden sm:block">
            <table className="w-full text-sm">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="pb-2">{t('col_description')}</th>
                  <th className="pb-2 w-16 text-right">{t('col_quantity')}</th>
                  <th className="pb-2 w-16">{t('col_unit')}</th>
                  <th className="pb-2 w-28 text-right">{t('col_unit_price')}</th>
                  <th className="pb-2 w-20">{t('col_account')}</th>
                  <th className="pb-2 w-16 text-right">{t('col_vat_rate')}</th>
                  <th className="pb-2 w-28 text-right">{t('col_amount')}</th>
                  <th className="pb-2 w-24 text-right">{t('col_vat')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="py-2">
                      {item.description}
                      {itemHasAccrual(item) && (
                        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                          <CalendarClock className="h-3 w-3 shrink-0" />
                          <span className="tabular-nums">
                            {t('accrual_line_info', {
                              from: accrualMonth(item.accrual_period_start!),
                              to: accrualMonth(item.accrual_period_end!),
                            })}
                            {item.accrual_balance_account && ` · ${item.accrual_balance_account}`}
                          </span>
                        </p>
                      )}
                    </td>
                    <td className="py-2 text-right">{item.quantity}</td>
                    <td className="py-2">{item.unit}</td>
                    <td className="py-2 text-right tabular-nums">{formatAmount(item.unit_price)}</td>
                    <td className="py-2"><AccountNumber number={item.account_number} /></td>
                    <td className="py-2 text-right">{Math.round(item.vat_rate * 100)}%</td>
                    <td className="py-2 text-right tabular-nums">{formatAmount(item.line_total)}</td>
                    <td className="py-2 text-right tabular-nums">{formatAmount(item.vat_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobile cards */}
          <div className="sm:hidden space-y-3">
            {items.map((item) => (
              <div key={item.id} className="border rounded-lg p-3 space-y-1.5">
                <div className="font-medium text-sm">{item.description}</div>
                {itemHasAccrual(item) && (
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <CalendarClock className="h-3 w-3 shrink-0" />
                    <span className="tabular-nums">
                      {t('accrual_line_info', {
                        from: accrualMonth(item.accrual_period_start!),
                        to: accrualMonth(item.accrual_period_end!),
                      })}
                      {item.accrual_balance_account && ` · ${item.accrual_balance_account}`}
                    </span>
                  </p>
                )}
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>{item.quantity} {item.unit} × {formatAmount(item.unit_price)}</span>
                  <span className="tabular-nums">{formatAmount(item.line_total)} kr</span>
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span><AccountNumber number={item.account_number} /> · {t('vat_inline', { rate: Math.round(item.vat_rate * 100) })}</span>
                  <span className="tabular-nums">{t('vat_amount_inline', { amount: formatAmount(item.vat_amount) })}</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Payment history */}
      {payments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('payment_history_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Desktop table */}
            <div className="hidden sm:block">
              <table className="w-full text-sm">
                <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b text-left">
                    <th className="pb-2">{t('col_date')}</th>
                    <th className="pb-2 text-right">{t('col_amount_short')}</th>
                    <th className="pb-2">{t('col_voucher')}</th>
                    <th className="pb-2">{t('col_note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="py-2 tabular-nums">{formatDate(p.payment_date)}</td>
                      <td className="py-2 text-right tabular-nums">{formatAmount(p.amount)} {p.currency}</td>
                      <td className="py-2">
                        {p.journal_entry_id ? (
                          <Link href={`/bookkeeping/${p.journal_entry_id}`} className="text-primary hover:underline font-mono text-xs">
                            {p.journal_entry_id.substring(0, 8)}...
                          </Link>
                        ) : '-'}
                      </td>
                      <td className="py-2 text-muted-foreground">{p.notes || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <div className="sm:hidden space-y-3">
              {payments.map((p) => (
                <div key={p.id} className="border rounded-lg p-3 space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="tabular-nums">{formatDate(p.payment_date)}</span>
                    <span className="font-mono font-medium">{formatAmount(p.amount)} {p.currency}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    {p.journal_entry_id ? (
                      <Link href={`/bookkeeping/${p.journal_entry_id}`} className="text-primary hover:underline font-mono">
                        {p.journal_entry_id.substring(0, 8)}...
                      </Link>
                    ) : <span>-</span>}
                    <span>{p.notes || ''}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Journal entries (sambandskrav) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('vouchers_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {invoice.registration_journal_entry_id ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('registration_voucher')}</span>
              <Link
                href={`/bookkeeping/${invoice.registration_journal_entry_id}`}
                className="text-primary hover:underline font-mono"
              >
                {invoice.registration_journal_entry_id.substring(0, 8)}...
              </Link>
            </div>
          ) : (
            <p className="text-muted-foreground">{t('no_registration_voucher')}</p>
          )}
          {invoice.payment_journal_entry_id && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('payment_voucher')}</span>
              <Link
                href={`/bookkeeping/${invoice.payment_journal_entry_id}`}
                className="text-primary hover:underline font-mono"
              >
                {invoice.payment_journal_entry_id.substring(0, 8)}...
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Notes */}
      {invoice.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('notes_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{invoice.notes}</p>
          </CardContent>
        </Card>
      )}

      <DestructiveConfirmDialog {...confirmDialogProps} />

      {/* Pay Dialog */}
      <Dialog
        open={isPayDialogOpen}
        onOpenChange={(open) => {
          setIsPayDialogOpen(open)
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
                  <AccountCombobox
                    value={paymentAccount}
                    accounts={accounts}
                    onChange={setPaymentAccount}
                  />
                  <p className="text-xs text-muted-foreground">
                    T.ex. 1930 bankkonto, 1940 övrigt bankkonto, 2018 egna uttag (EF), 2893 ägarlån (AB).
                  </p>
                </div>

                {/* Bokföringspreview — visar exakt vad som kommer postas.
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
                            <div className="inline-flex rounded-md border bg-background overflow-hidden h-9">
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
              {duplicateCandidates?.length === 1
                ? t('duplicate_payment_description_one')
                : t('duplicate_payment_description_many')}
            </p>
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              {duplicateCandidates?.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium tabular-nums">{formatDate(c.date)}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {c.merchant_name || c.description || t('bank_transaction_fallback')}
                    </div>
                  </div>
                  <div className="tabular-nums font-medium">
                    {formatAmount(Math.abs(c.amount))} {invoice.currency}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => router.push(`/transactions?highlight=${c.id}`)}
                  >
                    {t('go_to')}
                  </Button>
                </div>
              ))}
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
