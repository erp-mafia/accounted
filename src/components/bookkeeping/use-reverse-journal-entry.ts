'use client'

import { useCallback, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { settlementsToastAction } from '@/components/collections/settlements-toast-action'

/**
 * Pure reversal (storno) of a posted verifikat: books a stornoverifikation
 * with no replacement, per BFL 5 kap 5 §, through the engine's reverseEntry
 * (storno + reverses_id link; original → 'reversed', never deleted). "Rätta"
 * stays the path for booking a replacement entry instead.
 *
 * One request, toast and chain-depth handling for every surface that offers
 * Vänd (the verifikat page and the journal list). A CORRECTION_CHAIN_TOO_DEEP
 * refusal goes to `onDeepChain` when the surface offers the "Återför ändå"
 * bypass, and is a toast otherwise. A refused storno of a collected payment
 * carries the toast action to Avräkningar (settlementsToastAction).
 */
export function useReverseJournalEntry({
  onReversed,
  onDeepChain,
}: {
  onReversed: () => void | Promise<void>
  onDeepChain?: (depth: number) => void
}) {
  const t = useTranslations('journal_detail')
  const tSettlements = useTranslations('settlements')
  const { toast } = useToast()
  const [isReversing, setIsReversing] = useState(false)

  const reverse = useCallback(
    async (entryId: string, allowDeepChain = false): Promise<boolean> => {
      setIsReversing(true)
      try {
        const res = await fetch(`/api/bookkeeping/journal-entries/${entryId}/reverse`, {
          method: 'POST',
          ...(allowDeepChain
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ allow_deep_chain: true }),
              }
            : {}),
        })
        const result = await res.json()
        if (res.ok) {
          toast({
            title: t('toast_reverse_done_title'),
            description: t('toast_reverse_done_description', { voucher: formatVoucher(result.data ?? {}) }),
          })
          await onReversed()
          return true
        }
        if (result?.error?.code === 'CORRECTION_CHAIN_TOO_DEEP' && onDeepChain) {
          // Swap into the bypass confirm instead of a dead-end toast:
          // "Återför ändå" resubmits with allow_deep_chain.
          onDeepChain(result.error?.details?.depth ?? 3)
          return false
        }
        toast({
          title: t('toast_reverse_failed'),
          description: getErrorMessage(result, { context: 'journal_entry' }),
          variant: 'destructive',
          action: settlementsToastAction(result, tSettlements('open_settlements')),
        })
        return false
      } catch {
        toast({ title: t('toast_reverse_failed'), variant: 'destructive' })
        return false
      } finally {
        setIsReversing(false)
      }
    },
    [onReversed, onDeepChain, t, tSettlements, toast],
  )

  return { reverse, isReversing }
}
