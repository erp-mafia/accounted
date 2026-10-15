import type { SupabaseClient } from '@supabase/supabase-js'
import { booksCurrentTax, resolveCompanyEntityType } from '@/lib/company/entity-type'
import { commitEntry, createDraftEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { getEarliestFiscalPeriodStart } from '@/lib/core/bookkeeping/period-service'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { roundOre } from '@/lib/money'
import {
  SKATTEKONTO_ACCOUNT_DEFAULT,
  resolveSkattekontoAccount,
  type SkattekontoLedgerAccount,
} from '@/lib/skatteverket/skattekonto-account'
import { getPrimary as getPrimaryCashAccount } from '@/lib/cash-accounts/service'
import { findOpeningBalanceFloor, sumAccountBalance } from '@/lib/reconciliation/gl-balance'
import {
  getSkattekontoReconciliationStatus,
  skattekontoPlannedHolds,
  type SkattekontoLedgerCover,
  type SkattekontoPlannedHold,
} from '@/lib/reconciliation/skattekonto-reconciliation'
import { formatCurrency } from '@/lib/utils'
import { VAT_REFUND_ACCOUNT, VAT_ROUNDING_ACCOUNT, VAT_SETTLEMENT_ACCOUNT } from '@/lib/reports/vat-settlement'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import {
  findLedgerTwinCandidates,
  findLedgerTwinCandidatesForIds,
  type LedgerTwinProbe,
  type SkattekontoMatchCandidate,
} from './skattekonto-match'
import {
  findDirectLedgerHolders,
  findDirectLedgerHoldersForIds,
  isCashAccount,
  sameCounterLine,
  type SkattekontoCounterLine,
} from './skattekonto-direct'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  EntityType,
  JournalEntry,
} from '@/types'
import type {
  SkattekontoBatchResult,
  SkattekontoBatchRowResult,
  SkattekontoBookingSuggestion,
  SkattekontoLedgerCoverInfo,
  SkattekontoLedgerTwin,
} from '@/types/skatteverket'
import { todayIsoStockholm } from '@/lib/dates/iso'

/**
 * Per-row "Bokför" helper.
 *
 * Loads counter-account rules from `skattekonto_rules` (system seeds + per-company
 * overrides), picks the first match by priority, and creates a DRAFT journal entry
 * via the bookkeeping engine. The user reviews and commits the draft in
 * /bookkeeping/[id].
 *
 * Sign convention (BAS 1630, Skattekonto; 2012 for an enskild firma that runs
 * the skattekonto in eget kapital, lib/skatteverket/skattekonto-account.ts,
 * read as ctx.account):
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

export type { EntityType } from '@/types'

interface SkattekontoRuleRow {
  id: string
  /** NULL for a system seed rule, the company id for a company's own rule. */
  company_id?: string | null
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
      | 'TRANSACTION_NOT_FOUND'
      | 'LEDGER_TWIN_EXISTS'
      | 'LEDGER_COVER_EXISTS'
      | 'LEDGER_DIRECT_EXISTS',
    /** The verifikat that already carry the event (LEDGER_TWIN_EXISTS only). */
    public readonly ledgerTwins?: SkattekontoLedgerTwin[],
    /** The unlinked verifikat that already hold the event (LEDGER_COVER_EXISTS only). */
    public readonly ledgerCover?: SkattekontoLedgerCoverInfo,
    /** The verifikat that hold the event without the skattekonto (LEDGER_DIRECT_EXISTS only). */
    public readonly ledgerDirect?: SkattekontoLedgerTwin[],
  ) {
    super(message)
    this.name = 'SkattekontoBookingError'
  }
}

