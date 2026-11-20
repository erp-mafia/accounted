'use client'

import { useTranslations } from 'next-intl'
import { reverseChargeBoxDispute, whyKeyFor, type BookingProposal } from '@/lib/bookkeeping/proposal'

/**
 * The one-line why behind a proposal, in the viewer's language: the same
 * words on the review header, under the drawer's chip and on the Bokförd
 * toast of a booking that skipped the review. A proposal the assistant's
 * read puts in another reverse-charge box says so, which is why its Bokför
 * opens the review (accounted#37).
 */
export function useProposalWhy(): (p: BookingProposal) => string {
  const t = useTranslations('tx_quick_review')
  return (p) => {
    const why = whyKeyFor(p)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = t(why.key as any, why.values)
    return reverseChargeBoxDispute(p) ? `${text} · ${t('rec_why_box_disputed')}` : text
  }
}
