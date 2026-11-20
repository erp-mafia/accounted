'use client'

import { useCallback, useRef, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useBankLedgerSuggestions } from '@/lib/hooks/use-bank-ledger-suggestions'
import { applyLedgerSuggestion } from '@/lib/cash-accounts/ledger-suggestion-client'
import {
  ledgerSuggestionAction,
  ledgerSuggestionBody,
  ledgerSuggestionBookedNote,
  ledgerSuggestionConfirmTitle,
  ledgerSuggestionLine,
} from '@/lib/cash-accounts/ledger-suggestion-view'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'

interface BankLedgerSuggestionNoticeOptions {
  /** Called after a suggestion was applied and the matching has run: refetch what the page shows. */
  onApplied?: () => void
  /** The page already is the bank settings: no link there. */
  onBankSettings?: boolean
  className?: string
}

/**
 * The one attention sentence for a bank account that books on another 19xx
 * ledger account than the books say (crm#1066), with the action that changes
 * it: "Bankkontot ••4417 bokförs på 1940, men hör enligt bokföringen till 1920
 * PlusGiro. Byt till 1920". The action opens a small confirm dialog (design
 * convention 10) with the evidence, the already booked transactions that stay
 * where they are, and, for a swap across two bank connections, the way there;
 * the change is made on its confirm.
 *
 * A move, a swap of two accounts that sit on each other's ledger account, or
 * a one-sided swap (the ledger account is held by an account nothing in the
 * books ties to it): each has its own sentences, built in
 * lib/cash-accounts/ledger-suggestion-view.ts.
 *
 * Returns null when there is nothing to say, so a page can give its single
 * attention line (design convention 6) to something else. One suggestion at a
 * time: the next one shows once this one is applied. Read after the first
 * render, and never for a viewer, who could not act on it.
 *
 * Shared by Transaktioner and the bank settings. The change itself is the
 * bank picker's own save request (lib/cash-accounts/ledger-suggestion-client.ts).
 */
export function useBankLedgerSuggestionNotice(options: BankLedgerSuggestionNoticeOptions = {}): React.ReactNode | null {
  const { onApplied, onBankSettings = false, className } = options
  const t = useTranslations('bank_ledger_suggestion')
  const tCommon = useTranslations('common')
  const { toast } = useToast()
  const { company } = useCompany()
  const { canWrite } = useCanWrite()
  const { suggestions } = useBankLedgerSuggestions({ enabled: canWrite })
  const [applyingId, setApplyingId] = useState<string | null>(null)
  // The suggestion whose confirm dialog is open. Keyed by id, so a dialog
  // never reopens on its own for the next suggestion after this one is gone.
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  // A refused save, shown in place of the suggestion until the page is left:
  // nothing changed, and the sentence says what to do instead (it is the one
  // the bank picker shows for the same refusal).
  const [refusal, setRefusal] = useState<string | null>(null)
  // A second click while the first is in flight must not send a second save.
  const inFlight = useRef(false)

  const suggestion = suggestions.find((s) => s.one_click || s.two_connections) ?? null
  const companyId = company?.id ?? null

  const apply = useCallback(async () => {
    if (!suggestion || !companyId || inFlight.current) return
    inFlight.current = true
    setApplyingId(suggestion.id)
    try {
      const result = await applyLedgerSuggestion(companyId, suggestion.id)
      if (result.status === 'refused') {
        setRefusal(result.reason ?? t('refused_fallback'))
        return
      }
      if (result.status === 'applied') {
        toast({
          title: t('applied_title'),
          description: result.relinked
            ? t('applied_description', { linked: result.relinked.linked, suggested: result.relinked.suggested })
            : t('applied_matching_failed'),
        })
        // The account chooser reads cash accounts from the session cache.
        void invalidateReferenceData('ref:cash-accounts')
        onApplied?.()
      }
      // Applied, or no longer true: the suggestions were read again already
      // (applyLedgerSuggestion forgets the cached answer in both cases).
    } finally {
      inFlight.current = false
      setApplyingId(null)
      setConfirmingId(null)
    }
  }, [suggestion, companyId, onApplied, t, toast])

  const openBankSettings = onBankSettings ? undefined : { label: t('action_open_settings'), href: '/settings/banking' }

  if (refusal) {
    return (
      <AttnLine className={className} action={openBankSettings}>
        <span data-ph-mask="">{t('refused', { reason: refusal })}</span>
      </AttnLine>
    )
  }
  if (!suggestion) return null

  const line = ledgerSuggestionLine(suggestion)
  const title = ledgerSuggestionConfirmTitle(suggestion)
  const body = ledgerSuggestionBody(suggestion)
  const booked = ledgerSuggestionBookedNote(suggestion)
  const button = ledgerSuggestionAction(suggestion)
  const actionLabel = t(button.key, button.values)
  const applying = applyingId === suggestion.id

  return (
    <>
      <AttnLine className={className} action={{ label: actionLabel, onClick: () => setConfirmingId(suggestion.id) }}>
        <span data-ph-mask="">{t(line.key, line.values)}</span>
      </AttnLine>
      <Dialog
        open={confirmingId === suggestion.id}
        onOpenChange={(open) => {
          if (applying) return
          if (!open) setConfirmingId(null)
        }}
      >
        <DialogContent size="confirm">
          <DialogHeader>
            <DialogTitle>{t(title.key, title.values)}</DialogTitle>
            <DialogDescription data-ph-mask="">{t(body.key, body.values)}</DialogDescription>
          </DialogHeader>
          {(booked || !suggestion.one_click) && (
            <div className="space-y-2 text-[13px] text-muted-foreground">
              {booked && <p>{t(booked.key, booked.values)}</p>}
              {!suggestion.one_click && <p>{t('swap_two_connections')}</p>}
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            {suggestion.one_click ? (
              <>
                <Button variant="outline" onClick={() => setConfirmingId(null)} disabled={applying}>
                  {tCommon('cancel')}
                </Button>
                <Button onClick={() => void apply()} loading={applying}>
                  {actionLabel}
                </Button>
              </>
            ) : (
              <>
                <Button variant={openBankSettings ? 'outline' : 'default'} onClick={() => setConfirmingId(null)}>
                  {tCommon('close')}
                </Button>
                {openBankSettings && (
                  <Button asChild>
                    <Link href={openBankSettings.href}>{openBankSettings.label}</Link>
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
