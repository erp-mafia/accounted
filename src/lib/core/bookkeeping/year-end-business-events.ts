import { resolveLinkBasis, type LinkBasisColumns } from '@/lib/links/link-basis'
import { mappingVersion } from '@/lib/posting/mapping-version'
import type { BusinessEventTaxAmount } from '@/lib/posting/store'
import type { BusinessEventDraft } from '@/lib/posting/types'

/**
 * The business events of the year-end close's verifikat, for the posting port
 * (step 2g): the bokslutsverifikation and the kontantmetod cut-off
 * (year_end.closing), the ingående balans (ledger.opening_balance), the
 * omföring of föregående års resultat (year_end.result_appropriated) and the
 * stornos the close and the cut-off make of their own verifikat when a later
 * step fails (ledger.storno). Pure: built only while POSTING_EVENTS is shadow
 * or strict, never while it is off.
 *
 * Each closes, opens or carries a fiscal year, so the subject is that fiscal
 * period (the typed handle fiscal_period): the year closed for the
 * bokslutsverifikation and each kontantmetod carry (whose verifikat name it
 * as source_id), the year opened for the ingående balans and the omföring.
 * No party: a year-end act has no counterparty (a carry's invoice, and with
 * it the party, is named by the invoice's own link to the verifikat). No
 * category: none of these says what money was spent on. Amounts are SEK
 * magnitudes: årets resultat moved to the closing account, the result
 * carried by the omföring, the fordran or skuld a carry puts on the balance
 * sheet; the ingående balans carries balances, not an amount.
 */

/**
 * What the door saw, resolved in its own request: its link basis
 * (linkBasisColumns, which reads the approval being committed). The kernel
 * may not read the approval scope itself (the kernel-import guard), so the
 * doors hand it down, as a function the port calls only while it is on.
 */
export interface YearEndPostingContext {
  linkBasis?: LinkBasisColumns
}

/** The evidence and pending operation of an event from the door's link basis. */
export function postingEvidence(linkBasis: LinkBasisColumns | undefined): Pick<BusinessEventDraft, 'evidence' | 'pendingOperationId'> {
  const linkEvidence = linkBasis?.link_evidence ?? null
  return {
    evidence: { link_basis: linkBasis?.link_basis, link_evidence: linkEvidence ?? undefined },
    pendingOperationId: linkEvidence?.pending_operation_id ?? null,
  }
}

/**
 * The basis of a verifikat the close makes on its own, a storno after a
 * failed step: system_derived (nobody chose it), naming the door's approval
 * as evidence when the close runs inside one.
 */
export function systemDerivedLinkBasis(context: YearEndPostingContext | undefined): LinkBasisColumns {
  return resolveLinkBasis('system_derived', undefined, {
    pendingOperationId: context?.linkBasis?.link_evidence?.pending_operation_id ?? null,
  })
}

/** The bokslutsverifikation (kind year_end.closing): every result account onto the form's closing account. */
export function yearEndClosingBusinessEvent(args: {
  fiscalPeriodId: string
  periodEnd: string
  /** Årets resultat as the closing account receives it, signed (a loss is negative). */
  netResult: number
  linkBasis?: LinkBasisColumns
}): BusinessEventDraft {
  const amount = Math.abs(args.netResult)
  return {
    kind: 'year_end.closing',
    category: null,
    occurredOn: args.periodEnd,
    subject: { type: 'fiscal_period', id: args.fiscalPeriodId },
    currency: 'SEK',
    amount,
    amountSek: amount,
    ...postingEvidence(args.linkBasis),
    mappingVersion: mappingVersion('yearEndClosing'),
    jurisdiction: 'SE',
  }
}

/**
 * The ingående balans (kind ledger.opening_balance), dated the opened year's
 * first day. `id` is fixed by the caller so the per-account retry after a
 * refused project split links to the event its first attempt recorded.
 */
export function openingBalanceBusinessEvent(args: {
  id: string
  fiscalPeriodId: string
  periodStart: string
  linkBasis?: LinkBasisColumns
}): BusinessEventDraft {
  return {
    id: args.id,
    kind: 'ledger.opening_balance',
    category: null,
    occurredOn: args.periodStart,
    subject: { type: 'fiscal_period', id: args.fiscalPeriodId },
    ...postingEvidence(args.linkBasis),
    mappingVersion: mappingVersion('openingBalance'),
    jurisdiction: 'SE',
  }
}

/** The omföring of föregående års resultat (kind year_end.result_appropriated), dated the opened year's first day. */
export function resultAppropriationBusinessEvent(args: {
  fiscalPeriodId: string
  periodStart: string
  amount: number
  linkBasis?: LinkBasisColumns
}): BusinessEventDraft {
  return {
    kind: 'year_end.result_appropriated',
    category: null,
    occurredOn: args.periodStart,
    subject: { type: 'fiscal_period', id: args.fiscalPeriodId },
    currency: 'SEK',
    amount: args.amount,
    amountSek: args.amount,
    ...postingEvidence(args.linkBasis),
    mappingVersion: mappingVersion('resultAppropriation'),
    jurisdiction: 'SE',
  }
}

/**
 * One kontantmetod carry verifikat (kind year_end.closing): the årsomföring
 * of one invoice open at the year end, dated the year's last day (#3440, one
 * verifikat per invoice, no vändning). Its amount is the fordran (1510) or
 * skuld (2440) the carry puts on the balance sheet, moms included, and its
 * tax amounts the moms the carry books: under bokslutsmetoden the moms on an
 * invoice unpaid at the year end is declared in the year's last VAT period,
 * once (the year-2 payment only clears 1510 / 2440). A manual carry
 * (`manualLines`: lines the accountant wrote) names no rule version.
 */
export function kontantmetodCutoffBusinessEvent(args: {
  fiscalPeriodId: string
  occurredOn: string
  amount: number
  taxAmounts: BusinessEventTaxAmount[]
  manualLines?: boolean
  linkBasis?: LinkBasisColumns
}): BusinessEventDraft {
  return {
    kind: 'year_end.closing',
    category: null,
    occurredOn: args.occurredOn,
    subject: { type: 'fiscal_period', id: args.fiscalPeriodId },
    currency: 'SEK',
    amount: args.amount,
    amountSek: args.amount,
    taxAmounts: args.taxAmounts,
    ...postingEvidence(args.linkBasis),
    mappingVersion: args.manualLines ? null : mappingVersion('kontantmetodCutoff'),
    jurisdiction: 'SE',
  }
}

/**
 * A storno the close or the cut-off makes of its own verifikat after a later
 * step failed (kind ledger.storno, linked with role reversal), dated the day
 * it is made. No amount and no rule version: a storno mirrors its original's
 * lines.
 */
export function yearEndStornoBusinessEvent(args: {
  fiscalPeriodId: string
  occurredOn: string
  linkBasis: LinkBasisColumns
}): BusinessEventDraft {
  return {
    kind: 'ledger.storno',
    category: null,
    occurredOn: args.occurredOn,
    subject: { type: 'fiscal_period', id: args.fiscalPeriodId },
    ...postingEvidence(args.linkBasis),
    jurisdiction: 'SE',
  }
}
