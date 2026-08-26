import type { SupabaseClient } from '@supabase/supabase-js'
import { commitEntry, createDraftEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { getEarliestFiscalPeriodStart } from '@/lib/core/bookkeeping/period-service'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { SKATTEKONTO_ACCOUNT } from '@/lib/skatteverket/manual-verifikat-prefill'
import { getPrimary as getPrimaryCashAccount } from '@/lib/cash-accounts/service'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  JournalEntry,
} from '@/types'
import type {
  SkattekontoBatchResult,
  SkattekontoBatchRowResult,
  SkattekontoBookingSuggestion,
} from '@/types/skatteverket'

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
  /** Rule only applies to an enskild firma when the company is
   *  employer_registered (migration 20260819200100). An AB is unaffected. */
  requires_employer: boolean
}

export class SkattekontoBookingError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NO_COUNTER_ACCOUNT'
      | 'NO_FISCAL_PERIOD'
      | 'PERIOD_LOCKED'
      | 'ALREADY_BOOKED'
      | 'NOT_SETTLED'
      | 'ROW_IGNORED'
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
  'id, priority, pattern, amount_min, amount_max, company_type, counter_account, counter_account_ef, label, active, requires_employer'

/**
 * Result of walking the rules for one transaktionstext.
 *
 * 'employer_gated' means a rule DID match the text, but it is flagged
 * requires_employer and the company is an enskild firma without
 * employer_registered: "Avdragen skatt" on the owner's personal skattekonto
 * is then almost always A-skatt an outside employer withheld from the
 * owner's private salary, not the firm's payroll liability, so auto-booking
 * 2710 would fabricate a liability. Matching stops (no weaker rule may
 * catch the text); the caller surfaces the NO_COUNTER_ACCOUNT path with a
 * distinct hint.
 */
type RuleMatchOutcome =
  | { kind: 'match'; match: CounterAccountMatch }
  | { kind: 'employer_gated' }
  | { kind: 'none' }

/**
 * Pure core matcher shared by every suggestion/booking path: walk the
 * priority-ordered rules and return the first match. The returned account may
 * still be the __PRIMARY_SEK__ sentinel; callers resolve it against
 * cash_accounts (so the DB round trip stays out of the pure matcher).
 */
function matchSkattekontoRule(
  rules: SkattekontoRuleRow[],
  transaktionstext: string,
  entityType: EntityType,
  belopp?: number,
  employerRegistered = false,
): RuleMatchOutcome {
  const normalized = transaktionstext.toLowerCase()
  const absBelopp = belopp === undefined ? null : Math.abs(belopp)

  for (const rule of rules) {
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

    // Employer gate: the rule matched, but for a non-employer EF the safe
    // outcome is NO counter account (manual review or ignore), never 2710.
    // An AB, and an employer-registered EF, keep the rule's account.
    if (
      rule.requires_employer &&
      entityType === 'enskild_firma' &&
      !employerRegistered
    ) {
      return { kind: 'employer_gated' }
    }

    const account =
      entityType === 'enskild_firma' && rule.counter_account_ef
        ? rule.counter_account_ef
        : rule.counter_account

    return {
      kind: 'match',
      match: {
        account,
        label: rule.label ?? transaktionstext,
      },
    }
  }

  return { kind: 'none' }
}

/** The active rules for a company (system seeds + overrides), priority order. */
async function fetchSkattekontoRules(
  supabase: SupabaseClient,
  companyId: string,
): Promise<SkattekontoRuleRow[]> {
  const { data: rules, error } = await supabase
    .from('skattekonto_rules')
    .select(SKATTEKONTO_RULE_COLUMNS)
    .eq('active', true)
    .or(`company_id.eq.${companyId},company_id.is.null`)
    .order('priority', { ascending: true })
    .order('id', { ascending: true })

  if (error || !rules) return []
  return rules as SkattekontoRuleRow[]
}

