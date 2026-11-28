import { getTemplateById, type BookingTemplate, type TemplateGroup } from './booking-templates'
import { PINNED_JURISDICTION, resolveAccountRole } from './account-roles'
import { isCashLedger } from './bank-leg'
import { isLibraryTemplateId } from './template-library'
import { resolveTemplateAccountsForEntity } from './proposal-lines'
import type { SkattekontoLedgerAccount } from '@/lib/skatteverket/skattekonto-account'
import { accountHue, templateGroupHue, type TemplateHue } from './template-group-colors'
import { getDefaultAccountForCategory, getDefaultVatTreatmentForCategory } from './category-mapping'
import { groupForAccount } from './template-groups'
import { formatCurrency } from '@/lib/utils'
import {
  DEFAULT_REVERSE_CHARGE_KIND,
  REVERSE_CHARGE_TREATMENT_KINDS,
  reverseChargeKindForBasisAccount,
  reverseChargeKindForSupplierType,
  reverseChargeKindRuta,
  type ReverseChargeKind,
} from './vat-entries'
import type {
  CategorizationTemplate,
  EntityType,
  LinePatternEntry,
  TransactionCategory,
  VatTreatment,
} from '@/types'

/**
 * One booking proposal, whoever made it.
 *
 * Every source that can say how a transaction books (a rule that matched,
 * a learned counterpart, the catalog's keywords, the assistant's read, or
 * the person picking) produces this object, and every surface consumes it:
 * the row chip, the review dialog's header and verifikat preview, the
 * row's direct booking, the assistant's candidate slate, and the MCP
 * suggestion tool. `booking` is the one field that decides how it posts;
 * it is exactly one of the shapes the categorize API accepts, so a
 * proposal is always bookable as shown.
 *
 * 'precedent' is how the company last booked a bank row of the same
 * counterparty, read from the posted verifikat where no counterparty rule
 * proposes (lib/transactions/booking-precedent.ts): one account against the
 * bank, with seen_count the earlier bookings that agree. It is no rule, and
 * never books without a review.
 *
 * Client-safe: pure data and pure functions over the static catalog.
 */
export type ProposalSource = 'rule' | 'recent' | 'catalog' | 'counterparty' | 'assistant' | 'manual' | 'clearing' | 'precedent'

/**
 * What a clearing proposal (source 'clearing') rests on: another block's own
 * record that this money was already booked onto a clearing account, so the
 * bank row clears that account instead of being booked as revenue again
 * (lib/transactions/clearing-proposals.ts). The till: card and Swish on the
 * day voucher (lib/pos-sales/payout-match.ts); a webshop's payment provider:
 * one payout of the orders it collected (WebshopPayoutEvidence).
 */
export type ClearingEvidence = PosClearingEvidence | WebshopPayoutEvidence

/**
 * A payment provider's payout (Kustom, Shopify Payments): the orders booked
 * the sales on the clearing account, and the payout settles them net of the
 * provider's fees (lib/webshop-orders/payout-proposals.ts).
 */
export interface WebshopPayoutEvidence {
  channel: 'webshop'
  kind: 'payout'
  fit: 'payout'
  /** The provider as people know it: Kustom, Shopify Payments. */
  provider: string
  /** The payout reference the provider prints, when it gives one. */
  reference: string | null
  /** The clearing account the verifikat credits. */
  account: string
  /** The payout day. */
  business_dates: string[]
  /** The net payout: the bank row's amount. */
  expected_amount: number
  /** The provider's fees and the VAT on them, as the verifikat books them. */
  fees: number
  fee_vat: number
  /** The clearing account's credit: net + fees + fee VAT. */
  clearing_amount: number
}

export interface PosClearingEvidence {
  /** The block whose record it is. */
  channel: 'pos'
  /** How the money was paid. */
  kind: 'swish' | 'card'
  /**
   * receipt: one Swish receipt, to the öre; days: the card tender of one to
   * three business days; balance: the open card balance up to a day.
   */
  fit: 'receipt' | 'days' | 'balance'
  /** The clearing account the row books against. */
  account: string
  /** The business days the money was taken on, ascending (fit balance: every day it pays off). */
  business_dates: string[]
  /** fit receipt: the receipt number as printed. */
  receipt_number?: string
  /** What the record says arrives: the receipt, the days' card tender, the open balance. */
  expected_amount: number
}

export type ProposalBooking =
  /** A catalog template: the server books the template's lines (entity-resolved). */
  | { kind: 'template'; template_id: string; category: TransactionCategory }
  /** A learned counterpart rule: the server books the stored template's lines. */
  | { kind: 'counterparty'; counterparty_template_id: string }
  /**
   * One business account and an explicit VAT treatment against the bank.
   * `reverse_charge_kind` names the basis box of a reverse-charge purchase
   * (ruta 20/21/22); without it the engine books an EU service.
   */
  | {
      kind: 'account'
      account: string
      vat_treatment: VatTreatment
      category: TransactionCategory
      reverse_charge_kind?: ReverseChargeKind
      /**
       * A clearing proposal whose record states the whole verifikat (a
       * payout: the bank net, the provider's fees, `account` gross): the
       * booking sends it back and the proposer books those lines.
       */
      clearing_ref?: { proposer: string; ref: string }
    }

