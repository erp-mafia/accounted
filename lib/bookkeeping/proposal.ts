import { getTemplateById, type BookingTemplate, type TemplateGroup } from './booking-templates'
import { isLibraryTemplateId } from './template-library'
import { resolveTemplateAccountsForEntity, type ProposalLinesInput } from './proposal-lines'
import { accountHue, templateGroupHue, type TemplateHue } from './template-group-colors'
import { getDefaultAccountForCategory, getDefaultVatTreatmentForCategory } from './category-mapping'
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
  /** One business account and an explicit VAT treatment against the bank. */
  | { kind: 'account'; account: string; vat_treatment: VatTreatment; category: TransactionCategory }

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
}

/** The leg that is not the bank: what the chip, the assistant and Claude call "the account". */
export function businessAccount(p: Pick<BookingProposal, 'debit_account' | 'credit_account'>): string {
  return p.debit_account.startsWith('19') ? p.credit_account : p.debit_account
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
  amount: number
  confidence?: number
  description?: string
  has_underlag?: boolean
}): BookingProposal {
  const vat = input.vat_treatment ?? getDefaultVatTreatmentForCategory(input.category) ?? 'exempt'
  return {
    template_id: input.id,
    source: input.source,
    booking: { kind: 'account', account: input.account, vat_treatment: vat, category: input.category },
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

/** The same proposal with the account or VAT the person changed in the review. */
export function withAccount(p: BookingProposal, account: string, vat_treatment: VatTreatment, amount: number): BookingProposal {
  const category = p.booking.kind === 'counterparty' ? categoryFallback(amount) : p.booking.category
  return {
    ...p,
    booking: { kind: 'account', account, vat_treatment, category },
    debit_account: amount < 0 ? account : '1930',
    credit_account: amount < 0 ? '1930' : account,
    vat_treatment,
    line_pattern: null,
  }
}

function categoryFallback(amount: number): TransactionCategory {
  return amount < 0 ? 'expense_other' : 'income_other'
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
  vat_amount?: number
  dimensions?: Record<string, string>
  inbox_item_id?: string
} {
  const dims = extras.dimensions && Object.keys(extras.dimensions).length > 0 ? { dimensions: extras.dimensions } : {}
  const vatAmount = extras.vatAmount != null ? { vat_amount: extras.vatAmount } : {}
  const inbox = extras.inboxItemId ? { inbox_item_id: extras.inboxItemId } : {}
  switch (p.booking.kind) {
    case 'template':
      return { is_business: true, category: p.booking.category, template_id: p.booking.template_id, ...dims, ...vatAmount, ...inbox }
    case 'counterparty':
      return { is_business: true, counterparty_template_id: p.booking.counterparty_template_id, ...dims, ...inbox }
    case 'account':
      return {
        is_business: true,
        category: p.booking.category,
        account_override: p.booking.account,
        vat_treatment: p.booking.vat_treatment,
        ...dims,
        ...vatAmount,
        ...inbox,
      }
  }
}

/**
 * The verifikat the proposal books, as the preview input the engine mirror
 * (lib/bookkeeping/proposal-lines.ts) computes lines from. One function for
 * every kind, so the review shows exactly what the booking will post.
 */
export function previewInputFor(
  p: BookingProposal,
  ctx: { amount: number; amountSek: number; entityType?: EntityType },
): ProposalLinesInput {
  const base = { amount: ctx.amount, amountSek: ctx.amountSek, entityType: ctx.entityType }
  if (p.booking.kind === 'counterparty') {
    if (p.line_pattern && p.line_pattern.length > 0) {
      // Engine parity for the money leg: the settlement books on the learned
      // template's legacy pair (raw accounts, no entity resolution).
      return { ...base, linePattern: p.line_pattern, templateDebitAccount: p.debit_account, templateCreditAccount: p.credit_account }
    }
    // Legacy single pair: VAT from the learned treatment on expenses only,
    // the 2645/2614 pair for reverse charge, no basbelopp pair.
    return {
      ...base,
      templateDebitAccount: p.debit_account,
      templateCreditAccount: p.credit_account,
      templateVatTreatment: p.vat_treatment ?? null,
      counterpartyLegacy: true,
    }
  }
  if (p.booking.kind === 'template') {
    const t = getTemplateById(p.booking.template_id)
    if (t) {
      // Static templates carry AB-specific accounts; the engine substitutes
      // them at booking, so the preview shows the same substitution.
      const accounts = resolveTemplateAccountsForEntity(t, ctx.entityType)
      return {
        ...base,
        templateDebitAccount: accounts.debitAccount ?? t.debit_account,
        templateCreditAccount: accounts.creditAccount ?? t.credit_account,
        templateVatRate: t.vat_rate,
        templateVatTreatment: t.vat_treatment,
        templateSupplierType: t.reverse_charge_supplier_type,
      }
    }
  }
  const account = p.booking.kind === 'account' ? p.booking.account : businessAccount(p)
  const category = p.booking.kind === 'account' ? p.booking.category : categoryFallback(ctx.amount)
  const vat = p.booking.kind === 'account' ? p.booking.vat_treatment : (p.vat_treatment ?? 'exempt')
  return { ...base, category, accountOverride: account, vatTreatment: vat }
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
    if (getDefaultAccountForCategory(c, entityType) === account) return c
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

/** The why in Swedish, for surfaces without the UI's message catalog (the MCP tool). */
export function whyTextSv(p: BookingProposal): string {
  switch (p.source) {
    case 'rule':
      return 'Enligt företagets regel'
    case 'counterparty':
      return `Bokförd så ${p.seen_count ?? 1} ${(p.seen_count ?? 1) === 1 ? 'gång' : 'gånger'} tidigare`
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
