import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { mappingVersion } from '@/lib/posting/mapping-version'
import type { BusinessEventDraft } from '@/lib/posting/types'
import type { SetoffPlan } from './plan'

/**
 * A set-off's business event for the posting port (counterparty.set_off),
 * dated its verifikat: the customer invoice is the subject (the supplier
 * invoice is the other side of the same act, named on the set-off row), the
 * counterparty the party, the amount what the two debts settle. No VAT: a
 * set-off moves none. SEK only (the planner refuses another currency). Built
 * only while POSTING_EVENTS is on.
 */
export function counterpartySetoffBusinessEvent(plan: SetoffPlan, linkBasis: LinkBasisColumns): BusinessEventDraft {
  return {
    kind: 'counterparty.set_off',
    category: null,
    occurredOn: plan.setoffDate,
    subject: { type: 'invoice', id: plan.invoice.id },
    party: { type: 'party', id: plan.partyId },
    currency: 'SEK',
    amount: plan.amount,
    amountSek: plan.amount,
    taxAmounts: [],
    evidence: { link_basis: linkBasis.link_basis },
    mappingVersion: mappingVersion('counterpartySetoff'),
    jurisdiction: 'SE',
  }
}