export interface BookingProposal {
  /** Stable id: the catalog template id, 'cp:<uuid>' for a counterpart, 'assistant:<txid>', 'account:<n>'. */
  template_id: string
  source: ProposalSource
  booking: ProposalBooking
  name_sv: string
  name_en: string
  group: string
  /** The two legs as the source states them: the chip's hue and the simple preview read these. */
  debit_account: string
  credit_account: string
  confidence: number
  description_sv: string
  risk_level: string
  requires_review: boolean
  line_pattern?: LinePatternEntry[] | null
  vat_treatment?: VatTreatment | null
  default_dimensions?: Record<string, string> | null
  /** Evidence: what the why line and the direct-booking policy read. */
  seen_count?: number
  rule_mode?: CategorizationTemplate['mode']
  rule_own?: boolean
  rule_requires_review?: boolean
  /** A learned counterpart rule a person set to always ask (categorization_templates.always_review). */
  rule_always_review?: boolean
  /**
   * A learned counterpart rule from an imported history (source 'sie_import')
   * that no booking here has confirmed yet: it asks once
   * (lib/transactions/direct-booking.ts ruleReviewFlags).
   */
  rule_import_unconfirmed?: boolean
  /**
   * A booking review rule of the company matches this booking of the row
   * (lib/booking-review, accounted#130 step 2): it is never booked without
   * a person's review, on any path. Set by proposeForTransactions.
   */
  review_blocked?: boolean
  has_underlag?: boolean
  /**
   * A weak learned-counterpart match that the assistant's stored read had on
   * its slate and booked on another account (lib/transactions/propose.ts).
   * Still offered in the picker and to an agent, never the row's
   * recommendation and never booked without a review.
   */
  contested?: boolean
  /**
   * A learned counterpart matched on money moving against its learned
   * direction (contradictsLearnedDirection in counterparty-templates.ts):
   * money in from a counterpart booked as a cost, likely a refund or credit.
   * The legs are shown mirrored, as the booking mirrors them, and it never
   * books without a review (crm#1598).
   */
  direction_mismatch?: boolean
  /**
   * The box the assistant's fresh read reports this reverse-charge purchase
   * in, set only when it is not a box the proposal books (ruta 22 read,
   * ruta 21 learned: accounted#37). Which box is right depends on the
   * company that invoices, which is on the invoice, not in the history or
   * the bank text. Also set on a purchase the proposal books with Swedish
   * ingående moms when the read says the seller is abroad (crm#1498): a
   * seller abroad charges no Swedish moms unless the invoice shows it. Never
   * booked without a review; the review opens on the read's box with the
   * proposal's one click away.
   */
  read_reverse_charge_kind?: ReverseChargeKind
  /**
   * A learned counterpart of one pair that books reverse charge in the box it
   * replays by default (ruta 21, an EU service), which neither its cost
   * account nor the company's posted bookings of the counterparty confirm
   * (lib/transactions/reverse-charge-box-evidence.ts). Ruta 22 is a seller
   * outside the EU, and the pair never learned where the seller is, so it is
   * never booked without a review.
   */
  reverse_charge_box_unconfirmed?: boolean
  /**
   * A learned counterpart whose bookings carried moms that is no one Swedish
   * rate of the net, such as a mixed invoice's (hasUnknownVat in
   * counterparty-templates.ts). It books no moms of its own, so the
   * underlag's moms is stated in a review: it is never booked without one,
   * and never offered as momsfri.
   */
  vat_unknown?: boolean
  /** Source 'clearing': the record behind it. Never booked without a review. */
  clearing?: ClearingEvidence
  /**
   * Set on the assistant's proposal for a row that one of the company's
   * auto-learned mapping rows would have proposed for, where those rows are
   * not read (lib/bookkeeping/mapping-engine.ts readsAutoLearnedMappingRules):
   * the read stands where the rule stood, and never books without a review.
   * Set by proposeForTransactions.
   */
  replaces_learned_rule?: boolean
}

/** The leg that is not the bank: what the chip, the assistant and Claude call "the account". */
export function businessAccount(p: Pick<BookingProposal, 'debit_account' | 'credit_account'>): string {
  return p.debit_account.startsWith('19') ? p.credit_account : p.debit_account
}

/**
 * The account a proposal stands for on the assistant's candidate slate: the
 * first business line of a learned pattern, otherwise the leg that is not the
 * bank.
 */
export function slateAccount(p: Pick<BookingProposal, 'debit_account' | 'credit_account' | 'line_pattern'>): string {
  return p.line_pattern?.find((l) => l.type === 'business')?.account ?? businessAccount(p)
}

