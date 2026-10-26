'use client'

import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { parseVoucherNumber, voucherNumberMatches } from '@/lib/invoices/voucher-label'
import { formatAmountInput, roundOre } from '@/lib/money'
import { formatCurrency, formatDate } from '@/lib/utils'
import { MagnifyingGlassIcon } from '@/components/icons'
import {
  canChooseAmount,
  checkLinkAmount,
  defaultLinkAmount,
  leavesPartOfVoucher,
  linkRequestBody,
  voucherLeft,
  voucherTotal,
} from './link-voucher-amount'

interface VoucherCandidate {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
  // Customer side returns ar_credit_amount; supplier side returns ap_debit_amount.
  // The picker treats them interchangeably: same UX, opposite sign convention.
  // Either is what the voucher has LEFT after the invoices already linked to it.
  ar_credit_amount?: number
  ap_debit_amount?: number
  currency: string
  ar_line_currency?: string | null
  ap_line_currency?: string | null
  period_locked: boolean
  confidence: number
  match_reason: string
  /** The voucher has more left than the invoice needs (it settles several
   *  invoices or debts): the invoice's remainder, the share proposed. */
  link_amount?: number
  /** What payment rows for other invoices already use of the voucher. */
  already_linked?: number
  /** SEK-booked fallback: the link settles the whole remainder, no share. */
  whole_remainder?: true
}

/**
 * Linking mode determines which API surface the picker hits and which side
 * of the BAS chart the candidates are searched against (151x credits vs 2440
 * debits). The user-facing UX is identical; only the data path differs.
 */
export type VoucherPickerMode = 'customer_invoice' | 'supplier_invoice'

interface LinkVoucherPickerProps {
  invoiceId: string
  invoiceCurrency: string
  onLinked: () => void
  onCancel: () => void
  /** Defaults to 'customer_invoice' for back-compat with existing call sites. */
  mode?: VoucherPickerMode
  /**
   * Company accounting method. On 'cash' (kontantmetoden) the matcher searches
   * bank/cash debits (19xx) instead of AR credits (1510), so the intro + empty
   * copy switch to describe that. Defaults to 'accrual'. Only affects the
   * customer-invoice mode's wording: the data path is decided server-side.
   */
  accountingMethod?: 'accrual' | 'cash'
}

function voucherLabel(c: VoucherCandidate): string {
  return c.voucher_number ? formatVoucher(c) : c.journal_entry_id.slice(0, 8)
}

function confidenceBadge(confidence: number): {
  variant: 'muted' | 'secondary' | 'outline'
  key: 'high' | 'medium' | 'low'
} {
  if (confidence >= 0.9) return { variant: 'muted', key: 'high' }
  if (confidence >= 0.7) return { variant: 'secondary', key: 'medium' }
  return { variant: 'outline', key: 'low' }
}

