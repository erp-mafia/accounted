'use client'

import { useState } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { Loader2 } from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { resolveAccount } from '@/lib/cash-accounts/resolve-account'
import type { CashAccount } from '@/types'
import type { BookedDuplicateCandidate } from '@/lib/transactions/booking-duplicate-detection'

/** The bank transaction being booked, as much as the caller knows about it.
 *  Enables the "Matcha mot verifikatet" action for ledger-only candidates. */
export interface DuplicateMatchTransaction {
  id: string
  cash_account_id?: string | null
  currency?: string | null
}

/**
 * Soft warning shown when the booking-time duplicate guard fires
 * (TRANSACTION_BOOK_POSSIBLE_DUPLICATE): another already-booked transaction
 * shares this one's date + amount + bank account. Never a hard block:
 * genuinely repeated same-day payments (e.g. several identical Swish transfers)
 * are legitimate, so the user can review the existing verifikat or book anyway.
 *
 * Shared by the /transactions list (runCategorize) and the manual booking
 * dialog (JournalEntryForm → /api/transactions/[id]/book). The caller owns the
 * retry: "Bokför ändå" must re-issue the request with force=true bound to
 * `candidate.journal_entry_id` via `expected_duplicate_journal_entry_id`: it
 * is present on both candidate kinds (a sibling-transaction candidate and a
 * ledger-only voucher candidate, which has no transaction_id), and the server
 * re-detects it so a stale id can't wave the guard away.
 *
 * Ledger-only candidates (candidate.transaction_id === null: the voucher exists
 * but no bank transaction is linked to it, e.g. a verifikat from an SIE import
 * or an invoice marked paid) get "Matcha mot verifikatet" as the PRIMARY action
 * when the caller supplies `matchTransaction` + `onMatched`: it links the bank
 * line to the existing voucher via /api/reconciliation/bank/link (the same path
 * MatchVoucherDialog uses) instead of double-booking the affärshändelse.
 * "Bokför ändå" stays available but demoted. Sibling-transaction candidates
 * keep booking as the primary action: matching a second bank line onto a
 * voucher that already has one is the N:1 edge case, not the default.
 */
export default function DuplicateBookingDialog({
  candidate,
  processing = false,
  onBookAnyway,
  onCancel,
  matchTransaction,
  onMatched,
}: {
  /** The already-booked sibling, or null to keep the dialog closed. */
  candidate: BookedDuplicateCandidate | null
  processing?: boolean
  onBookAnyway: () => void
  onCancel: () => void
  /** The transaction being booked; required for the match action. */
  matchTransaction?: DuplicateMatchTransaction | null
  /** Called after /api/reconciliation/bank/link succeeds. Mirrors
   *  MatchVoucherDialog's onLinked signature: everything the refresh needs is
   *  passed in, so a mid-request dialog close can't strand the update. The
   *  caller owns the success toast and state refresh (and closes the dialog by
   *  clearing `candidate`). */
  onMatched?: (transactionId: string, journalEntryId: string, voucherLabel: string) => void
}) {
  const t = useTranslations('transactions')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [matching, setMatching] = useState(false)

  // The match action is offered only for ledger-only voucher candidates: the
  // voucher has no bank transaction linked yet, so linking THIS one to it is
  // the right default (one affärshändelse, one verifikat).
  const canMatch =
    candidate !== null && candidate.transaction_id === null && !!matchTransaction && !!onMatched

  async function handleMatch() {
    if (!candidate || !matchTransaction || !onMatched || matching) return
    setMatching(true)
    try {
      // Link on the exact 19xx account the candidate voucher was booked to
      // when the guard reported it: a legacy transaction without a
      // cash_account_id would otherwise resolve by currency and can pick a
      // different 19xx than the voucher's leg, dead-ending the link. Fall back
      // to resolving from the company's cash accounts, same as
      // MatchVoucherDialog: the link route validates the voucher has a leg on
      // this account and that the transaction belongs to it.
      let account = candidate.account_number ?? '1930'
      if (!candidate.account_number) {
        try {
          const caRes = await fetch('/api/cash-accounts')
          if (caRes.ok) {
            const caJson = await caRes.json()
            const accounts = (caJson.data ?? []) as CashAccount[]
            account = resolveAccount(
              accounts,
              matchTransaction.cash_account_id ?? null,
              matchTransaction.currency ?? 'SEK',
            ).account
          }
        } catch {
          // Network hiccup: fall back to 1930; the link route re-validates.
        }
      }

      const res = await fetch('/api/reconciliation/bank/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction_id: matchTransaction.id,
          journal_entry_id: candidate.journal_entry_id,
          account_number: account,
        }),
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        toast({
          title: t('dialog_duplicate_match_failed'),
          description: getErrorMessage(result, { context: 'transaction', statusCode: res.status, locale }),
          variant: 'destructive',
        })
        return
      }
      onMatched(matchTransaction.id, candidate.journal_entry_id, candidate.voucher_label)
    } catch {
      toast({
        title: t('dialog_duplicate_match_failed'),
        description: getErrorMessage(null, { context: 'transaction', locale }),
        variant: 'destructive',
      })
    } finally {
      setMatching(false)
    }
  }

  const busy = processing || matching

  return (
    <Dialog
      open={candidate !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('dialog_duplicate_title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('dialog_duplicate_body')}</p>
          {candidate && (
            <div className="space-y-1 rounded-md border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">
                  {candidate.voucher_label
                    ? t('dialog_duplicate_voucher_label', { label: candidate.voucher_label })
                    : t('dialog_duplicate_voucher_generic')}
                </span>
                <span className="tabular-nums">{formatCurrency(candidate.amount)}</span>
              </div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {formatDate(candidate.entry_date)}
              </div>
              {candidate.description && (
                <div className="truncate text-xs text-muted-foreground">{candidate.description}</div>
              )}
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            {candidate && (
              <Button asChild variant="ghost" size="sm" className="text-muted-foreground sm:mr-auto">
                <a
                  href={`/bookkeeping/${candidate.journal_entry_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('dialog_duplicate_view_voucher')}
                </a>
              </Button>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={onCancel} disabled={busy}>
                {t('dialog_duplicate_cancel')}
              </Button>
              {canMatch ? (
                <>
                  <Button variant="outline" onClick={onBookAnyway} disabled={busy}>
                    {t('dialog_duplicate_book_anyway')}
                  </Button>
                  <Button onClick={handleMatch} disabled={busy}>
                    {matching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('dialog_duplicate_match')}
                  </Button>
                </>
              ) : (
                <Button onClick={onBookAnyway} disabled={busy}>
                  {t('dialog_duplicate_book_anyway')}
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
