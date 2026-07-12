'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Loader2, Search } from 'lucide-react'

interface VoucherCandidate {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
  // Customer side returns ar_credit_amount; supplier side returns ap_debit_amount.
  // The picker treats them interchangeably: same UX, opposite sign convention.
  ar_credit_amount?: number
  ap_debit_amount?: number
  currency: string
  ar_line_currency?: string | null
  ap_line_currency?: string | null
  period_locked: boolean
  confidence: number
  match_reason: string
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

function candidateAmount(c: VoucherCandidate): number {
  return c.ar_credit_amount ?? c.ap_debit_amount ?? 0
}

function voucherLabel(c: VoucherCandidate): string {
  if (c.voucher_series && c.voucher_number != null) {
    return `${c.voucher_series}-${c.voucher_number}`
  }
  if (c.voucher_number != null) return String(c.voucher_number)
  return c.journal_entry_id.slice(0, 8)
}

function confidenceBadge(confidence: number): {
  variant: 'success' | 'secondary' | 'outline'
  key: 'high' | 'medium' | 'low'
} {
  if (confidence >= 0.9) return { variant: 'success', key: 'high' }
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

  // Kontantmetoden links against a bank/cash debit (19xx), not an AR credit:
  // describe that. Only the customer-invoice copy varies by method.
  const isCash = mode === 'customer_invoice' && accountingMethod === 'cash'
  const introKey = isCash ? 'intro_cash' : 'intro'
  const emptyDescriptionKey = isCash ? 'empty_description_cash' : 'empty_description'

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
  const [search, setSearch] = useState('')

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

  const filtered = useMemo(() => {
    if (!candidates) return [] as VoucherCandidate[]
    if (!search.trim()) return candidates
    const needle = search.trim().toLowerCase()
    return candidates.filter((c) => {
      const label = voucherLabel(c).toLowerCase()
      const desc = c.description?.toLowerCase() ?? ''
      return label.includes(needle) || desc.includes(needle)
    })
  }, [candidates, search])

  const selected = useMemo(
    () => (selectedId ? filtered.find((c) => c.journal_entry_id === selectedId) ?? null : null),
    [filtered, selectedId],
  )

  const handleConfirm = async () => {
    if (!selected) return
    setSubmitting(true)
    try {
      const response = await fetch(`${apiBase}/link-to-voucher`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journal_entry_id: selected.journal_entry_id }),
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
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('search_placeholder')}
          className="pl-9"
        />
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center">
          <p className="text-sm font-medium">{t('empty_title')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t(emptyDescriptionKey)}</p>
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
                  onClick={() => setSelectedId(c.journal_entry_id)}
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
                        <Badge variant={badge.variant}>{t(`confidence_${badge.key}`)}</Badge>
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
                        {formatCurrency(candidateAmount(c), invoiceCurrency)}
                      </p>
                    </div>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {selected && (
        <div className="rounded-lg border bg-secondary/40 p-3">
          <p className="text-sm">
            {t('confirmation', {
              voucher: voucherLabel(selected),
              amount: formatCurrency(candidateAmount(selected), invoiceCurrency),
            })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t('no_new_je_note')}</p>
        </div>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onCancel} disabled={submitting} className="min-h-11">
          {t('cancel')}
        </Button>
        <Button
          onClick={handleConfirm}
          disabled={!selected || submitting}
          className="min-h-11"
        >
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('confirm')}
        </Button>
      </div>
    </div>
  )
}