export async function guessCounterAccount(
  supabase: SupabaseClient,
  companyId: string,
  transaktionstext: string,
  entityType: EntityType,
  belopp?: number,
  // Whether (company_settings.employer_registered ?? pays_salaries) is true.
  // Defaults false: the safe side of the requires_employer gate for an EF.
  employerRegistered = false,
): Promise<CounterAccountMatch | null> {
  if (!SAFE_ID_PATTERN.test(companyId)) {
    // The caller is supposed to pass a validated company id (from
    // requireCompanyId). Refuse rather than interpolate an unknown string
    // into the PostgREST filter: the .or() string parser is forgiving and
    // we don't want to depend on it for safety.
    return null
  }

  const rules = await fetchSkattekontoRules(supabase, companyId)
  if (rules.length === 0) return null

  const outcome = matchSkattekontoRule(
    rules,
    transaktionstext,
    entityType,
    belopp,
    employerRegistered,
  )
  if (outcome.kind !== 'match') return null
  const match = outcome.match

  return {
    ...match,
    account:
      match.account === PRIMARY_SEK_SENTINEL
        ? await resolvePrimarySekAccount(supabase, companyId)
        : match.account,
  }
}

/**
 * One-shot context for enrichment/batch paths: hoists the rules and
 * entity_type fetches out of per-row work. The primary SEK account is
 * resolved lazily and memoized: most batches never contain an
 * in-/utbetalning row, so the cash_accounts query only runs when a
 * __PRIMARY_SEK__ rule actually matches.
 */
export interface SkattekontoRuleContext {
  rules: SkattekontoRuleRow[]
  entityType: EntityType
  /** (company_settings.employer_registered ?? pays_salaries) === true.
   *  Drives the requires_employer rule gate for enskild firma. */
  employerRegistered: boolean
  resolvePrimarySek: () => Promise<string>
}

export async function loadRuleContext(
  supabase: SupabaseClient,
  companyId: string,
): Promise<SkattekontoRuleContext> {
  if (!SAFE_ID_PATTERN.test(companyId)) {
    // Same defence-in-depth refusal as guessCounterAccount: never interpolate
    // an unvalidated id into the PostgREST .or() filter string.
    return {
      rules: [],
      entityType: 'aktiebolag',
      employerRegistered: false,
      resolvePrimarySek: async () => PRIMARY_SEK_FALLBACK,
    }
  }

  const [rules, settingsResult] = await Promise.all([
    fetchSkattekontoRules(supabase, companyId),
    supabase
      .from('company_settings')
      .select('entity_type, employer_registered, pays_salaries')
      .eq('company_id', companyId)
      .single(),
  ])

  let primary: string | null = null
  return {
    rules,
    entityType: (settingsResult.data?.entity_type as EntityType) ?? 'aktiebolag',
    // Same signal as lib/tax/deadline-config.ts: employer_registered is the
    // explicit attestation (nullable, 20260717151000; null = never attested)
    // and falls back to the onboarding pays_salaries answer. An explicit
    // false wins over pays_salaries; only a resolved true opens the gate.
    employerRegistered:
      (settingsResult.data?.employer_registered ??
        settingsResult.data?.pays_salaries) === true,
    resolvePrimarySek: async () => {
      if (primary === null) {
        primary = await resolvePrimarySekAccount(supabase, companyId)
      }
      return primary
    },
  }
}

/**
 * Enrich skattekonto rows with the deterministic booking suggestion the
 * per-row "Bokför" would use, so the list can show what a booking will do
 * before the user commits to it. One rules/entity_type fetch for the whole
 * page of rows.
 *
 * Only unbooked, genomförda rows get a computed suggestion; already-booked
 * rows and kommande rows get `booking_suggestion: null` without any matching
 * work (and a page of only such rows skips the fetches entirely).
 */
export async function attachBookingSuggestions<
  T extends {
    transaktionstext: string
    belopp_skatteverket: number | string
    journal_entry_id: string | null
    status: string
  },
>(
  supabase: SupabaseClient,
  companyId: string,
  rows: T[],
): Promise<
  (T & {
    booking_suggestion: SkattekontoBookingSuggestion | null
    booking_gate?: 'requires_employer' | null
  })[]