export interface CounterAccountMatch {
  account: string
  label: string
  /**
   * Only on a VAT refund that clears 1650 (resolveVatRefundCounterAccount):
   * the refund minus the 1650 receivable, at most 1 kr either way, booked on
   * 3740 öresavrundning. Positive = credit 3740, negative = debit 3740. The
   * counter account then takes the receivable, not the refund.
   */
  oreRounding?: number
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

/** Reads the 1650 balance up to an event date (null on a failed read). */
type VatReceivableBalanceReader = (eventDate: string | undefined) => Promise<number | null>

/**
 * The 1650 balance on the event date (today without one), floored at the
 * latest ingående balans like every other balance reader: an IB restates the
 * earlier years whose detail stays in the ledger, so an unfloored sum counts
 * them twice and would keep "finding" a receivable that a refund already
 * cleared. A failed floor or sum read answers null (keep the rule's account).
 */
function readVatReceivableBalance(supabase: SupabaseClient, companyId: string): VatReceivableBalanceReader {
  return async (eventDate) => {
    const cutoffDate = eventDate ?? todayIsoStockholm()
    let floorDate: string | null = null
    try {
      floorDate = (await findOpeningBalanceFloor(supabase, companyId, VAT_REFUND_ACCOUNT, cutoffDate))?.date ?? null
    } catch {
      return null
    }
    return sumAccountBalance(supabase, companyId, VAT_REFUND_ACCOUNT, {
      ...(floorDate ? { fromDate: floorDate } : {}),
      cutoffDate,
    })
  }
}

/**
 * The largest gap between the refund and the 1650 receivable that is booked
 * as rounding. A declaration filed from here now carries the settlement's own
 * whole-krona net (rutorToMomsuppgift takes it from buildFiledAmounts), so
 * the two agree. The gap remains for the periods filed before that: the
 * integration then rounded each ruta to the nearest krona while the
 * momsavräkning dropped the öre, so Skatteverket's refund can differ from the
 * receivable by a krona. It also covers a declaration typed in by hand with
 * other whole-krona amounts. The settlement itself puts its rounding on 3740.
 * A larger gap is no rounding: such a refund keeps the rule's account.
 */
const VAT_REFUND_ROUNDING_LIMIT = 1

/** Re-assessments of an earlier period keep the rule's account. */
const VAT_DECISION_TEXT = /ompröv|beslut/i

/**
 * The counter-account for a VAT refund (agent feedback seq 975032).
 *
 * The seed rule books every moms event on 2650, both signs. But the
 * momsavräkning (lib/reports/vat-settlement.ts) puts a net receivable on 1650,
 * so when Skatteverket then credits the skattekonto (a positive event),
 * crediting 2650 leaves 1650 open and shows a VAT debt on 2650 that does not
 * exist. When 1650 holds a debit balance on the event date that matches the
 * refund within 1 kr, the refund clears it instead: 1650 takes the receivable
 * and the gap goes to 3740 öresavrundning (oreRounding), the convention the
 * settlement uses for its own rounding. Everything else keeps the rule's
 * account: a debit event (VAT charged), an omprövning or beslut, a company's
 * own rule (only the system seed is re-routed), a failed balance read, an
 * empty 1650, and a gap above 1 kr either way.
 */
async function resolveVatRefundCounterAccount(
  match: CounterAccountMatch,
  seedRule: boolean,
  belopp: number | undefined,
  transaktionstext: string,
  eventDate: string | undefined,
  readBalance: VatReceivableBalanceReader,
): Promise<CounterAccountMatch> {
  if (!seedRule || match.account !== VAT_SETTLEMENT_ACCOUNT) return match
  if (belopp === undefined || !(belopp > 0)) return match
  if (VAT_DECISION_TEXT.test(transaktionstext)) return match
  const receivable = await readBalance(eventDate)
  if (receivable === null || !(receivable > 0)) return match
  const gap = roundOre(belopp - receivable)
  if (Math.abs(gap) > VAT_REFUND_ROUNDING_LIMIT) return match
  const label = getBASReference(VAT_REFUND_ACCOUNT)?.account_name ?? 'Momsfordran'
  return gap === 0
    ? { account: VAT_REFUND_ACCOUNT, label }
    : { account: VAT_REFUND_ACCOUNT, label, oreRounding: gap }
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
  'id, company_id, priority, pattern, amount_min, amount_max, company_type, counter_account, counter_account_ef, label, active, requires_employer'

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
  | {
      kind: 'match'
      match: CounterAccountMatch
      /** The rule is a system seed (company_id NULL), not the company's own. */
      seedRule: boolean
    }
  | { kind: 'employer_gated' }
  | { kind: 'none' }

/**
 * Pure core matcher shared by every suggestion/booking path: walk the
 * priority-ordered rules and return the first match. The returned account may
 * still be the __PRIMARY_SEK__ sentinel; callers resolve it against
 * cash_accounts (so the DB round trip stays out of the pure matcher).
 */
/**
 * A rule authored for `aktiebolag` describes juridisk-person tax mechanics
 * (bolagsskatt and preliminärskatt on 2510, arbetsgivaravgifter), which an
 * ekonomisk förening shares (IL 65 kap. 10 §); an `enskild_firma` rule keys
 * on the owner's private tax and stays with that form. Unknown forms match
 * `all` only.
 */
function ruleAppliesToForm(companyType: SkattekontoRuleRow['company_type'], entityType: EntityType): boolean {
  if (companyType === 'all' || companyType === entityType) return true
  return companyType === 'aktiebolag' && booksCurrentTax(entityType)
}

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
    if (!ruleAppliesToForm(rule.company_type, entityType)) {
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
      seedRule: rule.company_id == null,
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
  // The event's transaktionsdatum: the cutoff for the 1650 balance that
  // decides where a VAT refund goes (resolveVatRefundCounterAccount).
  eventDate?: string,
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

  const outcome = await resolveCounterAccount(
    {
      rules,
      entityType,
      employerRegistered,
      resolvePrimarySek: () => resolvePrimarySekAccount(supabase, companyId),
    },
    { transaktionstext, belopp, transaktionsdatum: eventDate },
    readVatReceivableBalance(supabase, companyId),
  )
  return outcome.kind === 'match' ? outcome.match : null
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
  /** The company's skattekonto account: the side every booked row takes. */
  account: SkattekontoLedgerAccount
  /** (company_settings.employer_registered ?? pays_salaries) === true.
   *  Drives the requires_employer rule gate for enskild firma. */
  employerRegistered: boolean
  resolvePrimarySek: () => Promise<string>
}

export async function loadRuleContext(
  supabase: SupabaseClient,
  companyId: string,
  known?: { account?: SkattekontoLedgerAccount },
): Promise<SkattekontoRuleContext> {
  if (!SAFE_ID_PATTERN.test(companyId)) {
    // Same defence-in-depth refusal as guessCounterAccount: never interpolate
    // an unvalidated id into the PostgREST .or() filter string. No rules, so
    // nothing is ever booked on the account.
    return {
      rules: [],
      entityType: 'aktiebolag',
      account: SKATTEKONTO_ACCOUNT_DEFAULT,
      employerRegistered: false,
      resolvePrimarySek: async () => PRIMARY_SEK_FALLBACK,
    }
  }

  const [rules, settingsResult, account] = await Promise.all([
    fetchSkattekontoRules(supabase, companyId),
    supabase
      .from('company_settings')
      .select('entity_type, employer_registered, pays_salaries')
      .eq('company_id', companyId)
      .single(),
    known?.account ?? resolveSkattekontoAccount(supabase, companyId),
  ])

  let primary: string | null = null
  return {
    rules,
    entityType: await resolveCompanyEntityType(supabase, companyId, settingsResult.data?.entity_type),
    account,
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
 * The one counter-account resolver for a skattekonto event, behind every path
 * that books or suggests one: the per-row and batch booking, the list's
 * suggestion and guessCounterAccount. It walks the rules
 * (matchSkattekontoRule: legal form, amount bounds, the employer gate),
 * resolves the __PRIMARY_SEK__ sentinel against cash_accounts, and lets a
 * seed-rule VAT refund clear the 1650 receivable
 * (resolveVatRefundCounterAccount). A caller only chooses how the 1650
 * balance is read: fresh per row when booking, the page's remaining
 * receivable when suggesting.
 */
async function resolveCounterAccount(
  // The counter side only: the skattekonto side is ctx.account at the builder.
  ctx: Omit<SkattekontoRuleContext, 'account'>,
  event: { transaktionstext: string; belopp: number | undefined; transaktionsdatum: string | undefined },
  readBalance: VatReceivableBalanceReader,
): Promise<RuleMatchOutcome> {
  const outcome = matchSkattekontoRule(
    ctx.rules,
    event.transaktionstext,
    ctx.entityType,
    event.belopp,
    ctx.employerRegistered,
  )
  if (outcome.kind !== 'match') return outcome
  const match = await resolveVatRefundCounterAccount(
    {
      ...outcome.match,
      account:
        outcome.match.account === PRIMARY_SEK_SENTINEL
          ? await ctx.resolvePrimarySek()
          : outcome.match.account,
    },
    outcome.seedRule,
    event.belopp,
    event.transaktionstext,
    event.transaktionsdatum,
    readBalance,
  )
  return { ...outcome, match }
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
    transaktionsdatum?: string
  },
>(
  supabase: SupabaseClient,
  companyId: string,
  rows: T[],
  account?: SkattekontoLedgerAccount,
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

  const ctx = await loadRuleContext(supabase, companyId, { account })
  // One 1650 read per event date for the whole page. A suggestion posts
  // nothing, so the refunds already suggested onto 1650 are subtracted in row
  // order (the order the batch commits them): two refunds against one
  // receivable must not both be shown clearing it.
  const readBalance = readVatReceivableBalance(supabase, companyId)
  const balanceByDate = new Map<string, Promise<number | null>>()
  const suggestedRefunds: Array<{ date: string | undefined; amount: number }> = []
  const readRemainingReceivable: VatReceivableBalanceReader = async (eventDate) => {
    const key = eventDate ?? ''
    let pending = balanceByDate.get(key)
    if (!pending) {
      pending = readBalance(eventDate)
      balanceByDate.set(key, pending)
    }
    const balance = await pending
    if (balance === null) return null
    const alreadySuggested = suggestedRefunds
      .filter((r) => !eventDate || !r.date || r.date <= eventDate)
      .reduce((sum, r) => sum + r.amount, 0)
    return roundOre(balance - alreadySuggested)
  }
  const enriched: (T & {
    booking_suggestion: SkattekontoBookingSuggestion | null
    booking_gate?: 'requires_employer' | null
  })[] = []

  for (const row of rows) {
    if (!needsSuggestion(row)) {
      enriched.push({ ...row, booking_suggestion: null })
      continue
    }

    const outcome = await resolveCounterAccount(
      ctx,
      {
        transaktionstext: row.transaktionstext,
        belopp: Number(row.belopp_skatteverket),
        transaktionsdatum: row.transaktionsdatum,
      },
      readRemainingReceivable,
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
    if (match.account === VAT_REFUND_ACCOUNT) {
      // What this booking takes off 1650: the receivable, not the refund.
      suggestedRefunds.push({
        date: row.transaktionsdatum,
        amount: roundOre(Number(row.belopp_skatteverket) - (match.oreRounding ?? 0)),
      })
    }

    enriched.push({
      ...row,
      booking_suggestion: {
        account: match.account,
        account_name: getBASReference(match.account)?.account_name ?? null,
        label: match.label,
        ...(match.oreRounding ? { ore_rounding: match.oreRounding } : {}),
      },
    })
  }

  return enriched
}

function toLedgerTwin(c: SkattekontoMatchCandidate): SkattekontoLedgerTwin {
  return {
    journal_entry_id: c.journal_entry_id,
    voucher_series: c.voucher_series,
    voucher_number: c.voucher_number,
    entry_date: c.entry_date,
    description: c.description,
    status: c.status,
    ...(c.combined_with?.length ? { combined_with: c.combined_with } : {}),
  }
}

function toLedgerTwinMap(
  byRow: Map<string, SkattekontoMatchCandidate[]>,
): Map<string, SkattekontoLedgerTwin[]> {
  return new Map(Array.from(byRow, ([id, list]) => [id, list.map(toLedgerTwin)]))
}

/**
 * The verifikat that already carry each row's event on 1630: the candidates
 * the match flow offers (findLedgerTwinCandidates), so a refusal always
 * points at something "Koppla" can link. Every row gets an entry, empty when
 * the ledger has no twin. Throws when the search cannot be completed.
 */
export async function findSkattekontoLedgerTwins(
  supabase: SupabaseClient,
  companyId: string,
  rows: LedgerTwinProbe[],
  account?: SkattekontoLedgerAccount,
): Promise<Map<string, SkattekontoLedgerTwin[]>> {
  return toLedgerTwinMap(await findLedgerTwinCandidates(supabase, companyId, rows, account))
}

/**
 * Swedish refusal naming the twins (up to three) and the way out. A row
 * Skatteverket has not settled yet cannot be linked (linkSkattekontoRow
 * refuses it), so for `settled: false` the way out is to wait and link then.
 * A combined twin names how many other rows it links together (rows of the
 * same day or of the days around it, so the text names no day).
 */
export function ledgerTwinMessage(
  twins: SkattekontoLedgerTwin[],
  opts: { settled?: boolean; account: SkattekontoLedgerAccount },
): string {
  const ref = (t: SkattekontoLedgerTwin) =>
    t.voucher_number != null && t.voucher_number !== 0
      ? `verifikat ${formatVoucher(t)} (${t.entry_date})`
      : `ett utkast (${t.entry_date})`
  const shown = twins.slice(0, 3).map(ref)
  const rest = twins.length - shown.length
  const list =
    rest > 0
      ? `${shown.join(', ')} och ${rest} till`
      : shown.length > 1
        ? `${shown.slice(0, -1).join(', ')} och ${shown[shown.length - 1]}`
        : shown[0]
  const companions = twins.length === 1 ? twins[0].combined_with?.length ?? 0 : 0
  const target =
    twins.length > 1
      ? 'rätt verifikat'
      : companions === 1
        ? 'det tillsammans med en annan rad på skattekontot'
        : companions > 1
          ? `det tillsammans med ${companions} andra rader på skattekontot`
          : 'det'
  const wayOut =
    opts.settled === false
      ? `Skatteverket har inte genomfört händelsen ännu: vänta tills den är genomförd och koppla då raden till ${target} i stället för att bokföra händelsen en gång till. `
      : `Koppla raden till ${target} i stället för att bokföra händelsen en gång till. `
  return (
    `Händelsen finns redan i bokföringen: ${list} innehåller den redan på konto ${opts.account}. ` +
    wayOut +
    'Bokför ändå bara om händelsen verkligen har inträffat två gånger.'
  )
}

/**
 * What the ledger already holds of the open rows that have no verifikat of
 * their own, by the reconciliation's own arithmetic, so the booking guard,
 * the Avstämning page and the agent tools read one answer:
 *
 *   cover    the open rows up to a date that unlinked verifikat on 1630 hold
 *            in aggregate (a summarised year-end verifikat, crm#1043,
 *            findLedgerCoverPoint)
 *   planned  the open rows the ledger plan assigns to one open verifikat (a
 *            monthly summary from the previous system, PH 171), whatever
 *            their date: a row dated after the cover date is held all the
 *            same
 */
export interface SkattekontoLedgerHolding {
  /** The skattekonto account the holding is on (1630, or 2012 for an enskild firma that runs it there). */
  account: SkattekontoLedgerAccount
  cover: SkattekontoLedgerCover | null
  covered: Set<string>
  planned: Map<string, SkattekontoPlannedHold>
}

/**
 * The holding of a company: one bridge computation whatever the number of
 * rows; null when the company has no skattekonto. Throws when the ledger
 * cannot be read: without it no answer is safe, the same posture as the twin
 * search.
 */
export async function findSkattekontoLedgerHolding(
  supabase: SupabaseClient,
  companyId: string,
  account?: SkattekontoLedgerAccount,
): Promise<SkattekontoLedgerHolding | null> {
  const status = await getSkattekontoReconciliationStatus(supabase, companyId, { account })
  if (!status) return null
  if (status.ledger_read_failed) {
    throw new Error(
      `Kunde inte kontrollera om händelsen redan finns i bokföringen: konto ${status.account_number} kunde inte läsas. Försök igen.`,
    )
  }
  return {
    account: status.account_number as SkattekontoLedgerAccount,
    cover: status.cover,
    covered: new Set(status.cover?.event_ids ?? []),
    planned: skattekontoPlannedHolds(status) ?? new Map(),
  }
}

/**
 * The one check every booking door runs: does the ledger already hold this
 * open row? The refusal to give, or null. A planned row names the one
 * verifikat and the rows it holds, which is the more exact answer, so it wins
 * over the cover when both apply.
 */
export function ledgerHoldOf(
  holding: SkattekontoLedgerHolding | null,
  rowId: string,
): SkattekontoLedgerCoverInfo | null {
  if (!holding) return null
  const planned = holding.planned.get(rowId)
  if (planned) return toPlannedHoldInfo(planned, holding.account)
  return holding.covered.has(rowId) && holding.cover ? toLedgerCoverInfo(holding.cover) : null
}

/** The same check for several rows taken together: the answer only when the ledger holds every one of them. */
export function ledgerHoldOfRows(
  holding: SkattekontoLedgerHolding | null,
  rowIds: string[],
): SkattekontoLedgerCoverInfo | null {
  const holds = rowIds.map((id) => ledgerHoldOf(holding, id))
  return holds.length > 0 && holds.every((h) => h !== null) ? holds[0] : null
}

/** A planned row as the refusal carries it: the one verifikat and the rows of the link. */
function toPlannedHoldInfo(hold: SkattekontoPlannedHold, account: SkattekontoLedgerAccount): SkattekontoLedgerCoverInfo {
  const e = hold.entry
  return {
    account_number: account,
    through_date: hold.to_date,
    kind: 'planned_link',
    event_count: hold.event_ids.length,
    event_total: hold.total,
    event_ids: hold.event_ids,
    entries: [
      {
        journal_entry_id: e.journal_entry_id,
        voucher_series: e.voucher_series,
        voucher_number: e.voucher_number,
        entry_date: e.entry_date,
        description: e.description,
        status: e.status,
        open_amount: e.open_amount,
      },
    ],
    entry_count: 1,
  }
}

/** The cover as a refusal carries it: the totals and the largest verifikat. */
export function toLedgerCoverInfo(cover: SkattekontoLedgerCover): SkattekontoLedgerCoverInfo {
  return {
    account_number: cover.account_number,
    through_date: cover.through_date,
    kind: cover.kind,
    event_count: cover.event_count,
    event_total: cover.event_total,
    entries: cover.entries.slice(0, 5).map((e) => ({
      journal_entry_id: e.journal_entry_id,
      voucher_series: e.voucher_series,
      voucher_number: e.voucher_number,
      entry_date: e.entry_date,
      description: e.description,
      status: e.status,
      open_amount: e.open_amount,
    })),
    entry_count: cover.entries.length,
  }
}

/**
 * Swedish refusal for a row a summarised verifikat already covers: what the
 * arithmetic shows, which verifikat, and the way out (link, with a remainder
 * when the sums differ). Booking stays possible on an explicit override.
 */
export function ledgerCoverMessage(cover: SkattekontoLedgerCoverInfo): string {
  const ref = (t: SkattekontoLedgerCoverInfo['entries'][number]) =>
    t.voucher_number != null && t.voucher_number !== 0
      ? `${formatVoucher(t)} (${t.entry_date})`
      : `utan nummer (${t.entry_date})`
  const shown = cover.entries.slice(0, 3).map(ref)
  const rest = cover.entry_count - shown.length
  const list = rest > 0 ? `${shown.join(', ')} och ${rest} till` : shown.join(', ')
  const rows =
    cover.event_count === 1 ? 'den obokförda händelsen' : `de ${cover.event_count} obokförda händelserna`
  const total = formatCurrency(cover.event_total, 'SEK', { minimumFractionDigits: 2 })
  if (cover.kind === 'planned_link') {
    const others = cover.event_count - 1
    const held =
      others === 0
        ? 'den här händelsen'
        : others === 1
          ? 'den här händelsen och en annan obokförd händelse'
          : `den här händelsen och ${others} andra obokförda händelser`
    return (
      `Händelsen finns redan i bokföringen: verifikat ${list} på konto ${cover.account_number} är inte kopplat till någon händelse och motsvarar på öret ${held} (${total}). ` +
      'Koppla händelserna till verifikatet i stället för att bokföra dem en gång till (Avstämning, Skattekonto, Koppla föreslagna). ' +
      'Bokför ändå bara om händelsen verkligen saknas i bokföringen.'
    )
  }
  const proof =
    cover.kind === 'events_equal'
      ? `Verifikat på konto ${cover.account_number} som inte är kopplade till någon händelse (${list}) motsvarar exakt ${rows} t.o.m. ${cover.through_date} (${total}).`
      : `Konto ${cover.account_number} stämmer redan med Skatteverket per ${cover.through_date} fast ${rows} t.o.m. det datumet (${total}) saknar egna verifikat: de ingår i verifikat som inte är kopplade till någon händelse (${list}).`
  return (
    `Händelsen ser redan ut att vara bokförd. ${proof} ` +
    'Koppla händelserna till verifikatet i stället för att bokföra dem en gång till (Avstämning, Skattekonto, Matcha manuellt). ' +
    'Det verifikatet innehåller utöver händelserna står kvar som återstående belopp. ' +
    'Bokför ändå bara om händelsen verkligen saknas i bokföringen.'
  )
}

/** "verifikat A14 (2026-02-28)", up to three, "och N till" for the rest. */
function verifikatList(entries: SkattekontoLedgerTwin[]): string {
  const ref = (t: SkattekontoLedgerTwin) =>
    t.voucher_number != null && t.voucher_number !== 0
      ? `verifikat ${formatVoucher(t)} (${t.entry_date})`
      : `ett utkast (${t.entry_date})`
  const shown = entries.slice(0, 3).map(ref)
  const rest = entries.length - shown.length
  if (rest > 0) return `${shown.join(', ')} och ${rest} till`
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} och ${shown[shown.length - 1]}` : shown[0]
}

/**
 * Swedish refusal for a row whose event the ledger already holds without the
 * skattekonto (skattekonto-direct.ts): which verifikat, what it books, and
 * the ways out. Linking is no way out here: the verifikat has no line on
 * the skattekonto account to link (matchSkattekontoToEntry refuses it).
 */
export function ledgerDirectMessage(
  holders: SkattekontoLedgerTwin[],
  counter: SkattekontoCounterLine,
  account: SkattekontoLedgerAccount,
): string {
  const amount = formatCurrency(Math.abs(counter.net), 'SEK', { minimumFractionDigits: 2 })
  const what = isCashAccount(counter.account)
    ? `betalningen, ${amount} på konto ${counter.account},`
    : `${amount} på konto ${counter.account} direkt mot banken,`
  return (
    `Händelsen finns redan i bokföringen utan skattekontot: ${verifikatList(holders)} bokför redan ${what} utan någon rad på konto ${account}. ` +
    'Bokförs raden kommer händelsen med två gånger. ' +
    `Låt raden vara obokförd (ignorera den), eller rätta verifikatet så att betalningen går via konto ${account} och koppla sedan raden till det. ` +
    'Bokför ändå bara om händelsen verkligen saknas i bokföringen.'
  )
}

/** The longest reason an override keeps: what the verifikat notes carry. */
export const DUPLICATE_REASON_MAX_LENGTH = 500

/** The override's reason, trimmed and capped; null when none was given (no override). */
export function normaliseDuplicateReason(reason: unknown): string | null {
  if (typeof reason !== 'string') return null
  const trimmed = reason.trim().replace(/\s+/g, ' ')
  return trimmed ? trimmed.slice(0, DUPLICATE_REASON_MAX_LENGTH) : null
}

/**
 * The verifikat note of a booking over the guard: what the ledger already
 * held the event in, and the reason given. Plain Swedish, part of the
 * verifikation, so an auditor reads the decision where the entry is.
 */
export function duplicateOverrideNote(
  reason: string,
  twins: SkattekontoLedgerTwin[],
  held: SkattekontoLedgerCoverInfo | null,
  account: SkattekontoLedgerAccount,
  direct: SkattekontoLedgerTwin[] = [],
): string {
  const ref = (t: SkattekontoLedgerTwin) =>
    t.voucher_number != null && t.voucher_number !== 0 ? formatVoucher(t) : `utkast ${t.entry_date}`
  const refs = (twins.length > 0 ? twins : held ? held.entries : direct).slice(0, 5).map(ref).join(', ')
  return `Bokförd trots att bokföringen redan innehåller händelsen (${refs || `verifikat på konto ${account}`}). Skäl: ${reason}`
}

/**
 * Partial unique index journal_entries_system_source_live_unique (migration
 * 20260920145033): one live (draft or posted) source_type = 'system' entry per
 * (company_id, source_id). The booking below writes source_id = the
 * skattekonto row id, so a second Bokför racing the first for the same row
 * fails at the draft INSERT with 23505 before any draft exists. The engine
 * wraps the failure in BookkeepingDatabaseError and keeps only the Postgres
 * message, which names the index: match on that, the same technique as
 * isPeriodLockTriggerError.
 */
const SYSTEM_SOURCE_LIVE_UNIQUE_INDEX = 'journal_entries_system_source_live_unique'

function isSystemSourceLiveUniqueError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(SYSTEM_SOURCE_LIVE_UNIQUE_INDEX)
}

/** The skattekonto row fields the verifikat is built from. */
export interface SkattekontoEntrySource {
  id: string
  transaktionsdatum: string
  transaktionstext: string
  belopp_skatteverket: number | string
  transaktionsidentitet?: string | null
}

/**
 * The verifikat one skattekonto row books, everything but its fiscal period:
 * the builder bokforSkattekontoTransaction posts with and the MCP staging
 * preview shows (toEntryPreview), so the approver reads the executor's own
 * lines, not a description of them. Sign convention at the top of the file.
 */
export function buildSkattekontoEntry(
  tx: SkattekontoEntrySource,
  guess: CounterAccountMatch,
  account: SkattekontoLedgerAccount,
): Omit<CreateJournalEntryInput, 'fiscal_period_id'> {
  const amount = Math.abs(Number(tx.belopp_skatteverket))
  const isCreditToSkattekonto = Number(tx.belopp_skatteverket) > 0
  // A VAT refund that clears 1650 within 1 kr: the counter line takes the
  // receivable and the gap is a third line on 3740 (credit when the refund is
  // larger, debit when smaller). Only ever set on a credit to the skattekonto.
  const oreRounding = isCreditToSkattekonto ? (guess.oreRounding ?? 0) : 0
  const roundingLines: CreateJournalEntryLineInput[] =
    oreRounding === 0
      ? []
      : [
          {
            account_number: VAT_ROUNDING_ACCOUNT,
            debit_amount: oreRounding < 0 ? roundOre(-oreRounding) : 0,
            credit_amount: oreRounding > 0 ? roundOre(oreRounding) : 0,
            line_description: 'Öres- och kronutjämning',
          },
        ]

  const lines: CreateJournalEntryLineInput[] = isCreditToSkattekonto
    ? [
        {
          account_number: account,
          debit_amount: amount,
          credit_amount: 0,
          line_description: tx.transaktionstext,
        },
        {
          account_number: guess.account,
          debit_amount: 0,
          credit_amount: roundOre(amount - oreRounding),
          line_description: guess.label,
        },
        ...roundingLines,
      ]
    : [
        {
          account_number: guess.account,
          debit_amount: amount,
          credit_amount: 0,
          line_description: guess.label,
        },
        {
          account_number: account,
          debit_amount: 0,
          credit_amount: amount,
          line_description: tx.transaktionstext,
        },
      ]

  return {
    entry_date: tx.transaktionsdatum,
    description: `Skattekonto: ${tx.transaktionstext}`,
    source_type: 'system',
    source_id: tx.id,
    notes: `Genererad från skattekonto-synk. Skatteverket-id: ${tx.transaktionsidentitet ?? '-'}`,
    lines,
  }
}

/**
 * The counter line of a built skattekonto verifikat: the line that is not on
 * the skattekonto account and not the 3740 öresavrundning, in ledger sign.
 * What the direct-booking check (skattekonto-direct.ts) looks for.
 */
export function counterLineOf(
  entry: Pick<CreateJournalEntryInput, 'lines'>,
  account: SkattekontoLedgerAccount,
): SkattekontoCounterLine | null {
  const line = entry.lines.find(
    (l) => l.account_number !== account && l.account_number !== VAT_ROUNDING_ACCOUNT,
  )
  if (!line) return null
  return {
    account: line.account_number,
    net: roundOre(Number(line.debit_amount || 0) - Number(line.credit_amount || 0)),
  }
}

/**
 * Create a draft journal entry for one skattekonto_transactions row.
 *
 * Throws SkattekontoBookingError on:
 *   - already-booked rows (journal_entry_id present, or a live verifikat for
 *     the row already exists: journal_entries_system_source_live_unique)
 *   - a ledger twin: another live verifikat already carries the event on
 *     1630 (LEDGER_TWIN_EXISTS), unless overridden with a reason
 *   - a ledger hold: unlinked verifikat on 1630 already hold the event, in
 *     aggregate or by the ledger plan (LEDGER_COVER_EXISTS, ledgerHoldOf),
 *     unless overridden with a reason
 *   - a direct booking: a bank verifikat without any 1630 line already books
 *     the counter line in the event's month (LEDGER_DIRECT_EXISTS,
 *     skattekonto-direct.ts), unless overridden with a reason
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
  options?: {
    // requireSettled: reject rows that Skatteverket has not settled yet
    // (status !== 'booked'). The batch commit path sets this: a kommande row
    // must never land in an immutable posted verifikat. The single-row draft
    // endpoint keeps its historical behaviour (draft for user review).
    requireSettled?: boolean
    // duplicateReason: the override. Book even though the ledger already
    // holds the event (a twin, or a hold), because of this stated reason,
    // which the verifikat carries in its notes. Only an explicit per-row
    // decision by the user or agent sets it (the event really happened twice,
    // or really is missing from the books); no caller defaults it, and an
    // empty reason is no override.
    duplicateReason?: string
    // ledgerTwins: this row's twins, precomputed by a batch caller in one
    // search for all rows. Omitted → searched here for this row alone.
    ledgerTwins?: SkattekontoLedgerTwin[]
    // ledgerHolding: the company's holding (null = no skattekonto), computed
    // once by a batch caller. Omitted → computed here.
    ledgerHolding?: SkattekontoLedgerHolding | null
    // ledgerDirect: this row's direct holders, precomputed by a batch caller
    // for the counter line it resolved then. Used only while the counter
    // line is still the same (a refund booked earlier in the batch can move
    // the next one from 1650 to 2650); otherwise searched here.
    ledgerDirect?: { counter: SkattekontoCounterLine; holders: SkattekontoLedgerTwin[] }
  },
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

  // The ledger may already hold this event: a verifikat imported by SIE from
  // the previous system, a manual voucher, a bank-feed transfer. The feed's
  // dedup key only knows skattekonto rows, so without this check the same
  // event lands on 1630 twice. The test is the match flow's own candidate
  // search (exact öre and side, inside the window, not already linked, not a
  // storno pair), so the refusal names exactly what "Koppla" can link. It
  // runs before the rule match on purpose: for a twin the answer is Koppla,
  // never "create it manually", which would duplicate it by hand. A row
  // Skatteverket has not settled yet (the single-row draft path opens
  // kommande rows) cannot be linked either, so its refusal says to wait and
  // link once it is settled.
  //
  // The skattekonto account (1630, or 2012 for an enskild firma that runs it
  // there) is resolved once: the twin search, the holding, the rule context
  // and the verifikat all use the same account.
  const account = ruleContext?.account ?? (await resolveSkattekontoAccount(supabase, companyId))
  const reason = normaliseDuplicateReason(options?.duplicateReason)
  const twins =
    options?.ledgerTwins ??
    (await findSkattekontoLedgerTwins(supabase, companyId, [tx], account)).get(tx.id) ??
    []
  if (twins.length > 0 && !reason) {
    throw new SkattekontoBookingError(
      ledgerTwinMessage(twins, { settled: tx.status === 'booked', account }),
      'LEDGER_TWIN_EXISTS',
      twins,
    )
  }

  // No verifikat carries exactly this event, yet the ledger may hold it
  // inside a summarised one: a year-end verifikat that books every event of
  // the year on 1630, some of them from before the fetched history
  // (crm#1043), or a monthly summary the ledger plan assigns the row to
  // (PH 171), whatever the row's date. No amount search finds that. The
  // reconciliation's arithmetic does (ledgerHoldOf, the one check every
  // booking door runs). The answer is to link it there; the same override
  // books it anyway. Only a settled row is ever held (a kommande row is in
  // no saldo yet).
  const held =
    twins.length === 0 && tx.status === 'booked'
      ? ledgerHoldOf(
          options?.ledgerHolding !== undefined
            ? options.ledgerHolding
            : await findSkattekontoLedgerHolding(supabase, companyId, account),
          tx.id,
        )
      : null
  if (held && !reason) {
    throw new SkattekontoBookingError(ledgerCoverMessage(held), 'LEDGER_COVER_EXISTS', undefined, held)
  }

  // 2+3. Resolve counter-account via skattekonto_rules (entity_type decides
  // AB/EF-specific accounts; requires_employer gates payroll rules for a
  // non-employer enskild firma). The per-call path builds the same context
  // the batch path preloads, so both share one matcher and one gate.
  const ctx = ruleContext ?? (await loadRuleContext(supabase, companyId, { account }))
  // The 1650 balance is read fresh for every row (no memo): a batch commits
  // row by row, so a refund booked earlier in the batch is already counted.
  const outcome = await resolveCounterAccount(
    ctx,
    {
      transaktionstext: tx.transaktionstext,
      belopp: Number(tx.belopp_skatteverket),
      transaktionsdatum: tx.transaktionsdatum,
    },
    readVatReceivableBalance(supabase, companyId),
  )
  if (outcome.kind === 'employer_gated') {
    throw new SkattekontoBookingError(
      `"${tx.transaktionstext}" på en enskild firmas skattekonto är oftast skatt som en ` +
        'arbetsgivare dragit från din privata lön och ingen affärshändelse i firman: ' +
        'bokför manuellt om den ändå gäller firmans anställda, annars kan raden ignoreras.',
      'NO_COUNTER_ACCOUNT',
    )
  }
  const guess: CounterAccountMatch | null = outcome.kind === 'match' ? outcome.match : null
  if (!guess) {
    throw new SkattekontoBookingError(
      `Vi kunde inte gissa motkontot för "${tx.transaktionstext}". Skapa verifikatet manuellt.`,
      'NO_COUNTER_ACCOUNT',
    )
  }

  // The verifikat, from the builder the staging preview shows too.
  const built = buildSkattekontoEntry(tx, guess, ctx.account)

  // Nothing on the skattekonto account holds the event, yet the ledger may
  // hold it without that account: a previous system that paid the tax
  // straight from the bank to the tax accounts, or a bank line booked here
  // as 1930 against 2510 (PH 171). Every guard above reads the skattekonto
  // account and finds nothing. The check is the counter line itself: a bank
  // verifikat in the event's month that already books exactly it
  // (skattekonto-direct.ts). It needs the counter account, so it runs after
  // the rule match. Linking is no way out (no skattekonto line to link):
  // the answer is to leave the row unbooked, or to correct the verifikat;
  // the same override books it anyway.
  const counter = counterLineOf(built, ctx.account)
  const direct =
    twins.length === 0 && !held && counter
      ? options?.ledgerDirect && sameCounterLine(options.ledgerDirect.counter, counter)
        ? options.ledgerDirect.holders
        : ((
            await findDirectLedgerHolders(
              supabase,
              companyId,
              [{ id: tx.id, transaktionsdatum: tx.transaktionsdatum, counter }],
              ctx.account,
            )
          ).get(tx.id) ?? [])
      : []
  if (direct.length > 0 && counter && !reason) {
    throw new SkattekontoBookingError(
      ledgerDirectMessage(direct, counter, ctx.account),
      'LEDGER_DIRECT_EXISTS',
      undefined,
      undefined,
      direct,
    )
  }
  // Booked over a twin, a hold or a direct booking: the verifikat itself
  // says so, what it overrode and why, so the decision stays with the record
  // (BFNAR 2013:2 p. 9.16) whichever door booked it.
  const overrideNote =
    reason && (twins.length > 0 || held || direct.length > 0)
      ? duplicateOverrideNote(reason, twins, held, account, direct)
      : null

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

  // 5. The verifikat built above, in its fiscal period.
  const input: CreateJournalEntryInput = {
    ...built,
    ...(overrideNote ? { notes: `${built.notes} ${overrideNote}` } : {}),
    fiscal_period_id: fiscalPeriodId,
  }

  // The database is the arbiter of "one live verifikat per skattekonto row";
  // the precheck above is only the friendly fast path. A concurrent Bokför
  // that lost the race fails right here with nothing left behind, and gets
  // the same Swedish message the precheck gives.
  let entry: JournalEntry
  try {
    entry = await createDraftEntry(supabase, companyId, userId, input)
  } catch (err) {
    if (isSystemSourceLiveUniqueError(err)) {
      throw new SkattekontoBookingError(
        'Transaktionen är redan bokförd.',
        'ALREADY_BOOKED',
      )
    }
    throw err
  }

  // Link the row back so the dashboard can show "Bokförd" status. The
  // backlink is a conditional CLAIM, not a blind write: `.is('journal_entry_id',
  // null)` lets exactly one writer win the row. A concurrent Bokför can no
  // longer reach this point (the unique index above stops it), so zero
  // affected rows now means a concurrent Koppla (match to an existing
  // verifikat) took the row between our precheck and now: surface
  // ALREADY_BOOKED instead of double-posting. The just-created draft is left
  // behind unlinked: the engine has no sanctioned draft-discard function and
  // journal tables must never be raw-deleted, so an orphan draft (legally
  // deletable by the user in /bookkeeping) is the safe leftover.
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
 *
 * A row whose event the ledger already holds is skipped with
 * LEDGER_TWIN_EXISTS and its twins listed, or with LEDGER_COVER_EXISTS when
 * unlinked verifikat on 1630 hold it (ledgerHoldOf), or with
 * LEDGER_DIRECT_EXISTS when a bank verifikat without 1630 already books it
 * (skattekonto-direct.ts), unless its id is in `allowDuplicateIds` and a
 * `duplicateReason` is given: then it is booked and the verifikat notes the
 * reason. The twins of all rows are searched once
 * up front, and the holding is one bridge computation for the whole batch:
 * booking a row moves the same amount onto both sides of its date, so the
 * holding does not move while the other rows are booked.
 */
export async function bokforSkattekontoTransactionsBatch(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  ids: string[],
  options?: { allowDuplicateIds?: string[]; duplicateReason?: string },
): Promise<SkattekontoBatchResult> {
  const ruleContext = await loadRuleContext(supabase, companyId)
  // An override without a reason is no override: the guard stays on.
  const reason = normaliseDuplicateReason(options?.duplicateReason)
  const allowDuplicate = new Set(reason ? (options?.allowDuplicateIds ?? []) : [])
  // One candidate search for every open row. A row missing from the map
  // (booked, ignored or gone at read time) searches for itself if it is
  // still bookable when its turn comes. Overridden rows are searched too:
  // their verifikat names what they were booked over. Both read the
  // company's skattekonto account (PH 175).
  const twinsByRow = toLedgerTwinMap(
    await findLedgerTwinCandidatesForIds(supabase, companyId, ids, ruleContext.account),
  )
  const ledgerHolding =
    ids.length > 0 ? await findSkattekontoLedgerHolding(supabase, companyId, ruleContext.account) : null
  // The direct-booking check (skattekonto-direct.ts) for the rows neither a
  // twin nor the holding answers, in one search: each row's counter line is
  // resolved the way its booking resolves it. A row whose line has changed
  // by its turn (a refund before it cleared 1650) searches for itself.
  const directByRow = await findDirectLedgerHoldersForIds(
    supabase,
    companyId,
    ids.filter((id) => (twinsByRow.get(id)?.length ?? 0) === 0 && !ledgerHoldOf(ledgerHolding, id)),
    ruleContext.account,
    async (row) => {
      const outcome = await resolveCounterAccount(
        ruleContext,
        {
          transaktionstext: row.transaktionstext,
          belopp: Number(row.belopp_skatteverket),
          transaktionsdatum: row.transaktionsdatum,
        },
        readVatReceivableBalance(supabase, companyId),
      )
      return outcome.kind === 'match'
        ? counterLineOf(buildSkattekontoEntry(row, outcome.match, ruleContext.account), ruleContext.account)
        : null
    },
  )
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
        {
          // Batch rows commit immediately: never post an unsettled (kommande)
          // Skatteverket row into an immutable verifikat.
          requireSettled: true,
          ...(reason && allowDuplicate.has(id) ? { duplicateReason: reason } : {}),
          ledgerTwins: twinsByRow.get(id),
          ledgerHolding,
          ledgerDirect: directByRow.get(id),
        },
      )
    } catch (err) {
      if (err instanceof SkattekontoBookingError) {
        results.push({
          id,
          ok: false,
          error_code: err.code,
          error_message: err.message,
          ...(err.ledgerTwins ? { ledger_twins: err.ledgerTwins } : {}),
          ...(err.ledgerCover ? { ledger_cover: err.ledgerCover } : {}),
          ...(err.ledgerDirect ? { ledger_direct: err.ledgerDirect } : {}),
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