export function proposalHue(p: BookingProposal): TemplateHue {
  return p.booking.kind === 'template' ? templateGroupHue(p.group as TemplateGroup) : accountHue(businessAccount(p))
}

/** A catalog template as a proposal. Library templates (no catalog entry server-side) book as their account. */
export function proposalFromTemplate(
  template: BookingTemplate,
  source: ProposalSource,
  confidence = 1,
): BookingProposal {
  const booking: ProposalBooking = isLibraryTemplateId(template.id)
    ? {
        kind: 'account',
        account: businessAccount(template),
        vat_treatment: template.vat_treatment ?? 'exempt',
        category: template.fallback_category,
      }
    : { kind: 'template', template_id: template.id, category: template.fallback_category }
  return {
    template_id: template.id,
    source,
    booking,
    name_sv: template.name_sv,
    name_en: template.name_en,
    group: template.group,
    debit_account: template.debit_account,
    credit_account: template.credit_account,
    confidence,
    description_sv: template.description_sv,
    risk_level: template.risk_level,
    requires_review: template.requires_review,
    vat_treatment: template.vat_treatment,
  }
}

/** One account against the bank: the assistant's pick, or an account the person chose. */
export function accountProposal(input: {
  id: string
  source: ProposalSource
  account: string
  label: string
  category: TransactionCategory
  vat_treatment: VatTreatment | null
  reverse_charge_kind?: ReverseChargeKind | null
  amount: number
  confidence?: number
  description?: string
  has_underlag?: boolean
}): BookingProposal {
  const vat = input.vat_treatment ?? getDefaultVatTreatmentForCategory(input.category) ?? 'exempt'
  return {
    template_id: input.id,
    source: input.source,
    booking: {
      kind: 'account',
      account: input.account,
      vat_treatment: vat,
      category: input.category,
      ...kindFor(vat, input.reverse_charge_kind),
    },
    name_sv: input.label,
    name_en: input.label,
    group: 'account',
    debit_account: input.amount < 0 ? input.account : '1930',
    credit_account: input.amount < 0 ? '1930' : input.account,
    confidence: input.confidence ?? 1,
    description_sv: input.description ?? '',
    risk_level: 'LOW',
    requires_review: false,
    vat_treatment: vat,
    has_underlag: input.has_underlag,
  }
}

/**
 * The rate a proposal whose moms is unknown (vat_unknown) opens its review
 * with. Not a reading of the moms: a rate-based moms line is what the review
 * replaces with the underlag's moms (applyVatAmountOverride), and the person
 * states the moms before it books (booksWithoutReview). Proposed without
 * one, the row booked as if it carried no moms.
 */
export const UNKNOWN_VAT_REVIEW_TREATMENT = 'standard_25' as const satisfies VatTreatment

/**
 * An account proposal whose moms is unknown: booked through a review with the
 * underlag's moms (UNKNOWN_VAT_REVIEW_TREATMENT), never with none and never
 * without a person.
 */
export function withUnknownVat(p: BookingProposal): BookingProposal {
  if (p.booking.kind !== 'account') return p
  const { reverse_charge_kind: _box, ...booking } = p.booking
  return {
    ...p,
    booking: { ...booking, vat_treatment: UNKNOWN_VAT_REVIEW_TREATMENT },
    vat_treatment: UNKNOWN_VAT_REVIEW_TREATMENT,
    requires_review: true,
    vat_unknown: true,
  }
}

/** The basis box travels only with the treatment it belongs to. */
function kindFor(
  vat: VatTreatment,
  kind: ReverseChargeKind | null | undefined,
): { reverse_charge_kind?: ReverseChargeKind } {
  return vat === 'reverse_charge' && kind ? { reverse_charge_kind: kind } : {}
}

/**
 * The basis boxes a bank booking can name (the categorize body's
 * reverse_charge_kind), in momsdeklaration order: goods from another EU
 * country (ruta 20, 4515), services from another EU country (ruta 21, 4535),
 * services from outside the EU (ruta 22, 4531).
 */
export const PROPOSAL_REVERSE_CHARGE_KINDS: readonly ReverseChargeKind[] = Object.values(REVERSE_CHARGE_TREATMENT_KINDS)

/**
 * The basis box a proposal's reverse charge names: an account booking's
 * reverse_charge_kind, or what a catalog template's supplier type books
 * (it_saas_non_eu is ruta 22). Undefined when it is no reverse charge or names
 * none (the server then books an EU service), and for a box a bank booking
 * cannot name.
 */
