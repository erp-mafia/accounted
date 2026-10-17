import type { TemplateGroup } from '@/lib/bookkeeping/booking-templates'
import type { TransactionCategory } from '@/types'

/**
 * Business event categories: a closed, add-only list of neutral keys.
 *
 * A key says what the money was for without naming a BAS account, so an
 * agent, a partner or another country's pack reads it without the chart of
 * accounts ("what did we spend on software?" reads expense.software, not
 * 54xx and 65xx lines that differ per company). The list starts from what
 * already exists: the transaction categories a bank line is booked under
 * and the families of the booking template catalogue. Where the two name the
 * same thing (the category expense_software and the family it_software) they
 * share one key. Sweden-only keys carry the se. prefix.
 *
 * Governance: keys are only added, never renamed or removed (events are kept
 * seven years, BFL 7 kap.), each new key with a decision record
 * (docs/decisions). The database checks the shape only
 * (business_events_category_check), so adding one needs no migration.
 */
export interface BusinessEventCategoryDefinition {
  readonly key: string
  /** English name, for docs and agents. */
  readonly label: string
  /** The transaction categories that book under this key. */
  readonly transactionCategories: readonly TransactionCategory[]
  /** The booking template families (booking-templates.ts) filed under this key. */
  readonly templateGroups: readonly TemplateGroup[]
}

export const BUSINESS_EVENT_CATEGORIES = [
  { key: 'income.services', label: 'Income from services', transactionCategories: ['income_services'], templateGroups: [] },
  { key: 'income.products', label: 'Income from products', transactionCategories: ['income_products'], templateGroups: [] },
  { key: 'income.other', label: 'Other income', transactionCategories: ['income_other'], templateGroups: [] },
  { key: 'income.sales', label: 'Sales, grants and other revenue', transactionCategories: [], templateGroups: ['revenue'] },
  { key: 'expense.equipment', label: 'Equipment', transactionCategories: ['expense_equipment'], templateGroups: ['equipment'] },
  { key: 'expense.software', label: 'Software and IT services', transactionCategories: ['expense_software'], templateGroups: ['it_software'] },
  { key: 'expense.travel', label: 'Travel', transactionCategories: ['expense_travel'], templateGroups: ['travel'] },
  { key: 'expense.office', label: 'Office supplies and postage', transactionCategories: ['expense_office'], templateGroups: ['office_supplies'] },
  { key: 'expense.marketing', label: 'Marketing', transactionCategories: ['expense_marketing'], templateGroups: ['marketing'] },
  {
    key: 'expense.professional_services',
    label: 'Professional services',
    transactionCategories: ['expense_professional_services'],
    templateGroups: ['professional_services'],
  },
  { key: 'expense.education', label: 'Education and literature', transactionCategories: ['expense_education'], templateGroups: ['education'] },
  {
    key: 'expense.representation',
    label: 'Representation',
    transactionCategories: ['expense_representation'],
    templateGroups: ['representation'],
  },
  { key: 'expense.consumables', label: 'Consumables', transactionCategories: ['expense_consumables'], templateGroups: [] },
  { key: 'expense.vehicle', label: 'Vehicle', transactionCategories: ['expense_vehicle'], templateGroups: ['vehicle'] },
  { key: 'expense.telecom', label: 'Telephone and internet', transactionCategories: ['expense_telecom'], templateGroups: ['telecom'] },
  { key: 'expense.bank_fees', label: 'Bank fees', transactionCategories: ['expense_bank_fees'], templateGroups: [] },
  { key: 'expense.card_fees', label: 'Card and payment fees', transactionCategories: ['expense_card_fees'], templateGroups: [] },
  {
    key: 'expense.currency_exchange',
    label: 'Currency exchange costs',
    transactionCategories: ['expense_currency_exchange'],
    templateGroups: [],
  },
  { key: 'expense.other', label: 'Other expenses', transactionCategories: ['expense_other'], templateGroups: [] },
  { key: 'expense.premises', label: 'Premises', transactionCategories: [], templateGroups: ['premises'] },
  { key: 'expense.goods', label: 'Goods and materials', transactionCategories: [], templateGroups: ['goods'] },
  { key: 'expense.insurance', label: 'Insurance', transactionCategories: [], templateGroups: ['insurance'] },
  { key: 'expense.personnel', label: 'Personnel', transactionCategories: [], templateGroups: ['personnel'] },
  { key: 'finance.banking', label: 'Bank fees, interest and currency results', transactionCategories: [], templateGroups: ['bank_finance'] },
  { key: 'finance.other', label: 'Loans, securities and balance transfers', transactionCategories: [], templateGroups: ['financial'] },
  {
    key: 'owner.transfer',
    label: "Money between the business and its owners",
    transactionCategories: ['private'],
    templateGroups: ['private_transfers'],
  },
  { key: 'se.tax.settlement', label: 'Skattekonto and VAT settlement', transactionCategories: [], templateGroups: ['tax'] },
  { key: 'se.closing.appropriations', label: 'Year-end appropriations', transactionCategories: [], templateGroups: ['closing'] },
] as const satisfies readonly BusinessEventCategoryDefinition[]

export type BusinessEventCategory = (typeof BUSINESS_EVENT_CATEGORIES)[number]['key']

/** The shape business_events_category_check enforces. */
export const BUSINESS_EVENT_CATEGORY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/

const BY_KEY = new Map<string, BusinessEventCategoryDefinition>(BUSINESS_EVENT_CATEGORIES.map((c) => [c.key, c]))
const BY_TRANSACTION_CATEGORY = new Map<string, BusinessEventCategory>(
  BUSINESS_EVENT_CATEGORIES.flatMap((c) => c.transactionCategories.map((t) => [t, c.key] as const)),
)
const BY_TEMPLATE_GROUP = new Map<string, BusinessEventCategory>(
  BUSINESS_EVENT_CATEGORIES.flatMap((c) => c.templateGroups.map((g) => [g, c.key] as const)),
)

export function isBusinessEventCategory(value: unknown): value is BusinessEventCategory {
  return typeof value === 'string' && BY_KEY.has(value)
}

/** The key a transaction category books under; null for 'uncategorized' (no business meaning yet). */
export function categoryForTransactionCategory(category: TransactionCategory | string | null | undefined): BusinessEventCategory | null {
  if (!category) return null
  return BY_TRANSACTION_CATEGORY.get(category) ?? null
}

/** The key a booking template family is filed under. */
export function categoryForTemplateGroup(group: TemplateGroup | string | null | undefined): BusinessEventCategory | null {
  if (!group) return null
  return BY_TEMPLATE_GROUP.get(group) ?? null
}
