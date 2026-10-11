'use client'

import { useCallback, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useBankLedgerSuggestions } from '@/lib/hooks/use-bank-ledger-suggestions'
import { applyLedgerSuggestion } from '@/lib/cash-accounts/ledger-suggestion-client'
import {
  ledgerSuggestionAction,
  ledgerSuggestionBody,
  ledgerSuggestionBookedNote,
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
 * ledger account than the books say (crm#1066), with the button that changes
 * it: "Bankkontot ••4417 bokförs på 1940, men 46 av dess banktransaktioner är
 * redan bokförda på 1920 PlusGiro. Byt till 1920 ...".
 *
 * A move, a swap of two accounts that sit on each other's ledger account, or
 * a one-sided swap (the ledger account is held by an account nothing in the
 * books ties to it): each has its own sentence, built in
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
  const { toast } = useToast()
  const { company } = useCompany()
  const { canWrite } = useCanWrite()
  const { suggestions } = useBankLedgerSuggestions({ enabled: canWrite })
  const [applyingId, setApplyingId] = useState<string | null>(null)
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

  const body = ledgerSuggestionBody(suggestion)
  const booked = ledgerSuggestionBookedNote(suggestion)
  const sentences = [
    t(body.key, body.values),
    booked ? t(booked.key, booked.values) : null,
    suggestion.one_click ? null : t('swap_two_connections'),
  ].filter(Boolean)

  const button = ledgerSuggestionAction(suggestion)
  const action = suggestion.one_click
    ? {
        label: applyingId === suggestion.id ? t('applying') : t(button.key, button.values),
        onClick: () => void apply(),
      }
    : openBankSettings

  return (
    <AttnLine className={className} action={action}>
      <span data-ph-mask="">{sentences.join(' ')}</span>
    </AttnLine>
  )
}
