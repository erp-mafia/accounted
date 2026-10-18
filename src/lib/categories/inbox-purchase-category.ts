/**
 * The purchase category of invoice-inbox items, computed when they are read.
 * Nothing is stored except what a person said: their choice on the item
 * (extracted_data.purchaseCategory) and their instruction for a supplier
 * (suppliers.default_purchase_category), both written by
 * lib/documents/inbox-purchase-category.ts. The proposal is derived from the reading and the company's booked history each
 * time, so it improves as the history does and never goes stale.
 *
 * Evidence gathered for proposePurchaseCategory, for a whole page of items
 * in at most three queries:
 *   - the matched supplier's instruction (suppliers.default_purchase_category,
 *     set when a person ticks "varje gång"): Ditt val, under a person's own
 *     choice on the item and over everything learned;
 *   - the counterparty's learned template (categorization_templates), matched
 *     on the supplier name exactly (alias or normalized key, never fuzzy):
 *     its dominant cost account and clean hits;
 *   - the suggested account: the lines' own accountSuggestion when they agree
 *     on one, else the matched supplier's default_expense_account;
 *   - the reading itself: kind, merchant kind, lines, supplier name.
 *
 * A failed read never fails the item read it enriches: the category is a
 * hint, so the item answers without one.
 */
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LinePatternEntry } from '@/types'
import {
  isSettlementAccount,
  legacyTemplateDirection,
  namesCounterparty,
  normalizeCounterpartyName,
  patternDirection,
  patternReplayPlan,
} from '@/lib/bookkeeping/counterparty-templates'
import { createLogger } from '@/lib/logger'
import {
  proposePurchaseCategory,
  type PurchaseCategoryInput,
  type PurchaseCategoryProposal,
} from './propose-purchase-category'
import { PURCHASE_CATEGORY_CODES, PURCHASE_CATEGORY_VERSION } from './purchase-categories'
import { readPurchaseCategoryOverride } from './purchase-category-override'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants/account-number'

/**
 * A value quoted for a PostgREST array literal, as lib/rules/model.ts does;
 * kept here because the ledger kernel may not import the transactions block.
 */
function postgrestFilterValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const log = createLogger('inbox-purchase-category')

/** What an inbox read answers as purchase_category. */
export interface InboxPurchaseCategory extends PurchaseCategoryProposal {
  /** The taxonomy version the code belongs to. */
  version: typeof PURCHASE_CATEGORY_VERSION
}

/** The columns the enrichment reads off an inbox row. */
export interface InboxPurchaseCategoryRow {
  id: string
  extracted_data: Record<string, unknown> | null
  matched_supplier_id?: string | null
}

// The stored shape and its reader live with the carry-over rule every
// replacing writer uses (./purchase-category-override.ts).
export { readPurchaseCategoryOverride, type StoredPurchaseCategory } from './purchase-category-override'

// ── Templates ─────────────────────────────────────────────────

interface TemplateRow {
  counterparty_name: string
  counterparty_aliases: string[] | null
  debit_account: string
  credit_account: string
  line_pattern: LinePatternEntry[] | null
  occurrence_count: number | null
  corrections: number | null
  source: string | null
}

// Column list repeated literally in each query so the phantom-column guard can read it.

/**
 * The account a learned purchase template books its cost on: the debit side
 * of a single-line template, or the largest cost line of a multi-line
 * pattern (the reverse-charge basis pair set aside). Null for income and
 * transfer templates and for a pattern whose cost lines tie.
 */
export function templatePurchaseAccount(
  template: Pick<TemplateRow, 'debit_account' | 'credit_account' | 'line_pattern'>,
): string | null {
  const pattern = Array.isArray(template.line_pattern) && template.line_pattern.length > 0 ? template.line_pattern : null
  if (!pattern) {
    return legacyTemplateDirection(template.debit_account, template.credit_account) === 'expense'
      ? template.debit_account
      : null
  }
  if (patternDirection(pattern) !== 'expense') return null
  const byAccount = new Map<string, number>()
  for (const entry of patternReplayPlan(pattern).entries) {
    if (entry.type !== 'business' || entry.side !== 'debit' || isSettlementAccount(entry.account)) continue
    byAccount.set(entry.account, (byAccount.get(entry.account) ?? 0) + (entry.ratio ?? 0))
  }
  const ranked = [...byAccount].sort((a, b) => b[1] - a[1])
  if (ranked.length === 0) return null
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null
  return ranked[0][0]
}