> {
  const needsSuggestion = (row: T) =>
    !row.journal_entry_id && row.status !== 'upcoming'

  if (!rows.some(needsSuggestion)) {
    return rows.map(row => ({ ...row, booking_suggestion: null }))
  }

  const ctx = await loadRuleContext(supabase, companyId)
  const enriched: (T & {
    booking_suggestion: SkattekontoBookingSuggestion | null
    booking_gate?: 'requires_employer' | null
  })[] = []

  for (const row of rows) {
    if (!needsSuggestion(row)) {
      enriched.push({ ...row, booking_suggestion: null })
      continue
    }

    const outcome = matchSkattekontoRule(
      ctx.rules,
      row.transaktionstext,
      ctx.entityType,
      Number(row.belopp_skatteverket),
      ctx.employerRegistered,
    )
    if (outcome.kind === 'employer_gated') {
      // No suggestion, but tell the UI WHY so it can show the "likely your
      // private A-skatt" hint instead of the generic "no rule matched".
      enriched.push({ ...row, booking_suggestion: null, booking_gate: 'requires_employer' })
      continue
    }
    if (outcome.kind === 'none') {
      enriched.push({ ...row, booking_suggestion: null })
      continue
    }
    const match = outcome.match

    const account =
      match.account === PRIMARY_SEK_SENTINEL
        ? await ctx.resolvePrimarySek()
        : match.account

    enriched.push({
      ...row,
      booking_suggestion: {
        account,
        account_name: getBASReference(account)?.account_name ?? null,
        label: match.label,
      },
    })
  }

  return enriched
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
  // Batch callers pass a preloaded context so rules/entity_type are fetched
  // once per batch instead of once per row. Omitted → per-call fetches,
  // identical to the original single-row behaviour.
  ruleContext?: SkattekontoRuleContext,
  // requireSettled: reject rows that Skatteverket has not settled yet
  // (status !== 'booked'). The batch commit path sets this: a kommande row
  // must never land in an immutable posted verifikat. The single-row draft
  // endpoint keeps its historical behaviour (draft for user review).
  options?: { requireSettled?: boolean },
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

  // An ignored row is triaged-and-excluded by an explicit user decision:
  // booking it silently would contradict that decision. The gate sits before
  // any draft is created so no orphan draft is left behind. Unignore (fully
  // reversible) is the way back onto the work list.
  if (tx.is_ignored) {
    throw new SkattekontoBookingError(
      'Transaktionen är ignorerad. Återställ den innan du bokför.',
      'ROW_IGNORED',
    )
  }

  if (options?.requireSettled && tx.status !== 'booked') {
    throw new SkattekontoBookingError(
      'Händelsen är inte genomförd hos Skatteverket ännu och kan inte bokföras.',
      'NOT_SETTLED',
    )
  }

  // 2+3. Resolve counter-account via skattekonto_rules (entity_type decides
  // AB/EF-specific accounts; requires_employer gates payroll rules for a
  // non-employer enskild firma). The per-call path builds the same context
  // the batch path preloads, so both share one matcher and one gate.
  const ctx = ruleContext ?? (await loadRuleContext(supabase, companyId))
  const outcome = matchSkattekontoRule(
    ctx.rules,
    tx.transaktionstext,
    ctx.entityType,
    Number(tx.belopp_skatteverket),
    ctx.employerRegistered,
  )
  if (outcome.kind === 'employer_gated') {
    throw new SkattekontoBookingError(
      `"${tx.transaktionstext}" på en enskild firmas skattekonto är oftast skatt som en ` +
        'arbetsgivare dragit från din privata lön och ingen affärshändelse i firman: ' +
        'bokför manuellt om den ändå gäller firmans anställda, annars kan raden ignoreras.',
      'NO_COUNTER_ACCOUNT',
    )
  }
  const guess: CounterAccountMatch | null =
    outcome.kind === 'match'
      ? {
          ...outcome.match,
          account:
            outcome.match.account === PRIMARY_SEK_SENTINEL
              ? await ctx.resolvePrimarySek()
              : outcome.match.account,
        }
      : null
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
    // Distinguish "predates the company's bookkeeping entirely" from an
    // ordinary locked/missing period: for an enskild firma the personal
    // skattekonto history predates the company, and telling the user to
    // "unlock the period" for a date no period will ever cover is a dead
    // end. The ignore action is the way out for those rows.
    const earliestPeriodStart = await getEarliestFiscalPeriodStart(
      supabase,
      companyId,
    )
    if (earliestPeriodStart && tx.transaktionsdatum < earliestPeriodStart) {
      throw new SkattekontoBookingError(
        `Datumet ${tx.transaktionsdatum} ligger före företagets första räkenskapsår ` +
          `(som börjar ${earliestPeriodStart}). Händelsen gäller sannolikt tiden före ` +
          'bokföringens start och kan ignoreras.',
        'PERIOD_LOCKED',
      )
    }
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

  // Link the row back so the dashboard can show "Bokförd" status. The
  // backlink is a conditional CLAIM, not a blind write: `.is('journal_entry_id',
  // null)` makes concurrent submissions race on the same row and lets exactly
  // one win. Zero affected rows means another request already booked the row
  // between our precheck and now: surface ALREADY_BOOKED instead of
  // double-posting. The just-created draft is left behind unlinked: the
  // engine has no sanctioned draft-discard function and journal tables must
  // never be raw-deleted, so an orphan draft (legally deletable by the user
  // in /bookkeeping) is the safe leftover.
  const { data: claimed, error: claimError } = await supabase
    .from('skattekonto_transactions')
    .update({ journal_entry_id: entry.id })
    .eq('id', tx.id)
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .select('id')

  if (claimError || !claimed || claimed.length === 0) {
    throw new SkattekontoBookingError(
      'Transaktionen är redan bokförd.',
      'ALREADY_BOOKED',
    )
  }

  return entry
}

