'use client'

import { useCallback, useEffect, useState } from 'react'
import { useCashAccounts } from '@/lib/reference-data/hooks'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import {
  MatchVerifikationPicker,
  type UnlinkedGLLine,
} from '@/components/reconciliation/MatchVerifikationPicker'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { buildSplitSelection, proposeSplitSelection } from '@/lib/reconciliation/split-selection'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useToast } from '@/components/ui/use-toast'
import { ArrowUpRight, ArrowDownRight, Loader2 } from 'lucide-react'
import type { TransactionWithInvoice } from './transaction-types'
import { resolveAccount } from '@/lib/cash-accounts/resolve-account'

interface MatchVoucherDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  /** Called after a successful link. journalEntryId is the (first) picked
   *  verifikat; voucherLabel names every picked one, e.g. "A-42" or, for a
   *  split, "A-42, A-43". */
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
  // Picked verifikat, in pick order. One = the plain link (1:1, or N:1 behind
  // "visa matchade"); several = the split (1:N, #1553): one bank row that
  // Bankgirot or a card acquirer aggregated over several händelser, each
  // booked as its own verifikat. The row stays whole and is linked to all of
  // them; nothing is "split" in the bookkeeping.
  const [selected, setSelected] = useState<string[]>([])
  // The split the candidate load proposed (exact öre sum, no single match),
  // kept so the dialog can say so while the selection is still that set.
  const [proposal, setProposal] = useState<string[] | null>(null)
  const [accountNumber, setAccountNumber] = useState('1930')
  const [accountFallback, setAccountFallback] = useState(false)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [wideRange, setWideRange] = useState(false)
  // Opt-in: also surface vouchers already matched to another bank transaction,
  // so several transactions can settle one verifikat (N:1: a salary run paid in
  // multiple transfers, an invoice paid in instalments).
  const [includeMatched, setIncludeMatched] = useState(false)
  // Session-cached (lib/reference-data): resolving the settlement account no
  // longer costs a /api/cash-accounts round trip per candidate load.
  const { cashAccounts } = useCashAccounts()

  const loadCandidates = useCallback(
    async (tx: TransactionWithInvoice, wide: boolean, matched: boolean, signal: { cancelled: boolean }) => {
      setLoading(true)
      try {
        // Resolve the settlement account from the company's cash accounts
        // (an empty list resolves to 1930 with the fallback note shown).
        const resolved = resolveAccount(cashAccounts, tx.cash_account_id ?? null, tx.currency ?? 'SEK')
        const account = resolved.account
        const fallback = resolved.fallback
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
        // With no strong single match, propose the split instead: the
        // smallest set of unmatched verifikat that sums to the row to the
        // öre (a Bankgirot day-sum against the day's inbetalningar). The
        // user still confirms; the button names how many.
        const top = lines[0]
        const strong =
          top && (top.confidence ?? 0) >= 0.85 && !(top.linked_transaction_count ?? 0)
            ? top.journal_entry_id
            : null
        const proposed = strong ? null : proposeSplitSelection(lines, tx.amount, tx.date)
        setProposal(proposed)
        setSelected((prev) => (prev.length > 0 ? prev : strong ? [strong] : (proposed ?? [])))
      } finally {
        if (!signal.cancelled) setLoading(false)
      }
    },
    [cashAccounts],
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
    setSelected([])
    setProposal(null)
    setWideRange(false)
    setIncludeMatched(false)
    setAccountFallback(false)
  }, [open])

  const isMatched = (id: string) =>
    (glLines.find((l) => l.journal_entry_id === id)?.linked_transaction_count ?? 0) > 0

  function toggleVoucher(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      // An already-matched verifikat joins no split (N:M has no engine shape,
      // the same rule as the reconciliation worksheet): picking one replaces
      // the selection, and picking anything else drops it.
      if (isMatched(id) || prev.some(isMatched)) return [id]
      return [...prev, id]
    })
  }

  if (!transaction) return null

  const isIncome = transaction.amount > 0
  const selectedLines = selected.flatMap((id) => {
    const line = glLines.find((l) => l.journal_entry_id === id)
    return line ? [line] : []
  })
  const selectedLine = selected.length === 1 ? (selectedLines[0] ?? null) : null
  const isSplit = selected.length > 1
  const split = buildSplitSelection(glLines, selected, transaction.amount)
  // A split explains the whole row, so every picked verifikat must be in the
  // candidate list (not hidden by "dölj matchade") and the slices must sum to
  // the row; the engine refuses anything else.
  const splitReady = split.balanced && split.allocations.length === selected.length
  const canSubmit = selected.length > 0 && !submitting && (!isSplit || splitReady)
  // The nudge toward the split: one unmatched verifikat picked whose amount is
  // not the row's. A bankgiro day-sum against one of its inbetalningar lands
  // exactly here. Not shown for a matched pick (N:1), where a difference is
  // the expected shape.
  const singleDiffers =
    selectedLine !== null && !isMatched(selectedLine.journal_entry_id) && !split.balanced
  const showingProposal =
    proposal !== null &&
    proposal.length === selected.length &&
    proposal.every((id) => selected.includes(id))

  async function handleConfirm() {
    if (!transaction || selected.length === 0) return
    if (isSplit && !splitReady) return
    setSubmitting(true)
    try {
      const res = await fetch('/api/reconciliation/bank/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction_id: transaction.id,
          account_number: accountNumber,
          ...(isSplit ? { allocations: split.allocations } : { journal_entry_id: selected[0] }),
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
      const label = selectedLines.map((l) => formatVoucher(l)).join(', ')
      onLinked(transaction.id, selected[0], label)
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
          {/* Convention 7: the how-it-works copy lives behind the "?", not in
              the dialog flow. */}
          <div className="flex items-center gap-2">
            <DialogTitle>Matcha mot befintlig verifikation</DialogTitle>
            <HelpPopover>
              <p>
                Kopplar bankhändelsen till en verifikation som redan är bokförd,
                t.ex. en lön eller en post importerad från Fortnox. Ingen ny
                bokföring skapas.
              </p>
              <p className="mt-2">
                Täcker bankhändelsen flera verifikationer, t.ex. en bankgirorad
                som klumpar ihop dagens inbetalningar? Välj alla som ingår.
                Beloppen måste tillsammans bli bankhändelsens belopp; raden
                delas inte, den kopplas till flera.
              </p>
              <p className="mt-2">
                Med &quot;Visa även matchade&quot; kan flera bankhändelser kopplas
                till samma verifikation, t.ex. en lön utbetald i flera
                överföringar.
              </p>
            </HelpPopover>
          </div>
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
              <MatchVerifikationPicker
                glLines={glLines}
                selectedIds={selected}
                onToggle={toggleVoucher}
                inline
              />
              {(selectedLine?.linked_transaction_count ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground">
                  Redan matchad mot {selectedLine?.linked_transaction_count}{' '}
                  transaktion{(selectedLine?.linked_transaction_count ?? 0) === 1 ? '' : 'er'};
                  den här läggs till.
                </p>
              )}
              {singleDiffers && (
                <p className="text-xs text-muted-foreground">
                  Verifikatet skiljer sig{' '}
                  {formatCurrency(Math.abs(split.difference), transaction.currency)} från
                  bankhändelsen. Täcker raden flera verifikationer, t.ex. dagens
                  bankgiroinbetalningar? Välj dem också i listan.
                </p>
              )}
              {/* The arithmetic of a split, the same footer the worksheet
                  shows: what the picks sum to and what is left unexplained. */}
              {showingProposal && (
                <p className="text-xs text-muted-foreground">
                  Förslag: de här {selected.length} verifikationerna summerar exakt till
                  bankhändelsen. Kontrollera och klicka Matcha.
                </p>
              )}
              {isSplit && (
                <div
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs tabular-nums"
                  data-ph-mask
                >
                  <span>
                    {selected.length} verifikationer valda:{' '}
                    {formatCurrency(split.sum, transaction.currency)}
                  </span>
                  <span className={cn(split.balanced ? 'text-muted-foreground' : 'text-warning')}>
                    Differens {formatCurrency(split.difference, transaction.currency)}
                  </span>
                </div>
              )}
              {isSplit && !split.balanced && (
                <p className="text-xs text-muted-foreground">
                  Verifikationerna måste tillsammans motsvara bankhändelsens belopp.
                  Lägg till eller ta bort tills differensen är 0.
                </p>
              )}
            </>
          )}

          {/* Discovery affordances: widen the date window, and surface vouchers
              already matched so another transaction can be attached (N:1).
              Quiet links, not switches: these are list filters, and the switch
              idiom belongs to settings (convention 15). */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-1">
            <button
              type="button"
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => setIncludeMatched((v) => !v)}
            >
              {includeMatched ? 'Dölj matchade' : 'Visa även matchade'}
            </button>
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
          <Button onClick={handleConfirm} disabled={!canSubmit}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Matchar…
              </>
            ) : isSplit ? (
              `Matcha ${selected.length} verifikationer`
            ) : (
              'Matcha'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
