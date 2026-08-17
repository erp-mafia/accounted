'use client'

import { useState } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { AlertTriangle, Loader2 } from 'lucide-react'
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
 * "Bokför ändå" stays available but demoted.
 *
 * Sibling-transaction candidates (candidate.transaction_id set: the verifikat
 * is already linked to ANOTHER bank transaction) get the match action too:
 * manualLink (lib/reconciliation/bank-reconciliation.ts) explicitly allows a
 * second transaction on one voucher (split settlements), so hiding the action
 * dead-ended the user in "Bokför ändå". Their body copy asks "vill du matcha i
 * stället?" and, because that shape is very often a duplicate IMPORT of one
 * real movement (where matching would double-count the bank side), they
 * additionally get "Ignorera transaktionen" via /api/transactions/[id]/ignore
 * when the caller supplies `onIgnored`.
 */
export default function DuplicateBookingDialog({
  candidate,
  processing = false,
  onBookAnyway,
  onCancel,
  matchTransaction,
  onMatched,
  onIgnored,
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
  /** Called after POST /api/transactions/[id]/ignore succeeds for a
   *  sibling-transaction candidate (the row is likely a duplicate import).
   *  The caller owns the refresh and closes the dialog by clearing
   *  `candidate`. Omit to hide the ignore action. */
  onIgnored?: (transactionId: string) => void
}) {
  const t = useTranslations('transactions')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [matching, setMatching] = useState(false)
  const [ignoring, setIgnoring] = useState(false)

  // A sibling-transaction candidate: the twin bank row is already booked, so
  // the target is either a duplicate import (ignore), the second leg of an
  // N:1 settlement (match), or a genuinely separate identical event (book).
  const isSiblingCandidate = candidate !== null && candidate.transaction_id !== null

  // Matching links THIS bank line to the existing voucher instead of minting a
  // second verifikat (one affärshändelse, one verifikat). Offered for both
  // candidate kinds: for ledger-only vouchers it is the right default, and for
  // sibling candidates manualLink explicitly permits N:1 links.
  const canMatch = candidate !== null && !!matchTransaction && !!onMatched
  const canIgnore = isSiblingCandidate && !!matchTransaction && !!onIgnored

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

  async function handleIgnore() {
    if (!candidate || !matchTransaction || !onIgnored || ignoring) return
    setIgnoring(true)
    try {
      const res = await fetch(`/api/transactions/${matchTransaction.id}/ignore`, {
        method: 'POST',
      })
      const result = await res.json().catch(() => null)
      if (!res.ok || result?.error) {
        toast({
          title: t('dialog_duplicate_ignore_failed'),
          description: getErrorMessage(result, { context: 'transaction', statusCode: res.status, locale }),
          variant: 'destructive',
        })
        return
      }
      onIgnored(matchTransaction.id)
    } catch {
      toast({
        title: t('dialog_duplicate_ignore_failed'),
        description: getErrorMessage(null, { context: 'transaction', locale }),
        variant: 'destructive',
      })
    } finally {
      setIgnoring(false)
    }
  }

  const busy = processing || matching || ignoring

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
          {/* Sibling candidates get the "vill du matcha i stället?" copy: the
              generic body's "en annan transaktion eller en befintlig
              verifikation" hedge reads as noise once the twin is known. The
              ignore hint renders only when the action itself does (callers
              without onIgnored, e.g. the manual booking form and the bulk
              dialog, must not have copy pointing at a button that is not
              there). */}
          <p className="text-sm text-muted-foreground">
            {isSiblingCandidate ? t('dialog_duplicate_body_sibling') : t('dialog_duplicate_body')}
            {canIgnore && <> {t('dialog_duplicate_ignore_hint')}</>}
          </p>
          {candidate && (
            <div className="space-y-1 rounded-lg border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">
                  {candidate.voucher_label
                    ? t('dialog_duplicate_voucher_label', { label: candidate.voucher_label })
                    : t('dialog_duplicate_voucher_generic')}
                </span>
                {/* candidate.amount is ALWAYS SEK or null, never a foreign
                    number (booking-duplicate-detection.ts): the explicit 'SEK'
                    states that contract at the call site. When the sibling is
                    foreign and carries no stored rate, amount is null and the
                    honest figure is the sibling's own amount in its own
                    currency, explicitly labelled. */}
                <span className="tabular-nums">
                  {candidate.amount != null
                    ? formatCurrency(candidate.amount, 'SEK')
                    : candidate.currency && candidate.amount_in_currency != null
                      ? formatCurrency(candidate.amount_in_currency, candidate.currency)
                      : t('dialog_duplicate_amount_unknown')}
                </span>
              </div>
              {/* Verified FX sibling: the kr figure above is the sibling's own
                  booked SEK value; show the foreign original beneath it so the
                  user can recognise their EUR/USD line at a glance. */}
              {candidate.amount != null &&
                candidate.currency &&
                candidate.amount_in_currency != null && (
                  <div className="text-right text-xs text-muted-foreground tabular-nums">
                    {formatCurrency(candidate.amount_in_currency, candidate.currency)}
                  </div>
                )}
              <div className="text-xs text-muted-foreground tabular-nums">
                {formatDate(candidate.entry_date)}
              </div>
              {candidate.description && (
                <div className="truncate text-xs text-muted-foreground">{candidate.description}</div>
              )}
              {/* Rateless foreign sibling: the amounts matched exactly in the
                  shared currency, but no SEK value exists for it, so say that
                  instead of printing an authoritative-looking kr figure.
                  Gated on candidate.currency: the sentence names the currency,
                  and interpolating an empty string renders broken Swedish
                  ("samma belopp i , men..."). A null-currency candidate with a
                  null amount already shows dialog_duplicate_amount_unknown. */}
              {candidate.amount == null && candidate.currency && (
                <div className="flex items-start gap-2 pt-1">
                  <AlertTriangle className="h-3.5 w-3.5 text-attn flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-attn leading-snug">
                    {t('dialog_duplicate_sek_unavailable', { currency: candidate.currency })}
                  </p>
                </div>
              )}
              {/* Ledger-only candidate found for a bank line that has no SEK
                  value: the kr figure above is the voucher leg's real amount,
                  but it could not be compared against the transaction, so the
                  match rests on date + account + direction alone. */}
              {candidate.amount != null && !candidate.amount_verified && (
                <div className="flex items-start gap-2 pt-1">
                  <AlertTriangle className="h-3.5 w-3.5 text-attn flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-attn leading-snug">
                    {t('dialog_duplicate_amount_unverified')}
                  </p>
                </div>
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
                  {/* Sibling candidates only: when the row is a duplicate
                      import of the already-booked twin, ignoring it is the
                      correct resolution (matching would double-count the bank
                      side, booking would double-count the ledger side). */}
                  {canIgnore && (
                    <Button variant="outline" onClick={handleIgnore} disabled={busy}>
                      {ignoring && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {t('dialog_duplicate_ignore')}
                    </Button>
                  )}
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