export function reverseChargeKindOf(p: BookingProposal): ReverseChargeKind | undefined {
  if (p.booking.kind === 'account') {
    return p.booking.vat_treatment === 'reverse_charge' ? p.booking.reverse_charge_kind : undefined
  }
  const template = templateBehind(p)
  if (template?.vat_treatment !== 'reverse_charge' || !template.reverse_charge_supplier_type) return undefined
  const kind = reverseChargeKindForSupplierType(template.reverse_charge_supplier_type)
  return PROPOSAL_REVERSE_CHARGE_KINDS.includes(kind) ? kind : undefined
}

/** The offset leg of a learned basis pair: 4598, or a company's own 4599 (patternReplayPlan). */
const RC_BASIS_OFFSET = /^4[45]9\d$/

/**
 * The boxes a proposal reports its reverse-charge basis in (ruta 20-24), as
 * its booking posts them: a learned pattern's basis accounts (4515, 4535,
 * 4531 and so on). Otherwise the cost account itself when it is a basis
 * account, else the box the booking names (an account booking's
 * reverse_charge_kind, a catalog template's supplier type), else EU
 * services, the engine's default: a counterpart learned as one pair stores
 * no supplier country, so its box was never learned. Empty when the proposal
 * books no reverse charge. A cost account whose own momskod is a
 * reverse-charge purchase settles its box at booking
 * (reconcileRcBasisWithChart) and is not seen here.
 */
export function reverseChargeBoxesOf(p: BookingProposal): ReverseChargeKind[] {
  if (p.booking.kind === 'counterparty' && p.line_pattern && p.line_pattern.length > 0) {
    const kinds = p.line_pattern
      .filter((l) => l.type === 'business')
      .map((l) => reverseChargeKindForBasisAccount(l.account)?.kind)
      .filter((k): k is ReverseChargeKind => !!k)
    return [...new Set(kinds)]
  }
  const template = templateBehind(p)
  const vat = p.booking.kind === 'account' ? p.booking.vat_treatment : (template?.vat_treatment ?? p.vat_treatment)
  if (vat !== 'reverse_charge') return []
  const own = reverseChargeKindForBasisAccount(p.booking.kind === 'account' ? p.booking.account : businessAccount(p))
  if (own) return [own.kind]
  if (p.booking.kind === 'account') return [p.booking.reverse_charge_kind ?? DEFAULT_REVERSE_CHARGE_KIND]
  if (template?.reverse_charge_supplier_type) return [reverseChargeKindForSupplierType(template.reverse_charge_supplier_type)]
  return [DEFAULT_REVERSE_CHARGE_KIND]
}

/**
 * What a proposal books on a purchase, as a reverse-charge dispute names it:
 * one of the reverse-charge boxes, or 'swedish_vat' for ingående moms at a
 * Swedish rate (2641, ruta 48).
 */
export type DisputedVat = ReverseChargeKind | 'swedish_vat'

const SWEDISH_INPUT_VAT_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'input_vat')
const SWEDISH_RATES: ReadonlySet<VatTreatment> = new Set<VatTreatment>(['standard_25', 'reduced_12', 'reduced_6'])

/**
 * True when the proposal books a purchase with Swedish ingående moms: a
 * learned pattern's debit moms line on 2641, otherwise a Swedish rate as the
 * booking's treatment. Money in (the bank on the debit leg) is never one.
 */
export function booksSwedishInputVat(p: BookingProposal): boolean {
  if (isCashLedger(p.debit_account)) return false
  if (p.booking.kind === 'counterparty' && p.line_pattern && p.line_pattern.length > 0) {
    return p.line_pattern.some((l) => l.type === 'vat' && l.side === 'debit' && l.account === SWEDISH_INPUT_VAT_ACCOUNT)
  }
  const template = templateBehind(p)
  const vat = p.booking.kind === 'account' ? p.booking.vat_treatment : (template?.vat_treatment ?? p.vat_treatment)
  return !!vat && SWEDISH_RATES.has(vat)
}

/**
 * The box a proposal books and the one the assistant's read names, when the
 * two differ (read_reverse_charge_kind, accounted#37); null otherwise. A
 * proposal that books Swedish moms where the read names a reverse-charge
 * box disputes as 'swedish_vat' (crm#1498).
 */
export function reverseChargeBoxDispute(
  p: BookingProposal,
): { proposal: DisputedVat; read: ReverseChargeKind } | null {
  const read = p.read_reverse_charge_kind
  if (!read) return null
  const boxes = reverseChargeBoxesOf(p)
  if (boxes.length === 0) return booksSwedishInputVat(p) ? { proposal: 'swedish_vat', read } : null
  const own = boxes.find((k) => k !== read)
  return own ? { proposal: own, read } : null
}

/**
 * The proposal with its reverse charge in another box, as the review offers
 * it when the read disagrees on the box (accounted#37): one account against
 * the bank on the proposal's own cost account. What says where it came from
 * (source, why, the counterpart's count) stays, so the review still names it
 * and the row does not take it for the person's own choice. Null when the
 * booking has several cost lines, which one account cannot carry.
 */