export default function LinkVoucherPicker({
  invoiceId,
  invoiceCurrency,
  onLinked,
  onCancel,
  mode = 'customer_invoice',
  accountingMethod = 'accrual',
}: LinkVoucherPickerProps) {
  const { toast } = useToast()
  const t = useTranslations('invoice_link_voucher')

  // Supplier mode links against an AP debit (2440) or, for a kontantmetod
  // invoice that was never booked at registration, a bank/cash credit (19xx);
  // the customer mode against a bank/cash debit (19xx) on kontantmetoden and an
  // AR credit (1510) otherwise. The intro + empty copy must describe the right
  // side, otherwise the empty state tells the user to look for a verifikat
  // that can never match (support case 2026-07-26: supplier dialog spoke of
  // kundfordran/1510; issue #2854: it told a kontantmetod user to register a
  // new payment, which books the cost twice).
  //
  // The supplier side is NOT derived here: the candidates response says which
  // side the server searched (supplier_invoice_settlement_side), and the copy
  // follows it. Until it arrives the intro describes nothing side-specific.
  const isSupplier = mode === 'supplier_invoice'
  const isCash = mode === 'customer_invoice' && accountingMethod === 'cash'
  const [supplierSide, setSupplierSide] = useState<'ap_debit' | 'bank_credit' | null>(null)
  const introKey = isSupplier
    ? supplierSide === 'bank_credit'
      ? 'intro_supplier_cash'
      : supplierSide === 'ap_debit'
        ? 'intro_supplier'
        : 'intro_supplier_pending'
    : isCash
      ? 'intro_cash'
      : 'intro'
  const emptyDescriptionKey = isSupplier
    ? supplierSide === 'bank_credit'
      ? 'empty_description_supplier_cash'
      : 'empty_description_supplier'
    : isCash
      ? 'empty_description_cash'
      : 'empty_description'

  const apiBase =
    mode === 'supplier_invoice'
      ? `/api/supplier-invoices/${invoiceId}`
      : `/api/invoices/${invoiceId}`
  const errorContext: 'invoice' | 'supplier_invoice' =
    mode === 'supplier_invoice' ? 'supplier_invoice' : 'invoice'

  const [candidates, setCandidates] = useState<VoucherCandidate[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [amountText, setAmountText] = useState('')
  const [search, setSearch] = useState('')
  // A voucher named by its number that the suggestions do not hold: the
  // suggestions only search around the due date, and a konstaterad kundförlust
  // or a late payment is often booked long after it (crm#1434). The server
  // looks the number up at any date.
  const [lookup, setLookup] = useState<{ key: string; candidates: VoucherCandidate[] } | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const response = await fetch(`${apiBase}/voucher-candidates`)
        if (!response.ok) {
          if (cancelled) return
          setCandidates([])
          return
        }
        const body = await response.json()
        if (cancelled) return
        const side = body?.data?.settlement_side
        setSupplierSide(side === 'bank_credit' || side === 'ap_debit' ? side : 'ap_debit')
        setCandidates(body?.data?.candidates ?? [])
      } catch {
        if (!cancelled) setCandidates([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [apiBase])

  const wanted = useMemo(() => parseVoucherNumber(search), [search])
  const lookupKey = wanted ? (wanted.series ? `${wanted.series}-${wanted.number}` : String(wanted.number)) : null
  const suggestionsHoldWanted =
    wanted !== null && (candidates ?? []).some((c) => voucherNumberMatches(wanted, c.voucher_series, c.voucher_number))
  const needsLookup = lookupKey !== null && !loading && !suggestionsHoldWanted
  const lookupPending = needsLookup && lookup?.key !== lookupKey

  useEffect(() => {
    if (!needsLookup || !lookupKey || lookup?.key === lookupKey) return
    let cancelled = false
    const timer = setTimeout(async () => {
      let found: VoucherCandidate[] = []
      try {
        const response = await fetch(`${apiBase}/voucher-candidates?voucher=${encodeURIComponent(lookupKey)}`)
        if (response.ok) {
          const body = await response.json()
          found = body?.data?.candidates ?? []
        }
      } catch {
        found = []
      }
      if (!cancelled) setLookup({ key: lookupKey, candidates: found })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [apiBase, needsLookup, lookupKey, lookup?.key])

  const filtered = useMemo(() => {
    if (!candidates) return [] as VoucherCandidate[]
    const needle = search.trim().toLowerCase()
    const matches = !needle
      ? candidates
      : candidates.filter((c) => {
          const label = voucherLabel(c).toLowerCase()
          const desc = c.description?.toLowerCase() ?? ''
          return (
            label.includes(needle) ||
            desc.includes(needle) ||
            (wanted !== null && voucherNumberMatches(wanted, c.voucher_series, c.voucher_number))
          )
        })
    const looked = lookup && lookup.key === lookupKey ? lookup.candidates : []
    const extra = looked.filter((c) => !matches.some((m) => m.journal_entry_id === c.journal_entry_id))
    return [...matches, ...extra]
  }, [candidates, search, wanted, lookup, lookupKey])

  const selected = useMemo(
    () => (selectedId ? filtered.find((c) => c.journal_entry_id === selectedId) ?? null : null),
    [filtered, selectedId],
  )
  const amountCheck = selected ? checkLinkAmount(selected, amountText) : null

  const select = (c: VoucherCandidate) => {
    setSelectedId(c.journal_entry_id)
    setAmountText(formatAmountInput(defaultLinkAmount(c)))
  }

  const handleConfirm = async () => {
    if (!selected || !amountCheck?.ok) return
    setSubmitting(true)
    try {
      const response = await fetch(`${apiBase}/link-to-voucher`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A voucher that settles several invoices is linked with this
        // invoice's share; without it the server refuses rather than split on
        // a guess. A link of all the voucher has left reads as it always did.
        body: JSON.stringify(linkRequestBody(selected, amountCheck.amount)),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        toast({
          title: t('link_failed_title'),
          description: getErrorMessage(body, {
            context: errorContext,
            statusCode: response.status,
          }),
          variant: 'destructive',
        })
        return
      }
      const body = await response.json().catch(() => null)
      const reconciledTxId = body?.data?.reconciled_transaction_id ?? null
      toast({
        title: t('link_success_title'),
        description: reconciledTxId ? t('link_success_tx_reconciled') : undefined,
        variant: 'success',
      })
      onLinked()
    } catch (err) {
      toast({
        title: t('link_failed_title'),
        description: getErrorMessage(err, { context: errorContext }),
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t(introKey)}</p>

      <div className="relative">
        <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('search_placeholder')}
          className="pl-9"
        />
      </div>

      {loading || (lookupPending && filtered.length === 0) ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center">
          <p className="text-sm font-medium">{t('empty_title')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t(emptyDescriptionKey)}</p>
          {wanted === null && (
            <p className="mt-2 text-xs text-muted-foreground">{t('empty_search_hint')}</p>
          )}
        </div>
      ) : (
        <ul className="space-y-2 max-h-[320px] overflow-y-auto">
          {filtered.map((c) => {
            const badge = confidenceBadge(c.confidence)
            const isSelected = selectedId === c.journal_entry_id
            return (
              <li key={c.journal_entry_id}>
                <button
                  type="button"
                  onClick={() => select(c)}
                  className={`w-full rounded-lg border bg-card p-3 text-left transition-colors hover:bg-secondary/60 ${
                    isSelected ? 'border-foreground' : 'border-border'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium tabular-nums">
                          {voucherLabel(c)}
                        </span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {formatDate(c.entry_date)}
                        </span>
                        {badge.variant === 'muted' ? (
                          <span className="text-xs text-muted-foreground">{t(`confidence_${badge.key}`)}</span>
                        ) : (
                          <Badge variant={badge.variant}>{t(`confidence_${badge.key}`)}</Badge>
                        )}
                        {c.period_locked && (
                          <Badge variant="outline">{t('period_locked')}</Badge>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {c.match_reason || c.description}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-medium tabular-nums">
                        {formatCurrency(voucherLeft(c), invoiceCurrency)}
                      </p>
                      {(c.already_linked ?? 0) > 0 && (
                        <p className="text-xs tabular-nums text-muted-foreground">
                          {t('left_of_total', { total: formatCurrency(voucherTotal(c), invoiceCurrency) })}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {selected && (
        <div className="space-y-3 rounded-lg border bg-secondary/40 p-3">
          {canChooseAmount(selected) && (
            <div className="space-y-1.5">
              <Label htmlFor="link-voucher-amount">{t('amount_label')}</Label>
              <Input
                id="link-voucher-amount"
                inputMode="decimal"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                aria-invalid={amountCheck?.ok === false}
                className="w-full sm:w-48 text-right tabular-nums"
              />
              {amountCheck && !amountCheck.ok ? (
                <p className="text-xs text-destructive">
                  {t(`amount_${amountCheck.reason}`, { max: formatCurrency(amountCheck.max, invoiceCurrency) })}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t('amount_help', { max: formatCurrency(defaultLinkAmount(selected), invoiceCurrency) })}
                </p>
              )}
            </div>
          )}
          {amountCheck?.ok && (
            <p className="text-sm">
              {leavesPartOfVoucher(selected, amountCheck.amount)
                ? t('confirmation_part', {
                    voucher: voucherLabel(selected),
                    amount: formatCurrency(amountCheck.amount, invoiceCurrency),
                    left: formatCurrency(roundOre(voucherLeft(selected) - amountCheck.amount), invoiceCurrency),
                  })
                : t('confirmation', {
                    voucher: voucherLabel(selected),
                    amount: formatCurrency(amountCheck.amount, invoiceCurrency),
                  })}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{t('no_new_je_note')}</p>
        </div>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          {t('cancel')}
        </Button>
        <Button
          onClick={handleConfirm}
          disabled={!selected || !amountCheck?.ok}
          loading={submitting}
        >
          {t('confirm')}
        </Button>
      </div>
    </div>
  )
}
