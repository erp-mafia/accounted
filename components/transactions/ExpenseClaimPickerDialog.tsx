'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import { groupExpenseClaimsByPerson } from '@/lib/expenses/expense-payout-candidates'
import type { ExpensePayoutDue } from '@/lib/worklist/types'
import type { TransactionWithInvoice } from './transaction-types'

interface ClaimRow {
  id: string
  employee_id: string | null
  claimant_name: string
  liability_account: string
  amount_sek: number | string
  expense_date: string
  description: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  onMatched: (transactionId: string, journalEntryId: string, personKey: string) => void
}

/**
 * Manual "Matcha mot utlägg": for an outflow that the exact-amount suggestion
 * did not pair (two receipts of three were paid, or the amount covers a
 * subset), the user picks the person and the receipts the transfer covers.
 * The sum must equal the transfer to the öre: the same RPC as the one-click
 * path books it, so a partial receipt can never be marked paid.
 */
export default function ExpenseClaimPickerDialog({ open, onOpenChange, transaction, onMatched }: Props) {
  const t = useTranslations('tx_expense_claim_picker')
  const { toast } = useToast()
  const [claims, setClaims] = useState<ClaimRow[]>([])
  const [loading, setLoading] = useState(false)
  const [personKey, setPersonKey] = useState<string>('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)

  const transferOre = transaction ? Math.round(Math.abs(transaction.amount) * 100) : 0

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setSelected(new Set())
    fetch('/api/expense-claims?status=registered')
      .then((res) => (res.ok ? res.json() : { data: [] }))
      .then((json) => {
        if (cancelled) return
        const rows = ((json?.data ?? []) as ClaimRow[]).filter((r) => r.liability_account !== '2018')
        setClaims(rows)
        const people = groupExpenseClaimsByPerson(rows)
        // Preselect the person (and all their receipts) when one person's
        // total equals the transfer; otherwise the first person, nothing ticked.
        const exact = people.find((p) => Math.round(p.total_sek * 100) === transferOre)
        const first = exact ?? people[0]
        setPersonKey(first?.key ?? '')
        setSelected(new Set(exact ? exact.claim_ids : []))
      })
      .catch(() => {
        if (!cancelled) setClaims([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, transferOre])

  const people: ExpensePayoutDue[] = useMemo(() => groupExpenseClaimsByPerson(claims), [claims])
  const personClaims = useMemo(
    () =>
      claims
        .filter((c) => (c.employee_id ?? `owner:${c.claimant_name}`) === personKey)
        .sort((a, b) => a.expense_date.localeCompare(b.expense_date)),
    [claims, personKey],
  )
  const selectedOre = personClaims
    .filter((c) => selected.has(c.id))
    .reduce((sum, c) => sum + Math.round((Number(c.amount_sek) || 0) * 100), 0)
  const diff = roundOre((selectedOre - transferOre) / 100)
  const canConfirm = !submitting && !loading && selected.size > 0 && selectedOre === transferOre

  const toggle = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const handleConfirm = async () => {
    if (!transaction || !canConfirm) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/transactions/${transaction.id}/match-expense-payout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claim_ids: [...selected] }),
      })
      const result = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({
          title: t('failed_title'),
          description: getErrorMessage(result, { context: 'transaction', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      onMatched(transaction.id, result.journal_entry_id, personKey)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          </div>
        ) : people.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('no_claims')}</p>
        ) : (
          <div className="space-y-4">
            {people.length > 1 && (
              <div className="space-y-1.5">
                <Label>{t('person_label')}</Label>
                <Select
                  value={personKey}
                  onValueChange={(next) => {
                    setPersonKey(next)
                    setSelected(new Set())
                  }}
                >
                  <SelectTrigger className="h-9 text-[13px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {people.map((p) => (
                      <SelectItem key={p.key} value={p.key}>
                        {p.claimant_name} · {formatCurrency(p.total_sek)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="rounded-lg border border-border">
              {personClaims.map((c) => (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2.5 text-[13px] last:border-b-0 hover:bg-secondary/30"
                >
                  <Checkbox
                    checked={selected.has(c.id)}
                    onCheckedChange={(checked) => toggle(c.id, checked === true)}
                    disabled={submitting}
                  />
                  <span className="w-[86px] shrink-0 tabular-nums text-muted-foreground">{formatDate(c.expense_date)}</span>
                  <span className="min-w-0 flex-1 truncate">{c.description}</span>
                  <span className="shrink-0 tabular-nums">{formatCurrency(Number(c.amount_sek))}</span>
                </label>
              ))}
            </div>

            <div className="flex items-baseline justify-between text-xs text-muted-foreground tabular-nums">
              <span>{t('selected_sum', { amount: formatCurrency(selectedOre / 100) })}</span>
              <span>{t('transfer_sum', { amount: formatCurrency(transferOre / 100) })}</span>
            </div>
            {selected.size > 0 && diff !== 0 && (
              <p className="text-xs text-attn tabular-nums">{t('diff', { amount: formatCurrency(diff) })}</p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm}>
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