export function inReverseChargeBox(
  p: BookingProposal,
  kind: ReverseChargeKind,
  amount: number,
  entityType?: EntityType,
): BookingProposal | null {
  const cost = singleCostLine(p, entityType)
  if (!cost) return null
  const category =
    p.booking.kind === 'counterparty' ? categoryFallback(amount) : carriedCategory(p.booking.category, cost.account, amount)
  const dims = p.default_dimensions ?? cost.dimensions ?? null
  return {
    ...p,
    booking: { kind: 'account', account: cost.account, vat_treatment: 'reverse_charge', category, reverse_charge_kind: kind },
    debit_account: amount < 0 ? cost.account : '1930',
    credit_account: amount < 0 ? '1930' : cost.account,
    line_pattern: null,
    vat_treatment: 'reverse_charge',
    default_dimensions: dims && Object.keys(dims).length > 0 ? dims : null,
    read_reverse_charge_kind: undefined,
  }
}

/** The one account a proposal books its cost on, beside any basis pair; null for several. */
function singleCostLine(
  p: BookingProposal,
  entityType?: EntityType,
): { account: string; dimensions?: Record<string, string> } | null {
  if (p.booking.kind === 'account') return { account: p.booking.account }
  if (p.booking.kind === 'template') {
    const t = templateBehind(p)
    if (!t) return null
    const a = resolveTemplateAccountsForEntity(t, entityType)
    return {
      account: businessAccount({
        debit_account: a.debitAccount ?? t.debit_account,
        credit_account: a.creditAccount ?? t.credit_account,
      }),
    }
  }
  if (!p.line_pattern || p.line_pattern.length === 0) return { account: businessAccount(p) }
  const costs = p.line_pattern.filter(
    (l) => l.type === 'business' && !reverseChargeKindForBasisAccount(l.account) && !RC_BASIS_OFFSET.test(l.account),
  )
  return costs.length === 1 ? { account: costs[0].account, dimensions: costs[0].dimensions } : null
}

/** The box's number as the momsdeklaration prints it: '21' for ruta 21. */
export function reverseChargeBoxNumber(kind: ReverseChargeKind): string {
  return reverseChargeKindRuta(kind).replace('ruta', '')
}

/**
 * The booking after the person set its account or VAT in the review: one
 * account against the bank, and theirs from here on (source 'manual': Din
 * kontering, Vald av dig). What the proposal it replaces said about itself
 * (its why, its confidence, the rule or read behind it) does not describe
 * this booking and is left behind: the header kept naming the machine's
 * pick over an account the person had changed, and nothing could tell the
 * two apart when the review closed (PostHog 170). `label` names the account
 * the person picked; a VAT change alone keeps the name.
 * A reverse charge keeps its basis box: the one the booking has across an
 * account change, otherwise `lastKind`, the box the review last held, so a
 * person who leaves reverse charge and picks it again gets the box back
 * (ruta 22 stays ruta 22) instead of the EU-service default (accounted#35).
 */
export function withAccount(
  p: BookingProposal,
  account: string,
  vat_treatment: VatTreatment,
  amount: number,
  label?: string,
  lastKind?: ReverseChargeKind | null,
): BookingProposal {
  return personsBooking(p, account, vat_treatment, amount, label, reverseChargeKindOf(p) ?? lastKind)
}

/**
 * The person's pick of the box a reverse-charge purchase reports its basis
 * in (ruta 20, 21 or 22), on the account the booking has: the review's
 * correction of a box the proposal got wrong (accounted#35).
 */
export function withReverseChargeKind(p: BookingProposal, kind: ReverseChargeKind, amount: number): BookingProposal {
  const account = p.booking.kind === 'account' ? p.booking.account : businessAccount(p)
  return personsBooking(p, account, 'reverse_charge', amount, undefined, kind)
}

function personsBooking(
  p: BookingProposal,
  account: string,
  vat_treatment: VatTreatment,
  amount: number,
  label: string | undefined,
  kind: ReverseChargeKind | null | undefined,
): BookingProposal {
  const category =
    p.booking.kind === 'counterparty' ? categoryFallback(amount) : carriedCategory(p.booking.category, account, amount)
  return {
    template_id: `account:${account}`,
    source: 'manual',
    booking: { kind: 'account', account, vat_treatment, category, ...kindFor(vat_treatment, kind) },
    name_sv: label ?? p.name_sv,
    name_en: label ?? p.name_en,
    group: 'account',
    debit_account: amount < 0 ? account : '1930',
    credit_account: amount < 0 ? '1930' : account,
    confidence: 1,
    description_sv: '',
    risk_level: 'LOW',
    requires_review: false,
    vat_treatment,
    default_dimensions: p.default_dimensions,
  }
}

function categoryFallback(amount: number): TransactionCategory {
  return amount < 0 ? 'expense_other' : 'income_other'
}