function counterpartyEvidence(template: TemplateRow): PurchaseCategoryInput['counterparty'] {
  // A system default is a guess the company never booked, not history.
  if (template.source === 'sni_default') return null
  const account = templatePurchaseAccount(template)
  if (!account) return null
  const cleanHits = Math.max(0, Number(template.occurrence_count ?? 0) - Number(template.corrections ?? 0))
  return { account, cleanHits }
}

async function loadTemplates(
  supabase: SupabaseClient,
  companyId: string,
  names: string[],
  aliasKeys: string[],
): Promise<TemplateRow[]> {
  if (names.length === 0) return []
  const byName = supabase
    .from('categorization_templates')
    .select('counterparty_name, counterparty_aliases, debit_account, credit_account, line_pattern, occurrence_count, corrections, source')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .in('counterparty_name', names)
  // overlaps() does not quote array elements, so they are quoted here.
  const byAlias = supabase
    .from('categorization_templates')
    .select('counterparty_name, counterparty_aliases, debit_account, credit_account, line_pattern, occurrence_count, corrections, source')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .overlaps('counterparty_aliases', `{${aliasKeys.map(postgrestFilterValue).join(',')}}`)
  const [named, aliased] = await Promise.all([byName, byAlias])
  if (named.error) throw named.error
  if (aliased.error) throw aliased.error
  return [...((named.data ?? []) as TemplateRow[]), ...((aliased.data ?? []) as TemplateRow[])]
}

// ── Readings ──────────────────────────────────────────────────

interface Reading {
  supplierName: string | null
  extraction: NonNullable<PurchaseCategoryInput['extraction']>
  lineAccount: string | null
}

function readReading(extracted: Record<string, unknown> | null): Reading {
  const supplier = (extracted?.supplier ?? null) as Record<string, unknown> | null
  const supplierName = typeof supplier?.name === 'string' && supplier.name.trim() ? supplier.name.trim() : null
  const rawLines = Array.isArray(extracted?.lineItems) ? (extracted.lineItems as Array<Record<string, unknown>>) : []
  const lineItems = rawLines.map((line) => ({
    description: typeof line?.description === 'string' ? line.description : null,
    lineTotal: typeof line?.lineTotal === 'number' ? line.lineTotal : null,
  }))
  const suggestions = new Set(
    rawLines
      .map((line) => line?.accountSuggestion)
      .filter((a): a is string => typeof a === 'string' && ACCOUNT_NUMBER_RE.test(a)),
  )
  return {
    supplierName,
    lineAccount: suggestions.size === 1 ? [...suggestions][0] : null,
    extraction: {
      documentKind: typeof extracted?.documentKind === 'string' ? extracted.documentKind : null,
      merchantCategory: typeof extracted?.merchantCategory === 'string' ? extracted.merchantCategory : null,
      lineItems,
      supplierName,
    },
  }
}

/**
 * The purchase category of each row, keyed by row id. Rows without a
 * reading, or with nothing to go on, map to null.
 */
