'use client'

import { useTranslations } from 'next-intl'
import { whyKeyFor, type BookingProposal } from '@/lib/bookkeeping/proposal'

/**
 * The one-line why behind a proposal, in the viewer's language: the same
 * words on the review header, under the drawer's chip and on the Bokförd
 * toast of a booking that skipped the review.
 */
export function useProposalWhy(): (p: BookingProposal) => string {
  const t = useTranslations('tx_quick_review')
  return (p) => {
    const why = whyKeyFor(p)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return t(why.key as any, why.values)
  }
}