export type { SkattekontoBatchResult, SkattekontoBatchRowResult }

/**
 * The period-lock enforcement trigger (migration 20240101000017) raises
 * 'Cannot write to locked/closed fiscal period "..." (is_closed=..., locked_at=...)'.
 * findFiscalPeriod's precheck only filters is_closed=false, so a period that
 * is locked (locked_at set) but not closed passes the precheck and the draft
 * INSERT throws this instead. Detect the signature (also when wrapped by
 * BookkeepingDatabaseError, which appends the DB message) so the batch can
 * report PERIOD_LOCKED rather than UNKNOWN with raw English trigger text.
 */
function isPeriodLockTriggerError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes('locked/closed fiscal period')
  )
}

/**
 * Book several skattekonto rows in one server-side pass: draft + commit per
 * row so a successful row lands as a posted verifikat immediately (no orphan
 * drafts for the user to chase). Rules/entity_type are fetched once for the
 * whole batch.
 *
 * A row failure never aborts the loop: the caller gets a per-row result list
 * plus a summary and reports the aggregate. If the draft was created but the
 * commit failed (e.g. a mandatory-dimension policy), the draft is kept and
 * stays linked to the row: that degrades to the pre-existing
 * draft-then-review flow instead of deleting bookkeeping material.
 */
export async function bokforSkattekontoTransactionsBatch(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  ids: string[],
): Promise<SkattekontoBatchResult> {
  const ruleContext = await loadRuleContext(supabase, companyId)
  // A one-row batch is the inline single-row flow: attribute it as a normal
  // user acceptance; real bulk runs are attributed as bulk_accept.
  const commitMethod = ids.length === 1 ? 'user_accept' : 'bulk_accept'
  const results: SkattekontoBatchRowResult[] = []

  for (const id of ids) {
    let entry: JournalEntry
    try {
      entry = await bokforSkattekontoTransaction(
        supabase,
        companyId,
        userId,
        id,
        ruleContext,
        // Batch rows commit immediately: never post an unsettled (kommande)
        // Skatteverket row into an immutable verifikat.
        { requireSettled: true },
      )
    } catch (err) {
      if (err instanceof SkattekontoBookingError) {
        results.push({
          id,
          ok: false,
          error_code: err.code,
          error_message: err.message,
        })
      } else if (isPeriodLockTriggerError(err)) {
        results.push({
          id,
          ok: false,
          error_code: 'PERIOD_LOCKED',
          error_message:
            'Raden ligger i en låst räkenskapsperiod. Lås upp perioden eller hoppa över raden.',
        })
      } else {
        results.push({
          id,
          ok: false,
          error_code: 'UNKNOWN',
          error_message:
            err instanceof Error ? err.message : 'Transaktionen kunde inte bokföras.',
        })
      }
      continue
    }

    try {
      const committed = await commitEntry(
        supabase,
        companyId,
        userId,
        entry.id,
        commitMethod,
      )
      results.push({
        id,
        ok: true,
        journal_entry_id: committed.id,
        voucher_number: committed.voucher_number ?? null,
        voucher_series: committed.voucher_series ?? null,
      })
    } catch (err) {
      results.push({
        id,
        ok: false,
        journal_entry_id: entry.id,
        error_code: 'COMMIT_FAILED',
        error_message:
          err instanceof Error
            ? err.message
            : 'Utkastet skapades men kunde inte bokföras.',
      })
    }
  }

  const succeeded = results.filter(r => r.ok).length
  return {
    results,
    summary: {
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
    },
  }
}