/**
 * The category a booking keeps when someone names another account for it:
 * the person in the review, or the assistant's pick taken over the proposal
 * shown. An expense or income category carries over, it only says which way
 * the row books. 'private' (and 'uncategorized') does not, unless the new
 * account is a balance-sheet one: the category path books those without a
 * moms line whatever VAT treatment rides along (getCategoryAccountMapping),
 * in the preview and on the server alike. A cost account set by hand over
 * the assistant's "private" pick was therefore booked without the moms its
 * underlag states, while the review said 25 % (PostHog 170).
 */
export function carriedCategory(category: TransactionCategory, account: string, amount: number): TransactionCategory {
  const booksMoms = category.startsWith('expense_') || category.startsWith('income_')
  if (booksMoms || account.startsWith('2')) return category
  return categoryFallback(amount)
}

/** The body POST /api/transactions/[id]/categorize books this proposal with. */
export function categorizeBodyFor(
  p: BookingProposal,
  extras: { dimensions?: Record<string, string>; vatAmount?: number; inboxItemId?: string } = {},
): {
  is_business: true
  category?: TransactionCategory
  template_id?: string
  counterparty_template_id?: string
  account_override?: string
  vat_treatment?: VatTreatment
  reverse_charge_kind?: ReverseChargeKind
  vat_amount?: number
  dimensions?: Record<string, string>
  inbox_item_id?: string
  proposal_id?: string
  clearing_ref?: { proposer: string; ref: string }
} {
  const dims = extras.dimensions && Object.keys(extras.dimensions).length > 0 ? { dimensions: extras.dimensions } : {}
  const vatAmount = extras.vatAmount != null ? { vat_amount: extras.vatAmount } : {}
  const inbox = extras.inboxItemId ? { inbox_item_id: extras.inboxItemId } : {}
  // Which suggestion the booking started from, for suggestion_log. A
  // proposal the person built themselves names none.
  const from = p.source === 'manual' ? {} : { proposal_id: p.template_id }
  switch (p.booking.kind) {
    case 'template':
      return { is_business: true, category: p.booking.category, template_id: p.booking.template_id, ...dims, ...vatAmount, ...inbox, ...from }
    case 'counterparty':
      return { is_business: true, counterparty_template_id: p.booking.counterparty_template_id, ...dims, ...inbox, ...from }
    case 'account':
      // A clearing record books its own lines: no override, no VAT treatment.
      if (p.booking.clearing_ref) {
        return { is_business: true, category: p.booking.category, clearing_ref: p.booking.clearing_ref, ...inbox, ...from }
      }
      return {
        is_business: true,
        category: p.booking.category,
        account_override: p.booking.account,
        vat_treatment: p.booking.vat_treatment,
        ...kindFor(p.booking.vat_treatment, p.booking.reverse_charge_kind),
        ...dims,
        ...vatAmount,
        ...inbox,
        ...from,
      }
  }
}

/** The catalog template behind a proposal, when it has one (rules text, AB accounts). */
export function templateBehind(p: BookingProposal): BookingTemplate | undefined {
  return p.booking.kind === 'template' ? getTemplateById(p.booking.template_id) : undefined
}

/** The i18n key (tx_quick_review) and values for the one-line why. */
export function whyKeyFor(p: BookingProposal): { key: string; values?: Record<string, string | number> } {
  switch (p.source) {
    case 'clearing':
      return clearingWhyKey(p)
    case 'rule':
      return { key: 'rec_why_rule' }
    case 'counterparty':
      return { key: p.direction_mismatch ? 'rec_why_counterparty_refund' : 'rec_why_counterparty', values: { count: p.seen_count ?? 1 } }
    case 'catalog':
      return { key: 'rec_why_catalog' }
    case 'recent':
      return { key: 'rec_why_recent' }
    case 'precedent':
      return { key: 'rec_why_precedent', values: { count: p.seen_count ?? 1 } }
    case 'assistant':
      return { key: p.has_underlag ? 'rec_why_assistant_doc' : 'rec_why_assistant_row' }
    default:
      return { key: 'rec_why_manual' }
  }
}

/** The category the categorize API books under for an account someone named. */
export function categoryForAccount(
  account: string,
  entityType?: EntityType,
  preferred?: TransactionCategory | null,
): TransactionCategory {
  if (preferred && preferred !== 'uncategorized') return preferred
  // Every representation account (avdragsgill or not) is the representation
  // category, not only the category's default: with the default 6072 a 6071
  // booking read as expense_other, and before it a 6072 one did, which also
  // let it past the grant refusal of representation (accounted#86).
  if (groupForAccount(account) === 'representation') return 'expense_representation'
  const candidates: TransactionCategory[] = [
    'expense_equipment', 'expense_software', 'expense_travel', 'expense_office', 'expense_marketing',
    'expense_professional_services', 'expense_representation', 'expense_consumables', 'expense_vehicle',
    'expense_telecom', 'expense_bank_fees', 'expense_currency_exchange', 'expense_other',
    'income_services', 'income_products', 'income_other',
  ]
  for (const c of candidates) {
    // The mapping needs a definite entity type; without one the sole trader
    // default is what the mapping itself used to assume.
    if (getDefaultAccountForCategory(c, entityType ?? 'enskild_firma') === account) return c
  }
  return account.startsWith('3') ? 'income_other' : 'expense_other'
}

