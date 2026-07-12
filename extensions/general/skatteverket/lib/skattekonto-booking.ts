import type { SupabaseClient } from '@supabase/supabase-js'
import { createDraftEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { getPrimary as getPrimaryCashAccount } from '@/lib/cash-accounts/service'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  JournalEntry,
} from '@/types'

/**
 * Per-row "Bokför" helper.
 *
 * Loads counter-account rules from `skattekonto_rules` (system seeds + per-company
 * overrides), picks the first match by priority, and creates a DRAFT journal entry
 * via the bookkeeping engine. The user reviews and commits the draft in
 * /bookkeeping/[id].
 *
 * Sign convention (BAS 1630, Skattekonto):
 *   beloppSkatteverket > 0  (credit on tax account, e.g. payment in)
 *     → Debit 1630, Credit counter-account
 *   beloppSkatteverket < 0  (debit on tax account, e.g. F-tax charge)
 *     → Credit 1630, Debit counter-account
 *
 * Anstånd has no system rule on purpose: it's a saldo-only deferral on the SKV
 * side and doesn't move the GL. NO_COUNTER_ACCOUNT lets the user handle the rare
 * case of anstånd granted across a closed period manually.
 */

const SKATTEKONTO_ACCOUNT = '1630'

/**
 * Sentinel emitted by system rules for inbetalning / utbetalning: resolves to the
 * company's primary SEK cash account at runtime so the resolver doesn't assume 1930.
 * Falls back to '1930' until cash_accounts exists (Item 4 in the bank-architecture
 * priority list).
 */
const PRIMARY_SEK_SENTINEL = '__PRIMARY_SEK__'
const PRIMARY_SEK_FALLBACK = '1930'

export type EntityType = 'enskild_firma' | 'aktiebolag'

interface SkattekontoRuleRow {
  id: string
  priority: number
  pattern: string
  amount_min: number | null
  amount_max: number | null
  company_type: 'aktiebolag' | 'enskild_firma' | 'all'
  counter_account: string
  counter_account_ef: string | null
  label: string | null
  active: boolean
}

export class SkattekontoBookingError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NO_COUNTER_ACCOUNT'
      | 'NO_FISCAL_PERIOD'
      | 'PERIOD_LOCKED'
      | 'ALREADY_BOOKED'
      | 'TRANSACTION_NOT_FOUND',
  ) {
    super(message)
    this.name = 'SkattekontoBookingError'
  }
}

export interface CounterAccountMatch {
  account: string
  label: string
}

/**
 * Resolve the primary SEK cash account for a company via `cash_accounts`.
 * Falls back to '1930' when no primary row exists yet (fresh company before the
 * initial PSD2 connection, or a manual-only company that hasn't set a primary).
 */
