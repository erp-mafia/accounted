'use client'

import { useTranslations } from 'next-intl'
import { reverseChargeBoxDispute, whyKeyFor, type BookingProposal } from '@/lib/bookkeeping/proposal'

/**
 * The one-line why behind a proposal, in the viewer's language: the same
 * words on the review header, under the drawer's chip and on the Bokförd
 * toast of a booking that skipped the review. A proposal the assistant's
 * read puts in another reverse-charge box says so, which is why its Bokför
 * opens the review (accounted#37). So does a learned pair whose
 * reverse-charge box nothing confirms (reverse_charge_box_unconfirmed), and
 * a learned counterpart whose moms is no one rate (vat_unknown): it books no
 * moms of its own, so the underlag's moms is stated in the review.
 */
export function useProposalWhy(): (p: BookingProposal) => string {
  const t = useTranslations('tx_quick_review')
  return (p) => {
    const why = whyKeyFor(p)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = t(why.key as any, why.values)
    if (p.vat_unknown) return `${text} · ${t('rec_why_vat_unknown')}`
    if (reverseChargeBoxDispute(p)) return `${text} · ${t('rec_why_box_disputed')}`
    return p.reverse_charge_box_unconfirmed ? `${text} · ${t('rec_why_box_unconfirmed')}` : text
  }
}
