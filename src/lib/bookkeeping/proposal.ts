import { getTemplateById, type BookingTemplate, type TemplateGroup } from './booking-templates'
import { isLibraryTemplateId } from './template-library'
import { resolveTemplateAccountsForEntity } from './proposal-lines'
import { accountHue, templateGroupHue, type TemplateHue } from './template-group-colors'
import { getDefaultAccountForCategory, getDefaultVatTreatmentForCategory } from './category-mapping'
import { REVERSE_CHARGE_TREATMENT_KINDS, type ReverseChargeKind } from './vat-entries'
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
 * Client-safe: pure data and pure functions over the static catalog.
 */
export type ProposalSource = 'rule' | 'recent' | 'catalog' | 'counterparty' | 'assistant' | 'manual'

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
  has_underlag?: boolean
  /**
   * A weak learned-counterpart match that the assistant's stored read had on
   * its slate and booked on another account (lib/transactions/propose.ts).
   * Still offered in the picker and to an agent, never the row's
   * recommendation and never booked without a review.
   */
  contested?: boolean
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

/** The basis box travels only with the treatment it belongs to. */
function kindFor(
  vat: VatTreatment,
  kind: ReverseChargeKind | null | undefined,
): { reverse_charge_kind?: ReverseChargeKind } {
  return vat === 'reverse_charge' && kind ? { reverse_charge_kind: kind } : {}
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
 * A reverse charge that stays one keeps its basis box across an account
 * change; a treatment the person picks anew is the plain one the VAT list
 * offers.
 */
export function withAccount(
  p: BookingProposal,
  account: string,
  vat_treatment: VatTreatment,
  amount: number,
  label?: string,
): BookingProposal {
  const category =
    p.booking.kind === 'counterparty' ? categoryFallback(amount) : carriedCategory(p.booking.category, account, amount)
  const kept =
    p.booking.kind === 'account' && p.booking.vat_treatment === 'reverse_charge' ? p.booking.reverse_charge_kind : undefined
  return {
    template_id: `account:${account}`,
    source: 'manual',
    booking: { kind: 'account', account, vat_treatment, category, ...kindFor(vat_treatment, kept) },
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
export function whyKeyFor(p: BookingProposal): { key: string; values?: Record<string, number> } {
  switch (p.source) {
    case 'rule':
      return { key: 'rec_why_rule' }
    case 'counterparty':
      return { key: 'rec_why_counterparty', values: { count: p.seen_count ?? 1 } }
    case 'catalog':
      return { key: 'rec_why_catalog' }
    case 'recent':
      return { key: 'rec_why_recent' }
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
 * the app's own booking can post as stored.
 */
export function agentBookingFor(
  p: BookingProposal,
  entityType?: EntityType,
): { category: TransactionCategory; account_override: string; vat_treatment: VatTreatment } | null {
  if (p.booking.kind === 'account') {
    return { category: p.booking.category, account_override: p.booking.account, vat_treatment: p.booking.vat_treatment }
  }
  if (p.booking.kind === 'template') {
    const t = getTemplateById(p.booking.template_id)
    if (!t) return null
    const accounts = resolveTemplateAccountsForEntity(t, entityType)
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
  const kind = p.booking.kind === 'account' ? kindFor(vat, p.booking.reverse_charge_kind).reverse_charge_kind : undefined
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
): { category: TransactionCategory; account_override: string; vat_treatment: CategorizeToolVatTreatment; proposal_id: string } | null {
  const booking = agentBookingFor(p, entityType)
  return booking
    ? { ...booking, vat_treatment: toolVatTreatment(p, booking.vat_treatment), proposal_id: p.template_id }
    : null
}

/** The why in Swedish, for surfaces without the UI's message catalog (the MCP tool). */
export function whyTextSv(p: BookingProposal): string {
  switch (p.source) {
    case 'rule':
      return 'Enligt företagets regel'
    case 'counterparty': {
      const seen = `Bokförd så ${p.seen_count ?? 1} ${(p.seen_count ?? 1) === 1 ? 'gång' : 'gånger'} tidigare`
      return p.contested ? `${seen}, men matchningen är svag och assistentens läsning av raden bokför annorlunda` : seen
    }
    case 'catalog':
      return 'Känt mönster i bankens text'
    case 'recent':
      return 'Nyligen använd mall (matchade inte raden)'
    case 'assistant':
      return p.has_underlag ? 'Assistentens läsning av underlaget' : 'Assistentens läsning av raden'
    default:
      return 'Vald av användaren'
  }
}
