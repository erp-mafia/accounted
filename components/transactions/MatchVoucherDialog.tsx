'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  MatchVerifikationPicker,
  type UnlinkedGLLine,
} from '@/components/reconciliation/MatchVerifikationPicker'
import { formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useToast } from '@/components/ui/use-toast'
import { ArrowUpRight, ArrowDownRight, Loader2 } from 'lucide-react'
import type { TransactionWithInvoice } from './transaction-types'
import type { CashAccount } from '@/types'
import { resolveAccount } from '@/lib/cash-accounts/resolve-account'

interface MatchVoucherDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  /** Called after a successful link. voucherLabel is the picked verifikat's label (e.g. "A-42"). */
  onLinked: (transactionId: string, journalEntryId: string, voucherLabel: string) => void
}

// ±30 days around the transaction date: wide enough to catch a salary or
// supplier voucher booked a few days off the bank value date, narrow enough to
// keep the candidate list short. "Visa alla" drops the window entirely.
const WINDOW_DAYS = 30

function shiftDate(isoDate: string, deltaDays: number): string {
  const d = new Date(isoDate)
  if (Number.isNaN(d.getTime())) return isoDate
  d.setDate(d.getDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

export function MatchVoucherDialog({
  open,
  onOpenChange,
  transaction,
  onLinked,
}: MatchVoucherDialogProps) {
  const { toast } = useToast()
  const [glLines, setGlLines] = useState<UnlinkedGLLine[]>([])
  const [selected, setSelected] = useState('')
  const [accountNumber, setAccountNumber] = useState('1930')
  const [accountFallback, setAccountFallback] = useState(false)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [wideRange, setWideRange] = useState(false)
  // Opt-in: also surface vouchers already matched to another bank transaction,
  // so several transactions can settle one verifikat (N:1: a salary run paid in
  // multiple transfers, an invoice paid in instalments).
  const [includeMatched, setIncludeMatched] = useState(false)

  const loadCandidates = useCallback(
    async (tx: TransactionWithInvoice, wide: boolean, matched: boolean, signal: { cancelled: boolean }) => {
      setLoading(true)
      try {
        // Resolve the settlement account from the company's cash accounts.
        let account = '1930'
        let fallback = true
        try {
          const caRes = await fetch('/api/cash-accounts')
          if (caRes.ok) {
            const caJson = await caRes.json()
            if (!signal.cancelled) {
              const accounts = (caJson.data ?? []) as CashAccount[]
              const resolved = resolveAccount(accounts, tx.cash_account_id ?? null, tx.currency ?? 'SEK')
              account = resolved.account
              fallback = resolved.fallback
            }
          }
        } catch {
          // Network hiccup: fall back to 1930 and let the user see the note.
        }
        if (!signal.cancelled) {
          setAccountNumber(account)
          setAccountFallback(fallback)
        }

        const params = new URLSearchParams()
        params.set('account_number', account)
        params.set('transaction_id', tx.id)
        if (matched) params.set('include_matched', 'true')
        if (!wide) {
          params.set('date_from', shiftDate(tx.date, -WINDOW_DAYS))
          params.set('date_to', shiftDate(tx.date, WINDOW_DAYS))
        }

        const res = await fetch(`/api/reconciliation/bank/unmatched-entries?${params}`)
        const json = await res.json()
        if (signal.cancelled) return
        const lines = (json.data ?? []) as UnlinkedGLLine[]
        setGlLines(lines)
        // Pre-select a strong auto-match (exact/reference/date-range) so the
        // common case is one click. Fuzzy (<0.85) is left for the user to confirm.
        // Auto-select a strong match only when nothing is chosen yet. Toggling
        // "Visa alla datum" reloads with a wider set: it must NOT discard a
        // voucher the user already picked. (selected resets to '' on close.)
        // Never auto-select an already-matched voucher: N:1 must be a
        // deliberate choice, not the default when "visa matchade" is on.
        const top = lines[0]
        setSelected((prev) =>
          prev
            ? prev
            : top && (top.confidence ?? 0) >= 0.85 && !(top.linked_transaction_count ?? 0)
              ? top.journal_entry_id
              : '',
        )
      } finally {
        if (!signal.cancelled) setLoading(false)
      }
    },
    [],
  )

  // (Re)load whenever the dialog opens for a transaction, the range widens, or
  // the user toggles already-matched vouchers in/out.
  useEffect(() => {
    if (!open || !transaction) return
    const signal = { cancelled: false }
    void loadCandidates(transaction, wideRange, includeMatched, signal)
    return () => { signal.cancelled = true }
  }, [open, transaction, wideRange, includeMatched, loadCandidates])

  // Reset transient state when the dialog closes so the next open starts clean.
  useEffect(() => {
    if (open) return
    setGlLines([])
    setSelected('')
    setWideRange(false)
    setIncludeMatched(false)
    setAccountFallback(false)
  }, [open])

  if (!transaction) return null

  const isIncome = transaction.amount > 0
  const selectedLine = glLines.find((l) => l.journal_entry_id === selected) ?? null

  async function handleConfirm() {
    if (!transaction || !selected) return
    setSubmitting(true)
    try {
      const res = await fetch('/api/reconciliation/bank/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction_id: transaction.id,
          journal_entry_id: selected,
          account_number: accountNumber,
        }),
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        toast({
          title: 'Kunde inte matcha',
          description: getErrorMessage(result, { context: 'transaction', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      const label = selectedLine ? formatVoucher(selectedLine) : ''
      onLinked(transaction.id, selected, label)
    } catch {
      toast({
        title: 'Kunde inte koppla',
        description: 'Ett fel uppstod. Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Matcha mot befintlig verifikation</DialogTitle>
          <DialogDescription>
            Koppla bankhändelsen till en verifikation som redan är bokförd (t.ex. en
            lön eller en post importerad från Fortnox). Ingen ny bokföring skapas.
          </DialogDescription>
        </DialogHeader>

        {/* Transaction summary */}
        <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-2.5 text-sm">
          <span
            className={isIncome ? 'text-success' : 'text-foreground/60'}
            aria-hidden
          >
            {isIncome ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{transaction.description}</p>
            <p className="text-xs text-muted-foreground tabular-nums">{formatDate(transaction.date)}</p>
          </div>
          <span className={`font-medium tabular-nums ${isIncome ? 'text-success' : ''}`}>
            {isIncome ? '+' : ''}
            {formatCurrency(transaction.amount, transaction.currency)}
          </span>
        </div>

        {accountFallback && (
          <p className="text-xs text-muted-foreground">
            Avstämning mot 1930. Hör transaktionen till ett annat bankkonto? Stäm av
            det under Rapporter → Bankavstämning.
          </p>
        )}

        {/* Candidate picker */}
        <div className="space-y-2">
          {loading ? (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-border py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Söker verifikationer…
            </div>
          ) : glLines.length === 0 ? (
            <div className="rounded-lg border border-border px-3 py-6 text-center text-sm text-muted-foreground">
              <p>
                {includeMatched
                  ? `Inga verifikationer på ${accountNumber} i perioden.`
                  : `Inga omatchade verifikationer på ${accountNumber} i perioden.`}
              </p>
            </div>
          ) : (
            <>
              <MatchVerifikationPicker glLines={glLines} value={selected} onChange={setSelected} inline />
              {(selectedLine?.linked_transaction_count ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground">
                  Verifikationen är redan matchad mot {selectedLine?.linked_transaction_count}{' '}
                  transaktion{(selectedLine?.linked_transaction_count ?? 0) === 1 ? '' : 'er'}.
                  Kopplingen lägger till den här transaktionen också: t.ex. en lön utbetald i
                  flera överföringar.
                </p>
              )}
            </>
          )}

          {/* Discovery affordances: widen the date window, and surface vouchers
              already matched so another transaction can be attached (N:1). */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-1">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={includeMatched}
                onCheckedChange={setIncludeMatched}
                aria-label="Visa även matchade verifikationer"
              />
              Visa även matchade verifikationer
            </label>
            {!wideRange && (
              <button
                type="button"
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={() => setWideRange(true)}
              >
                Visa alla datum
              </button>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Avbryt
          </Button>
          <Button onClick={handleConfirm} disabled={!selected || submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Matchar…
              </>
            ) : (
              'Matcha'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