export async function resolveInboxPurchaseCategories(
  supabase: SupabaseClient,
  companyId: string,
  rows: readonly InboxPurchaseCategoryRow[],
): Promise<Map<string, InboxPurchaseCategory | null>> {
  const out = new Map<string, InboxPurchaseCategory | null>()
  const pending: Array<{ row: InboxPurchaseCategoryRow; reading: Reading | null; key: string | null }> = []
  for (const row of rows) {
    const override = readPurchaseCategoryOverride(row.extracted_data)
    if (override) {
      out.set(row.id, { code: override, source: 'person', level: 'Ditt val', version: PURCHASE_CATEGORY_VERSION })
      continue
    }
    if (!row.extracted_data) {
      // Nothing to read, but the matched supplier may carry an instruction.
      if (row.matched_supplier_id) pending.push({ row, reading: null, key: null })
      else out.set(row.id, null)
      continue
    }
    const reading = readReading(row.extracted_data)
    const key =
      reading.supplierName && namesCounterparty(reading.supplierName)
        ? normalizeCounterpartyName(reading.supplierName)
        : null
    pending.push({ row, reading, key: key && key.length >= 2 ? key : null })
  }
  if (pending.length === 0) return out

  const names = [...new Set(pending.flatMap((p) => (p.key ? [p.key] : [])))]
  const aliasKeys = [
    ...new Set(
      pending.flatMap((p) => (p.key && p.reading?.supplierName ? [p.key, p.reading.supplierName.toLowerCase()] : [])),
    ),
  ]
  // Every matched supplier: its instruction outranks the reading, and its
  // default account stands in when the lines suggest none.
  const supplierIds = [...new Set(pending.flatMap((p) => (p.row.matched_supplier_id ? [p.row.matched_supplier_id] : [])))]

  let templates: TemplateRow[] = []
  const supplierAccounts = new Map<string, string>()
  const supplierInstructions = new Map<string, string>()
  // Read apart, so a failed history read never drops a person's instruction.
  const [loaded, suppliers] = await Promise.allSettled([
    loadTemplates(supabase, companyId, names, aliasKeys),
    supplierIds.length > 0
      ? supabase
          .from('suppliers')
          .select('id, default_expense_account, default_purchase_category')
          .eq('company_id', companyId)
          .in('id', supplierIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  const failures: unknown[] = []
  if (loaded.status === 'fulfilled') templates = loaded.value
  else failures.push(loaded.reason)
  if (suppliers.status === 'rejected') failures.push(suppliers.reason)
  else if (suppliers.value.error) failures.push(suppliers.value.error)
  else {
    type SupplierDefaults = { id: string; default_expense_account: string | null; default_purchase_category: string | null }
    for (const s of (suppliers.value.data ?? []) as SupplierDefaults[]) {
      if (s.default_expense_account) supplierAccounts.set(s.id, s.default_expense_account)
      if (s.default_purchase_category) supplierInstructions.set(s.id, s.default_purchase_category)
    }
  }
  for (const error of failures) {
    // The category is a hint: without the evidence the reading alone decides.
    log.warn('purchase category evidence could not be read', {
      companyId,
      error: error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error),
    })
  }

  // A real counterparty_name wins over an alias, as in counterparty matching.
  const byName = new Map<string, TemplateRow>()
  const byAlias = new Map<string, TemplateRow>()
  for (const t of templates) byName.set(t.counterparty_name, t)
  for (const t of templates) {
    for (const alias of t.counterparty_aliases ?? []) if (!byAlias.has(alias)) byAlias.set(alias, t)
  }

  for (const { row, reading, key } of pending) {
    const supplierInstruction = row.matched_supplier_id ? supplierInstructions.get(row.matched_supplier_id) ?? null : null
    if (!reading) {
      const proposal = proposePurchaseCategory({ supplierInstruction })
      out.set(row.id, proposal ? { ...proposal, version: PURCHASE_CATEGORY_VERSION } : null)
      continue
    }
    const raw = reading.supplierName?.toLowerCase() ?? null
    const template = key ? (raw ? byAlias.get(raw) : undefined) ?? byName.get(key) ?? byAlias.get(key) : undefined
    const proposal = proposePurchaseCategory({
      supplierInstruction,
      counterparty: template ? counterpartyEvidence(template) : null,
      extraction: reading.extraction,
      suggestedAccount:
        reading.lineAccount ?? (row.matched_supplier_id ? supplierAccounts.get(row.matched_supplier_id) ?? null : null),
    })
    out.set(row.id, proposal ? { ...proposal, version: PURCHASE_CATEGORY_VERSION } : null)
  }
  return out
}

/** The contract of purchase_category on an inbox read (v1 and MCP). */
export const InboxPurchaseCategorySchema = z
  .object({
    code: z
      .enum(PURCHASE_CATEGORY_CODES)
      .describe(
        'What was bought: a stable taxonomy code, e.g. "expense.software.saas". Its first two segments are the business-event category it belongs to (expense.software).',
      ),
    source: z
      .enum(['person', 'instruction', 'counterparty', 'account', 'merchant_category', 'lines'])
      .describe('The evidence it rests on: a person\'s choice for this item, a person\'s instruction for the matched supplier (set with every_time), the counterparty\'s booked history, a suggested account, the merchant kind or the document\'s lines.'),
    level: z
      .enum(['Ditt val', 'Stark', 'Trolig'])
      .describe('Ditt val = a person chose it, for this item or for every item from the supplier; Stark = clean booked history, alone or agreeing with the document; Trolig = the document or one account points to it.'),
    version: z.literal(PURCHASE_CATEGORY_VERSION).describe('Taxonomy version of the code.'),
  })
  .describe('What the underlag bought, computed when read; null when the evidence is ambiguous. Not a booking: the account stays the booking\'s.')
