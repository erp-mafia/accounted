import { postingEvidence } from '@/lib/core/bookkeeping/year-end-business-events'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import type { BusinessEventCategory } from '@/lib/posting/categories'
import { mappingVersion } from '@/lib/posting/mapping-version'
import type { BusinessEventDraft } from '@/lib/posting/types'
import type { DispositionKind } from './types'

/**
 * The business event of a bokslutsdisposition posted from the year-end
 * wizard (kind year_end.closing, the kind its source type year_end names),
 * for the posting port: recorded while POSTING_EVENTS is shadow or strict,
 * never built while it is off. Pure.
 *
 * The category says which act it was, without reading an account: the
 * periodiseringsfond, the överavskrivningar and the bolagsskatt file under
 * se.closing.appropriations (the year-end family, BAS 88xx and 89xx), the
 * särskild löneskatt on pension costs under expense.personnel. The subject
 * is the fiscal period closed, dated its last day; the amount is the
 * proposal's, a SEK magnitude. No party.
 */
export function yearEndDispositionBusinessEvent(args: {
  disposition: DispositionKind
  fiscalPeriodId: string
  periodEnd: string
  amount: number
  linkBasis: LinkBasisColumns
}): BusinessEventDraft {
  const category: BusinessEventCategory = args.disposition === 'sarskild_loneskatt' ? 'expense.personnel' : 'se.closing.appropriations'
  const amount = Math.abs(args.amount)
  return {
    kind: 'year_end.closing',
    category,
    occurredOn: args.periodEnd,
    subject: { type: 'fiscal_period', id: args.fiscalPeriodId },
    currency: 'SEK',
    amount,
    amountSek: amount,
    ...postingEvidence(args.linkBasis),
    mappingVersion: mappingVersion('yearEndDispositions'),
    jurisdiction: 'SE',
  }
}