/**
 * The proposal as the arguments an agent books it with through
 * categorize_transaction (category + account_override + vat_treatment):
 * the same booking the app makes, in the one shape that tool accepts.
 * Null for a counterpart pattern with several business lines, which only
 * the app's own booking can post as stored, and for a counterpart whose
 * moms is unknown (vat_unknown): no vat_treatment states it, and 'exempt'
 * would drop the moms the underlag states. The agent reads the underlag and
 * books its moms itself (vat_amount).
 */
export function agentBookingFor(
  p: BookingProposal,
  entityType?: EntityType,
  skattekontoAccount?: SkattekontoLedgerAccount,
): { category: TransactionCategory; account_override: string; vat_treatment: VatTreatment } | null {
  if (p.vat_unknown) return null
  if (p.booking.kind === 'account') {
    // A payout's verifikat is more than one account: booked from the app.
    if (p.booking.clearing_ref) return null
    return { category: p.booking.category, account_override: p.booking.account, vat_treatment: p.booking.vat_treatment }
  }
  if (p.booking.kind === 'template') {
    const t = getTemplateById(p.booking.template_id)
    if (!t) return null
    const accounts = resolveTemplateAccountsForEntity(t, entityType, skattekontoAccount)
    const resolved = { debit_account: accounts.debitAccount ?? t.debit_account, credit_account: accounts.creditAccount ?? t.credit_account }
    return { category: p.booking.category, account_override: businessAccount(resolved), vat_treatment: t.vat_treatment ?? 'exempt' }
  }
  const businessLines = (p.line_pattern ?? []).filter((l) => l.type === 'business')
  if (businessLines.length > 1) return null
  const account = businessLines[0]?.account ?? businessAccount(p)
  return { category: categoryForAccount(account, entityType), account_override: account, vat_treatment: p.vat_treatment ?? 'exempt' }
}

/** categorize_transaction's spelling of a reverse-charge basis box (vat_treatment 'reverse_charge_non_eu_services'). */
type CategorizeToolVatTreatment = VatTreatment | keyof typeof REVERSE_CHARGE_TREATMENT_KINDS

function toolVatTreatment(p: BookingProposal, vat: VatTreatment): CategorizeToolVatTreatment {
  // The box the proposal names: an account booking's, or a catalog
  // template's supplier type (it_saas_non_eu is ruta 22), which otherwise
  // reached the agent as plain reverse_charge and booked ruta 21.
  const kind = vat === 'reverse_charge' ? reverseChargeKindOf(p) : undefined
  const spelled = (Object.keys(REVERSE_CHARGE_TREATMENT_KINDS) as Array<keyof typeof REVERSE_CHARGE_TREATMENT_KINDS>).find(
    (k) => REVERSE_CHARGE_TREATMENT_KINDS[k] === kind,
  )
  return spelled ?? vat
}

/**
 * agentBookingFor plus the proposal's stable id: the arguments the MCP
 * suggestion tool hands an agent, so a booking made from them says which
 * suggestion it started from (recorded in suggestion_log, never booked).
 * A reverse charge that names its basis box is spelled the way
 * categorize_transaction takes it, so the agent's booking lands in the box
 * the proposal shows.
 */
export function categorizeArgsFor(
  p: BookingProposal,
  entityType?: EntityType,
  skattekontoAccount?: SkattekontoLedgerAccount,
): { category: TransactionCategory; account_override: string; vat_treatment: CategorizeToolVatTreatment; proposal_id: string } | null {
  const booking = agentBookingFor(p, entityType, skattekontoAccount)
  return booking
    ? { ...booking, vat_treatment: toolVatTreatment(p, booking.vat_treatment), proposal_id: p.template_id }
    : null
}

function clearingWhyKey(p: BookingProposal): { key: string; values?: Record<string, string | number> } {
  const e = p.clearing
  if (!e) return { key: 'rec_why_manual' }
  if (e.channel === 'webshop') {
    return {
      key: 'rec_why_clearing_payout',
      values: { provider: e.provider, date: e.business_dates[0] ?? '', fees: formatCurrency(e.fees), vat: formatCurrency(e.fee_vat), account: e.account },
    }
  }
  const dates = e.business_dates
  const last = dates[dates.length - 1] ?? ''
  if (e.fit === 'receipt') {
    return { key: 'rec_why_clearing_receipt', values: { receipt: e.receipt_number ?? '', date: last, account: e.account } }
  }
  if (e.fit === 'days') {
    return { key: 'rec_why_clearing_days', values: { count: dates.length, first: dates[0] ?? '', last, account: e.account } }
  }
  return { key: 'rec_why_clearing_balance', values: { date: last, account: e.account } }
}