async function resolvePrimarySekAccount(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string> {
  const primary = await getPrimaryCashAccount(supabase, companyId, 'SEK')
  return primary?.ledger_account ?? PRIMARY_SEK_FALLBACK
}

/**
 * Find the counter-account for a Skatteverket transaktionstext by consulting
 * `skattekonto_rules` (system seeds + per-company overrides). Returns null when
 * no rule matches: the booking flow surfaces NO_COUNTER_ACCOUNT to the user.
 *
 * Rules are matched in priority order (lower numeric priority first), and for each
 * rule the `pattern` is split on commas to produce a list of lowercase substrings;
 * any substring contained in the normalized text wins.
 */
// Defence-in-depth check for any interpolation site. PostgREST .or() takes a
// raw filter string, so we refuse company ids that aren't plain ASCII safe
// characters (letters, digits, dash, underscore). The id should already be a
// UUID at this call site, but rejecting anything else keeps the .or()
// expression literal regardless of upstream bugs (ASVS V4.5).
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

// Explicit column projection: narrower than select('*'); ensures we don't
// ship override metadata we don't need to the application layer (SOC 2
// CC6.1, ISO 27001 A.8.5 least-privilege data access).
const SKATTEKONTO_RULE_COLUMNS =
  'id, priority, pattern, amount_min, amount_max, company_type, counter_account, counter_account_ef, label, active'

export async function guessCounterAccount(
  supabase: SupabaseClient,
  companyId: string,
  transaktionstext: string,
  entityType: EntityType,
  belopp?: number,
): Promise<CounterAccountMatch | null> {
  if (!SAFE_ID_PATTERN.test(companyId)) {
    // The caller is supposed to pass a validated company id (from
    // requireCompanyId). Refuse rather than interpolate an unknown string
    // into the PostgREST filter: the .or() string parser is forgiving and
    // we don't want to depend on it for safety.
    return null
  }

  const normalized = transaktionstext.toLowerCase()
  const absBelopp = belopp === undefined ? null : Math.abs(belopp)

  const { data: rules, error } = await supabase
    .from('skattekonto_rules')
    .select(SKATTEKONTO_RULE_COLUMNS)
    .eq('active', true)
    .or(`company_id.eq.${companyId},company_id.is.null`)
    .order('priority', { ascending: true })
    .order('id', { ascending: true })

  if (error || !rules || rules.length === 0) {
    return null
  }

  for (const rule of rules as SkattekontoRuleRow[]) {
    if (rule.company_type !== 'all' && rule.company_type !== entityType) {
      continue
    }

    if (absBelopp !== null) {
      if (rule.amount_min !== null && absBelopp < Number(rule.amount_min)) continue
      if (rule.amount_max !== null && absBelopp > Number(rule.amount_max)) continue
    }

    const patterns = rule.pattern
      .split(',')
      .map(p => p.trim().toLowerCase())
      .filter(p => p.length > 0)

    if (!patterns.some(p => normalized.includes(p))) continue

    let account =
      entityType === 'enskild_firma' && rule.counter_account_ef
        ? rule.counter_account_ef
        : rule.counter_account

    if (account === PRIMARY_SEK_SENTINEL) {
      account = await resolvePrimarySekAccount(supabase, companyId)
    }

    return {
      account,
      label: rule.label ?? transaktionstext,
    }
  }

  return null
}

/**
 * Create a draft journal entry for one skattekonto_transactions row.
 *
 * Throws SkattekontoBookingError on:
 *   - already-booked rows (journal_entry_id present)
 *   - missing/locked fiscal period for the transaktionsdatum
 *   - no rule match → user must categorize manually
 *
 * Returns the created JournalEntry. Caller is responsible for writing
 * `journal_entry_id` back onto the skattekonto_transactions row.
 */
export async function bokforSkattekontoTransaction(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  transactionId: string,
): Promise<JournalEntry> {
  // 1. Load the transaction
  const { data: tx, error: txError } = await supabase
    .from('skattekonto_transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()

  if (txError || !tx) {
    throw new SkattekontoBookingError(
      'Skattekonto-transaktionen hittades inte.',
      'TRANSACTION_NOT_FOUND',
    )
  }

  if (tx.journal_entry_id) {
    throw new SkattekontoBookingError(
      'Transaktionen är redan bokförd.',
      'ALREADY_BOOKED',
    )
  }

  // 2. Get entity_type for AB/EF-specific accounts
  const { data: settings } = await supabase
    .from('company_settings')
    .select('entity_type')
    .eq('company_id', companyId)
    .single()

  const entityType: EntityType =
    (settings?.entity_type as EntityType) ?? 'aktiebolag'

  // 3. Resolve counter-account via skattekonto_rules
  const guess = await guessCounterAccount(
    supabase,
    companyId,
    tx.transaktionstext,
    entityType,
    Number(tx.belopp_skatteverket),
  )
  if (!guess) {
    throw new SkattekontoBookingError(
      `Vi kunde inte gissa motkontot för "${tx.transaktionstext}". Skapa verifikatet manuellt.`,
      'NO_COUNTER_ACCOUNT',
    )
  }

  // 4. Resolve fiscal period for entry date
  const fiscalPeriodId = await findFiscalPeriod(
    supabase,
    companyId,
    tx.transaktionsdatum,
  )
  if (!fiscalPeriodId) {
    throw new SkattekontoBookingError(
      `Datumet ${tx.transaktionsdatum} ligger i en låst eller saknad räkenskapsperiod. ` +
        'Lås upp perioden eller hoppa över raden.',
      'PERIOD_LOCKED',
    )
  }

  // 5. Build lines based on sign convention
  const amount = Math.abs(Number(tx.belopp_skatteverket))
  const isCreditToSkattekonto = Number(tx.belopp_skatteverket) > 0

  const lines: CreateJournalEntryLineInput[] = isCreditToSkattekonto
    ? [
        {
          account_number: SKATTEKONTO_ACCOUNT,
          debit_amount: amount,
          credit_amount: 0,
          line_description: tx.transaktionstext,
        },
        {
          account_number: guess.account,
          debit_amount: 0,
          credit_amount: amount,
          line_description: guess.label,
        },
      ]
    : [
        {
          account_number: guess.account,
          debit_amount: amount,
          credit_amount: 0,
          line_description: guess.label,
        },
        {
          account_number: SKATTEKONTO_ACCOUNT,
          debit_amount: 0,
          credit_amount: amount,
          line_description: tx.transaktionstext,
        },
      ]

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: tx.transaktionsdatum,
    description: `Skattekonto: ${tx.transaktionstext}`,
    source_type: 'system',
    source_id: tx.id,
    notes: `Genererad från skattekonto-synk. Skatteverket-id: ${tx.transaktionsidentitet ?? '-'}`,
    lines,
  }

  const entry = await createDraftEntry(supabase, companyId, userId, input)

  // Link the row back so the dashboard can show "Bokförd" status.
  await supabase
    .from('skattekonto_transactions')
    .update({ journal_entry_id: entry.id })
    .eq('id', tx.id)
    .eq('company_id', companyId)

  return entry
}
