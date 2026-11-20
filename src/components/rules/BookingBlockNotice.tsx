'use client'

import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { factsFromLines, grantCounterpartyKey, matchBookingReviewRules } from '@/lib/booking-review/match'
import { blockCriteria, fetchBlocks, type BlocksPayload } from './BookingBlocks'

interface BookingBlockNoticeProps {
  /** The verifikat the confirm posts, as previewed. */
  lines: ReadonlyArray<{ account_number: string; debit_amount: number; credit_amount: number }>
  /** The supplier's name: what a block names a counterparty by. */
  counterparty: string | null | undefined
  /** The invoice total in SEK: what a block's amount from is judged on. */
  amountSek: number
}

/**
 * The block (Spärr, accounted#130, #145) a supplier invoice about to be
 * registered meets, said where the person registers it: one ochre sentence
 * naming the block, telling them their confirm is the review it waits for.
 * The same matching commit_journal_entry runs on the posted lines
 * (lib/booking-review/match.ts); nothing shows while the rules load, for a
 * company without blocks, or when none matches.
 */
export function BookingBlockNotice({ lines, counterparty, amountSek }: BookingBlockNoticeProps) {
  const t = useTranslations('rules.blocks')
  const { data } = useSWR<BlocksPayload>('/api/rules/blocks', fetchBlocks)
  const active = (data?.rules ?? []).filter((rule) => !rule.revoked_at)
  if (active.length === 0 || lines.length === 0) return null
  const matched = matchBookingReviewRules(
    active,
    factsFromLines(lines, [{ counterpartyKey: grantCounterpartyKey(counterparty, null, null), amountSek: Math.abs(amountSek) }]),
  )
  const first = matched.length > 0 ? active.find((rule) => rule.id === matched[0].id) : undefined
  if (!first) return null
  return <AttnLine>{t('notice_registration', { block: blockCriteria(t, first), others: matched.length - 1 })}</AttnLine>
}