/**
 * A clearing proposal's reason in Swedish: what the record says and why the
 * row books against the clearing account. The proposal's description, the
 * MCP tool's why and the assistant's candidate reason.
 */
export function clearingReasonSv(e: ClearingEvidence): string {
  if (e.channel === 'webshop') {
    const reference = e.reference ? ` ${e.reference}` : ''
    const vat = e.fee_vat > 0 ? ` och ${formatCurrency(e.fee_vat)} moms på avgifterna, som dras av mot ${e.provider}s faktura för dem` : ''
    return (
      `Utbetalning från ${e.provider}${reference} ${e.business_dates[0] ?? ''}, som stämmer på öret. ` +
      `Försäljningen bokförs från ordrarna mot ${e.account}, så utbetalningen bokförs mot ${e.account} med ${formatCurrency(e.clearing_amount)}: ` +
      `bankens ${formatCurrency(e.expected_amount)} plus ${formatCurrency(e.fees)} i avgifter${vat}.`
    )
  }
  const dates = e.business_dates
  const first = dates[0] ?? ''
  const last = dates[dates.length - 1] ?? ''
  const what =
    e.fit === 'receipt'
      ? `Swish-betalning som stämmer på öret med kvitto ${e.receipt_number ?? ''} i kassan ${last}`
      : e.fit === 'days'
        ? `Kortutbetalning som motsvarar kortförsäljningen i kassan ${dates.length > 1 ? `${first} till ${last}` : first}`
        : `Kortutbetalning som motsvarar kortpengarna från kassan som inte kommit in på banken, till och med ${last}`
  return `${what}. Försäljningen bokförs i dagskassan, så raden bokförs mot ${e.account} och inte som intäkt igen, annars räknas försäljningen två gånger.`
}

/** The why in Swedish, for surfaces without the UI's message catalog (the MCP tool). */
export function whyTextSv(p: BookingProposal): string {
  // Unknown moms is said first; a box the read disputes is said after it.
  const why = p.vat_unknown
    ? `${sourceWhySv(p)}, men momsen på motpartens bokningar är inte 25, 12 eller 6 % av beloppet och går inte att föreslå: bokför momsen som underlaget anger (vat_amount), inte som momsfri`
    : sourceWhySv(p)
  const box = reverseChargeBoxDispute(p)
  if (!box) {
    return p.reverse_charge_box_unconfirmed
      ? `${why}, men motpartens ruta för omvänd skattskyldighet är inte inlärd: förslaget bokför ruta 21 (tjänst från en säljare i ett annat EU-land), ruta 22 gäller en säljare utanför EU. Se fakturan`
      : why
  }
  if (box.proposal === 'swedish_vat') {
    return `${why}, men assistentens läsning säger att säljaren finns utomlands: omvänd skattskyldighet i ruta ${reverseChargeBoxNumber(box.read)}, inte svensk moms. Svensk moms gäller bara om fakturan visar svensk moms och säljarens svenska momsregistreringsnummer`
  }
  return `${why}, men assistentens läsning lägger köpet i ruta ${reverseChargeBoxNumber(box.read)}, inte ruta ${reverseChargeBoxNumber(box.proposal)}: rätt ruta beror på vilket bolag som fakturerar, se fakturan`
}

function sourceWhySv(p: BookingProposal): string {
  switch (p.source) {
    case 'clearing':
      return p.clearing ? clearingReasonSv(p.clearing) : 'Pengar som redan är bokförda på ett avräkningskonto'
    case 'rule':
      return 'Enligt företagets regel'
    case 'counterparty': {
      const times = `${p.seen_count ?? 1} ${(p.seen_count ?? 1) === 1 ? 'gång' : 'gånger'}`
      if (p.direction_mismatch) {
        return `Motparten är bokförd ${times} tidigare, men pengarna går åt andra hållet: troligen en återbetalning eller kreditering, som bokförs omvänt mot samma konto. Stäm av mot kreditnotan eller ursprungsköpet`
      }
      const seen = `Bokförd så ${times} tidigare`
      return p.contested ? `${seen}, men matchningen är svag och assistentens läsning av raden bokför annorlunda` : seen
    }
    case 'catalog':
      return 'Känt mönster i bankens text'
    case 'recent':
      return 'Nyligen använd mall (matchade inte raden)'
    case 'precedent': {
      const count = p.seen_count ?? 1
      return `Som förra gången: motparten är bokförd så ${count} ${count === 1 ? 'gång' : 'gånger'} tidigare. Ingen regel finns för motparten, så bokningen granskas`
    }
    case 'assistant':
      return p.has_underlag ? 'Assistentens läsning av underlaget' : 'Assistentens läsning av raden'
    default:
      return 'Vald av användaren'
  }
}
