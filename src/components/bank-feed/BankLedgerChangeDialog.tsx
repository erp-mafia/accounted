'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import {
  applyLedgerChange,
  LedgerChangeError,
  previewLedgerChange,
  type LedgerChangeMove,
} from '@/lib/cash-accounts/ledger-change-client'
import { forgetLedgerSuggestions, relinkBankTransactions } from '@/lib/cash-accounts/ledger-suggestion-client'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'

/** One bank account's asked change: which account, and the 19xx account it should book on. */
export interface LedgerChangeAsk {
  connectionId: string
  uid: string
  /** What the rows call the account ("Plusgirokonto ••4308"). */
  label: string
  toLedger: string
}

interface BankLedgerChangeDialogProps {
  /** Null keeps the dialog closed. */
  ask: LedgerChangeAsk | null
  /** "1920 PlusGiro": a ledger account as the rows name it. */
  ledgerLabel: (ledger: string) => string
  onClose: () => void
}

type PreviewState =
  | { kind: 'checking' }
  | { kind: 'ready'; moves: LedgerChangeMove[] }
  | { kind: 'refused'; message: string }

/**
 * The confirmation for changing which 19xx account a bank account books on
 * (crm#1387, design convention 10: confirm up front). It asks the server's
 * dry run, the same rules the change runs, and says what changes before
 * anything does: the account books on the new ledger account from now on,
 * its unbooked transactions follow, what is already booked stays where it
 * is (a verifikat is never rewritten; moving it is a rättelse, BFL 5 kap 5 §),
 * a sibling that sat on the wanted account trades places, and transactions
 * the books already hold on the new account get linked afterwards. A refusal
 * is the server's sentence naming the account in the way.
 */
export function BankLedgerChangeDialog({ ask, ledgerLabel, onClose }: BankLedgerChangeDialogProps) {
  if (!ask) return null
  // Keyed by the ask: each opening starts from a fresh preview.
  return <BankLedgerChangeBody key={`${ask.connectionId}:${ask.uid}:${ask.toLedger}`} ask={ask} ledgerLabel={ledgerLabel} onClose={onClose} />
}

function BankLedgerChangeBody({ ask, ledgerLabel, onClose }: { ask: LedgerChangeAsk; ledgerLabel: (ledger: string) => string; onClose: () => void }) {
  const t = useTranslations('bank_ledger_change')
  const tLedger = useTranslations('bank_ledger_suggestion')
  const tCommon = useTranslations('common')
  const { toast } = useToast()
  const [state, setState] = useState<PreviewState>({ kind: 'checking' })
  const [saving, setSaving] = useState(false)
  const accounts = [{ uid: ask.uid, ledger_account: ask.toLedger }]
  const fallback = t('refused_fallback')

  useEffect(() => {
    let cancelled = false
    previewLedgerChange(ask.connectionId, [{ uid: ask.uid, ledger_account: ask.toLedger }])
      .then((moves) => {
        if (!cancelled) setState({ kind: 'ready', moves })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: 'refused', message: (error instanceof LedgerChangeError && error.reason) || fallback })
      })
    return () => {
      cancelled = true
    }
  }, [ask.connectionId, ask.uid, ask.toLedger, fallback])

  async function confirm() {
    setSaving(true)
    let moves: LedgerChangeMove[]
    try {
      moves = await applyLedgerChange(ask.connectionId, accounts)
    } catch (error) {
      // Something changed since the preview: say why instead of the old outcome.
      setState({ kind: 'refused', message: (error instanceof LedgerChangeError && error.reason) || fallback })
      setSaving(false)
      return
    }
    // The rows and every account chooser read cash accounts from the session
    // cache; the suggestions may no longer hold.
    void invalidateReferenceData('ref:cash-accounts')
    forgetLedgerSuggestions()
    onClose()
    // Bank rows the books already hold as verifikat on the new account get
    // linked to them, as when a suggestion is applied. In the background:
    // the change itself is done.
    void relinkBankTransactions(moves.map((move) => move.to_ledger)).then((relinked) => {
      toast({
        title: tLedger('applied_title'),
        description: relinked
          ? tLedger('applied_description', { linked: relinked.linked, suggested: relinked.suggested })
          : tLedger('applied_matching_failed'),
      })
    })
  }

  const asked = state.kind === 'ready' ? state.moves.find((move) => move.uid === ask.uid) ?? null : null
  const swaps = state.kind === 'ready' ? state.moves.filter((move) => move.swapped) : []
  const swapLabel = (move: LedgerChangeMove) =>
    [move.name ?? t('account_generic'), move.iban_last4 ? `••${move.iban_last4}` : null].filter(Boolean).join(' ')

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent size="confirm">
        <DialogHeader>
          <DialogTitle className="text-lg">
            {state.kind === 'refused' ? t('refused_title') : t('confirm_title', { to: ledgerLabel(ask.toLedger) })}
          </DialogTitle>
          {state.kind === 'checking' ? (
            <DialogDescription className="sr-only">{t('checking')}</DialogDescription>
          ) : state.kind === 'refused' ? (
            <DialogDescription data-ph-mask="" className="text-[13px] leading-relaxed">
              {state.message}
            </DialogDescription>
          ) : (
            // data-ph-mask: the sentences name the bank account (user data).
            <DialogDescription data-ph-mask="" className="text-[13px] leading-relaxed">
              {t('confirm_lead', {
                account: ask.label,
                to: ledgerLabel(ask.toLedger),
                from: asked?.from_ledger ? ledgerLabel(asked.from_ledger) : '-',
              })}
            </DialogDescription>
          )}
        </DialogHeader>
        {state.kind === 'checking' && (
          <LateReveal className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </LateReveal>
        )}
        {state.kind === 'ready' && (
          <ul data-ph-mask="" className="space-y-2 text-[13px] leading-relaxed text-muted-foreground">
            {asked && asked.unbooked_rows > 0 && <li>{t('unbooked', { count: asked.unbooked_rows, to: ask.toLedger })}</li>}
            <li>
              {asked && asked.booked_rows > 0 && asked.from_ledger
                ? t('booked', { count: asked.booked_rows, from: asked.from_ledger })
                : t('nothing_booked')}
            </li>
            {swaps.map((move) => (
              <li key={move.uid}>
                {t('swap', { account: swapLabel(move), from: move.from_ledger ?? '-', to: move.to_ledger })}
              </li>
            ))}
            <li>{t('matching', { to: ask.toLedger })}</li>
          </ul>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          {state.kind === 'refused' ? (
            <Button variant="ghost" onClick={onClose}>
              {tCommon('close')}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={saving}>
                {tCommon('cancel')}
              </Button>
              <Button onClick={() => void confirm()} loading={saving} disabled={state.kind !== 'ready' || state.moves.length === 0}>
                {t('action', { to: ask.toLedger })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
