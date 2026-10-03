/**
 * "Dela upp IB per projekt": split an existing ingående balans verifikat per
 * project, for a year whose IB was booked before project opening balances
 * were carried (issue #3313; #3328 carries them on every new year-end close
 * and SIE #OIB import).
 *
 * Basis: the PREVIOUS fiscal year's tagged closing balances, exactly what the
 * year-end generator splits on (fetchObjectClosingBalances over
 * compute_object_closing_balances, projected onto the dimensions whose
 * registry flag says they accumulate, projekt/dimension 6 today) and the same
 * line builder (buildOpeningBalanceLines). Each class 1-2 account with a
 * nonzero tagged closing balance becomes one line per object plus one
 * untagged remainder, `current IB total - sum(objects)`, any sign. The
 * account's total never moves, so the balance sheet, the unfiltered trial
 * balance, #IB export and the continuity check read what they read before.
 * Accounts without a tagged closing balance, and the VAT accounts (26xx,
 * carriesObjectBalances), are left untouched.
 *
 * Path: the inline rättelse of the IB verifikat (correct_entry_lines_inline,
 * migration 20260831150000): strike the account's lines and add the split
 * lines inside the SAME verifikat, the struck lines kept in
 * journal_entry_rattelse_log with who and when. That is one of the two
 * correction tracks BFL 5 kap 5 § allows, and only while the year is open,
 * unlocked, after the company lock date and without a posted bokslut. There
 * is deliberately no storno fallback: the storno route
 * (/api/import/opening-balance/correct) has the same gates, so it is
 * refused in exactly the states the inline rättelse is, and its lines carry
 * no dimension bags, so it could not express a split at all. A blocked year
 * is refused with a message that says what to open first.
 *
 * Safety:
 *   - nothing runs on its own: the preview writes nothing, the apply is an
 *     explicit user (or approved staged) action;
 *   - idempotent: an account whose lines already net to the proposed split
 *     per bag is unchanged, so a second run is a no-op. An account whose IB
 *     already carries a project split that differs from the proposal (an IB
 *     imported with SIE #OIB, or split by hand) is skipped, never
 *     overwritten: correct it line by line if it is wrong;
 *   - every bag is validated against the registry app-side before the RPC
 *     (which inserts bags unchecked, #3257): an accumulating dimension and an
 *     existing value. Archived values are kept, like the year-end carry: a
 *     finished project can still hold a 1470 balance;
 *   - the RPC takes at most 100 new lines: accounts are packed into calls of
 *     at most 100, and an account with more objects is split over several
 *     calls through an interim untagged remainder. Every call nets each
 *     account to its total, so a failure midway leaves consistent books; a
 *     rerun keeps the project lines already in place and continues from the
 *     interim remainder. A failure after a call committed is reported with
 *     what was applied (partialPostedIds: a staged approval lands in
 *     failed_partial, #842);
 *   - the caller may pin the preview's fingerprint: if the IB or the
 *     previous year changed in between, the apply refuses instead of booking
 *     a different split than the one approved.
 *
 * Not here (follow-up): a re-uploaded SIE file's #OIB 0 as a second source.
 * The parser exists (parseSIEFile objectOpeningBalances, planObjectBalances),
 * but the file transport through the dashboard, v1 and MCP doors does not.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildOpeningBalanceLines, fetchObjectClosingBalances } from '@/lib/core/bookkeeping/opening-balance-split'
import { carriesObjectBalances, dimensionBagKey, type ObjectBalanceSplit } from '@/lib/bookkeeping/dimension-carry'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** The inline rättelse RPC refuses more new lines per call. */
export const MAX_NEW_LINES_PER_RATTELSE = 100

const IN_CHUNK = 200

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A line of the IB verifikat as it stands. */
export interface CurrentIbLine {
  id: string
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description: string | null
  dimensions: Record<string, string>
  currency: string | null
}

/** A line as the preview shows it: one side, plus the signed amount. */
export interface SplitLineView {
  debit_amount: number
  credit_amount: number
  /** Signed, debit positive. */
  amount: number
  dimensions: Record<string, string>
  line_description: string | null
}

export type SplitAccountStatus = 'change' | 'unchanged' | 'skipped'

/**
 * Why an account that would change is left alone: its IB already carries a
 * project split that differs from the proposal (never overwritten), or the
 * inline rättelse can strike neither a foreign-currency line (its conversion
 * data cannot be reproduced) nor a line with its own underlag link.
 */
export type SplitSkipReason = 'existing_split' | 'foreign_currency' | 'line_document'

export interface SplitAccountPlan {
  account_number: string
  account_name: string | null
  /** The account's current IB, which the split keeps exactly. */
  total: number
  status: SplitAccountStatus
  skip_reason: SplitSkipReason | null
  current_lines: Array<SplitLineView & { journal_entry_line_id: string }>
  proposed_lines: SplitLineView[]
}

export interface UnresolvedDimension {
  sie_dim_no: string
  code: string
  reason: 'unknown_dimension' | 'resetting_dimension' | 'unknown_value'
  accounts: string[]
}

export interface SplitBlocker {
  code: string
  message_sv: string
  message_en: string
  details?: Record<string, unknown>
}

export interface OpeningBalanceSplitPreview {
  fiscal_period_id: string
  fiscal_period_name: string | null
  journal_entry_id: string | null
  /** The IB verifikat's label, e.g. "A1". */
  voucher: string | null
  source: 'previous_year'
  source_fiscal_period_id: string | null
  source_fiscal_period_name: string | null
  /** False while the previous year is still open: its balances may move. */
  source_period_closed: boolean | null
  /** SIE numbers of the dimensions whose balances carry, e.g. ["6"]. */
  accumulating_dimensions: string[]
  method: 'inline_rattelse'
  accounts_to_change: number
  accounts_unchanged: number
  accounts_skipped: number
  /**
   * What the split moves, in SEK: the largest side (debit or credit) of the
   * lines struck or added over the changing accounts. Read by the
   * unattended-commit ceiling, like correct_entry_lines_inline's.
   */
  changed_amount_sek: number
  /** True when there is something to split and nothing blocks it. */
  can_apply: boolean
  /** Why the split cannot run now (the code the apply answers), or null. */
  blocked: SplitBlocker | null
  unresolved_dimensions: UnresolvedDimension[]
  /** Names of the object codes the lines carry, for display. */
  dimension_values: Array<{ sie_dim_no: string; code: string; name: string; is_active: boolean }>
  accounts: SplitAccountPlan[]
  /** Identifies this exact split: pin it as expected_fingerprint. */
  fingerprint: string
}

export interface OpeningBalanceSplitResult {
  fiscal_period_id: string
  journal_entry_id: string
  /** False when the IB already matched the split: nothing was written. */
  applied: boolean
  accounts_changed: string[]
  accounts_skipped: Array<{ account_number: string; reason: SplitSkipReason }>
  lines_struck: number
  lines_added: number
  /** One journal_entry_rattelse_log row per inline rättelse call. */
  rattelse_log_ids: string[]
  fingerprint: string
}

export interface OpeningBalanceSplitInput {
  fiscal_period_id: string
  /** The preview's fingerprint: the apply refuses when the split changed since. */
  expected_fingerprint?: string
}

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

function signed(line: { debit_amount: number; credit_amount: number }): number {
  return roundOre((Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0))
}

function bagOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
    ),
  )
}

function isUntagged(bag: Record<string, string>): boolean {
  return Object.keys(bag).length === 0
}

/** Net per bag, zero nets dropped. */
function netsByBag(lines: ReadonlyArray<{ debit_amount: number; credit_amount: number; dimensions: Record<string, string> }>) {
  const nets = new Map<string, number>()
  for (const line of lines) {
    const key = dimensionBagKey(line.dimensions)
    nets.set(key, roundOre((nets.get(key) ?? 0) + signed(line)))
  }
  for (const [key, net] of nets) if (Math.abs(net) < ORE_TOLERANCE) nets.delete(key)
  return nets
}

function sameNets(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false
  for (const [key, net] of a) {
    const other = b.get(key)
    if (other === undefined || Math.abs(other - net) >= ORE_TOLERANCE) return false
  }
  return true
}

function view(line: { debit_amount: number; credit_amount: number; dimensions?: Record<string, string>; line_description?: string | null }): SplitLineView {
  const debit = roundOre(Number(line.debit_amount) || 0)
  const credit = roundOre(Number(line.credit_amount) || 0)
  return {
    debit_amount: debit,
    credit_amount: credit,
    amount: roundOre(debit - credit),
    dimensions: line.dimensions ?? {},
    line_description: line.line_description ?? null,
  }
}

/**
 * True when the account's current IB already carries a split on the
 * accumulating dimensions that the proposal would change: a carried bag whose
 * net the proposal does not hold. A split the proposal agrees with (an IB
 * split the same way, or the project lines an interrupted run already
 * booked) is not one; a tag on a resetting dimension never counts, it is
 * not carried at all.
 */
function hasConflictingSplit(
  current: readonly CurrentIbLine[],
  proposed: readonly SplitLineView[],
  accumulating: ReadonlySet<string>,
): boolean {
  const carried = netsByBag(
    current.map((line) => ({
      ...line,
      dimensions: Object.fromEntries(Object.entries(line.dimensions).filter(([dimNo]) => accumulating.has(dimNo))),
    })),
  )
  carried.delete(dimensionBagKey({}))
  const target = netsByBag(proposed)
  for (const [key, net] of carried) {
    const other = target.get(key)
    if (other === undefined || Math.abs(other - net) >= ORE_TOLERANCE) return true
  }
  return false
}

/**
 * The split per account, from the IB's current lines and the previous year's
 * tagged closing balances. Only accounts with a nonzero tagged balance are
 * planned (the rest stay untouched); each keeps its current total exactly,
 * which is asserted. `accumulatingDimensions` (default: the dimensions the
 * object balances carry) decides which current tags count as an existing
 * split.
 */
export function planOpeningBalanceSplit(input: {
  currentLines: readonly CurrentIbLine[]
  objectBalances: ReadonlyMap<string, readonly ObjectBalanceSplit[]>
  accountNames?: ReadonlyMap<string, string>
  lineIdsWithDocuments?: ReadonlySet<string>
  accumulatingDimensions?: ReadonlySet<string>
}): SplitAccountPlan[] {
  const { currentLines, objectBalances } = input
  const plans: SplitAccountPlan[] = []
  const accounts = [...objectBalances.keys()].filter((account) => carriesObjectBalances(account)).sort()
  const accumulating =
    input.accumulatingDimensions ??
    new Set([...objectBalances.values()].flatMap((parts) => parts.flatMap((part) => Object.keys(part.dimensions))))

  for (const accountNumber of accounts) {
    const parts = (objectBalances.get(accountNumber) ?? [])
      .map((part) => ({ dimensions: part.dimensions, amount: roundOre(part.amount) }))
      .filter((part) => part.amount !== 0 && !isUntagged(part.dimensions))
    if (parts.length === 0) continue

    const current = currentLines.filter((line) => line.account_number === accountNumber)
    const total = roundOre(current.reduce((sum, line) => sum + signed(line), 0))
    const accountName = input.accountNames?.get(accountNumber) ?? null

    const proposed = buildOpeningBalanceLines(
      [{ account_number: accountNumber, account_name: accountName ?? accountNumber, net: total }],
      new Map([[accountNumber, parts]]),
    ).map((line) => view({ ...line, dimensions: line.dimensions ?? {} }))

    // The split only moves amounts between tags: the account's IB must stay
    // exactly what it is, to the öre.
    const proposedTotal = roundOre(proposed.reduce((sum, line) => sum + line.amount, 0))
    if (Math.abs(proposedTotal - total) >= ORE_TOLERANCE) {
      throw new Error(`opening balance split: ${accountNumber} would move from ${total} to ${proposedTotal}`)
    }

    let status: SplitAccountStatus = sameNets(netsByBag(current), netsByBag(proposed)) ? 'unchanged' : 'change'
    let skipReason: SplitSkipReason | null = null
    if (status === 'change') {
      // An IB already split per project is left alone: only an untagged IB,
      // or one the proposal agrees with, is split.
      if (hasConflictingSplit(current, proposed, accumulating)) {
        skipReason = 'existing_split'
      } else if (current.some((line) => line.currency !== null && line.currency !== 'SEK')) {
        skipReason = 'foreign_currency'
      } else if (current.some((line) => input.lineIdsWithDocuments?.has(line.id))) {
        skipReason = 'line_document'
      }
      if (skipReason) status = 'skipped'
    }

    plans.push({
      account_number: accountNumber,
      account_name: accountName,
      total,
      status,
      skip_reason: skipReason,
      current_lines: current.map((line) => ({ ...view(line), journal_entry_line_id: line.id })),
      proposed_lines: proposed,
    })
  }
  return plans
}

/** One account's part of one rättelse call. */
export interface RattelseStep {
  account_number: string
  /** initial: strike the account's current lines; continue: strike its interim untagged remainder. */
  kind: 'initial' | 'continue'
  add: SplitLineView[]
}

/**
 * The tagged proposed lines a large account already holds, when that is all
 * its tagged lines hold: what an interrupted run booked before it stopped.
 * Each such line carries exactly a proposed bag (one line per bag) at exactly
 * the proposed amount. Null when any tagged line does not fit (the account
 * then starts over with an 'initial' step).
 */
function bookedProposedBags(account: SplitAccountPlan): Set<string> | null {
  const target = new Map(
    account.proposed_lines.filter((line) => !isUntagged(line.dimensions)).map((line) => [dimensionBagKey(line.dimensions), line.amount]),
  )
  const tagged = account.current_lines.filter((line) => !isUntagged(line.dimensions))
  if (tagged.length === 0) return null
  const booked = new Set<string>()
  for (const line of tagged) {
    const key = dimensionBagKey(line.dimensions)
    const amount = target.get(key)
    if (amount === undefined || booked.has(key) || Math.abs(amount - line.amount) >= ORE_TOLERANCE) return null
    booked.add(key)
  }
  return booked
}

/**
 * Pack the changing accounts into inline rättelse calls of at most `max` new
 * lines. An account that needs more is split over several calls: each adds
 * up to `max - 1` object lines and an untagged remainder that nets the
 * account back to its total, which the next call strikes again. A call never
 * holds two steps of one account (the second needs the first's line ids).
 *
 * A large account an interrupted run left half split (its tagged lines are
 * exactly proposed lines) resumes: the lines in place stay, and the first
 * step is a 'continue' that strikes only the interim remainder. Replanning
 * it from the start would strike and re-add the same lines, which the RPC
 * refuses as a rättelse that changes nothing.
 */
export function planRattelseCalls(accounts: readonly SplitAccountPlan[], max = MAX_NEW_LINES_PER_RATTELSE): RattelseStep[][] {
  const calls: RattelseStep[][] = []
  let open: RattelseStep[] = []
  let openSize = 0
  const large: SplitAccountPlan[] = []

  for (const account of accounts) {
    if (account.status !== 'change') continue
    const size = account.proposed_lines.length
    if (size > max) {
      large.push(account)
      continue
    }
    if (openSize + size > max && open.length > 0) {
      calls.push(open)
      open = []
      openSize = 0
    }
    open.push({ account_number: account.account_number, kind: 'initial', add: account.proposed_lines })
    openSize += size
  }
  if (open.length > 0) calls.push(open)

  for (const account of large) {
    const booked = bookedProposedBags(account)
    const tagged = account.proposed_lines.filter(
      (line) => !isUntagged(line.dimensions) && !booked?.has(dimensionBagKey(line.dimensions)),
    )
    const description = account.proposed_lines[0]?.line_description ?? null
    let carried = booked
      ? roundOre(account.current_lines.filter((line) => !isUntagged(line.dimensions)).reduce((sum, line) => sum + line.amount, 0))
      : 0
    for (let start = 0; start < tagged.length; start += max - 1) {
      const group = tagged.slice(start, start + max - 1)
      carried = roundOre(carried + group.reduce((sum, line) => sum + line.amount, 0))
      const remainder = roundOre(account.total - carried)
      const add = [...group]
      if (remainder !== 0) {
        add.push(
          view({
            debit_amount: remainder > 0 ? remainder : 0,
            credit_amount: remainder < 0 ? -remainder : 0,
            dimensions: {},
            line_description: description,
          }),
        )
      }
      calls.push([{ account_number: account.account_number, kind: start === 0 && !booked ? 'initial' : 'continue', add }])
    }
  }
  return calls
}

/**
 * The SEK the split moves: the largest side of what it strikes or adds. Both
 * sides count, because splitting a credit account (2440) strikes and adds
 * credits only; a debit-only sum would price that at zero.
 */
export function changedAmount(accounts: readonly SplitAccountPlan[]): number {
  const side = (lines: readonly SplitLineView[], key: 'debit_amount' | 'credit_amount') =>
    roundOre(lines.reduce((sum, line) => sum + line[key], 0))
  let struckDebit = 0
  let struckCredit = 0
  let addedDebit = 0
  let addedCredit = 0
  for (const account of accounts) {
    if (account.status !== 'change') continue
    struckDebit = roundOre(struckDebit + side(account.current_lines, 'debit_amount'))
    struckCredit = roundOre(struckCredit + side(account.current_lines, 'credit_amount'))
    addedDebit = roundOre(addedDebit + side(account.proposed_lines, 'debit_amount'))
    addedCredit = roundOre(addedCredit + side(account.proposed_lines, 'credit_amount'))
  }
  return Math.max(struckDebit, struckCredit, addedDebit, addedCredit)
}

/** Identifies the split: the IB entry, what is struck and what is added. */
export function splitFingerprint(journalEntryId: string | null, accounts: readonly SplitAccountPlan[]): string {
  const payload = accounts
    .filter((account) => account.status === 'change')
    .map((account) => [
      account.account_number,
      account.current_lines.map((line) => line.journal_entry_line_id).sort(),
      account.proposed_lines.map((line) => [line.amount, dimensionBagKey(line.dimensions)]),
    ])
  return createHash('sha256')
    .update(JSON.stringify([journalEntryId, payload]))
    .digest('hex')
    .slice(0, 32)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface PeriodRow {
  id: string
  name: string | null
  period_start: string
  period_end: string
  is_closed: boolean
  locked_at: string | null
  opening_balances_set: boolean | null
  opening_balance_entry_id: string | null
  previous_period_id: string | null
}

interface IbEntryRow {
  id: string
  status: string
  entry_date: string
  voucher_series: string | null
  voucher_number: number | null
}

interface RegistryDimension {
  id: string
  sie_dim_no: string
  resets_annually: boolean
}

function chunks<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function readIbLines(supabase: SupabaseClient, entryId: string): Promise<CurrentIbLine[]> {
  const rows = await fetchAllRows<{
    id: string
    account_number: string
    debit_amount: number | string
    credit_amount: number | string
    line_description: string | null
    dimensions: unknown
    currency: string | null
  }>(
    ({ from, to }) =>
      supabase
        .from('journal_entry_lines')
        .select('id, account_number, debit_amount, credit_amount, line_description, dimensions, currency')
        .eq('journal_entry_id', entryId)
        .order('id', { ascending: true })
        .range(from, to),
    { dedupeBy: (row) => row.id },
  )
  return rows.map((row) => ({
    id: row.id,
    account_number: String(row.account_number),
    debit_amount: Number(row.debit_amount) || 0,
    credit_amount: Number(row.credit_amount) || 0,
    line_description: row.line_description ?? null,
    dimensions: bagOf(row.dimensions),
    currency: row.currency ?? null,
  }))
}

/** The ISO date before an ISO date (calendar arithmetic in UTC, no time zone drift). */
function dayBefore(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

async function readPreviousPeriod(
  supabase: SupabaseClient,
  companyId: string,
  period: PeriodRow,
): Promise<{ id: string; name: string | null; is_closed: boolean } | null> {
  // The BFNAR 2013:2 continuity chain first; otherwise the year that ends the
  // day before this one starts. Never an earlier year across a gap: its
  // closing balances are not this year's opening basis.
  const query = supabase.from('fiscal_periods').select('id, name, is_closed, period_end').eq('company_id', companyId)
  const { data, error } = period.previous_period_id
    ? await query.eq('id', period.previous_period_id).maybeSingle()
    : await query.eq('period_end', dayBefore(period.period_start)).limit(1).maybeSingle()
  if (error) throw new Error(`Failed to read the previous fiscal year: ${error.message}`)
  const row = data as { id: string; name: string | null; is_closed: boolean } | null
  return row ? { id: row.id, name: row.name ?? null, is_closed: Boolean(row.is_closed) } : null
}

async function readRegistry(supabase: SupabaseClient, companyId: string): Promise<RegistryDimension[]> {
  const { data, error } = await supabase
    .from('dimensions')
    .select('id, sie_dim_no, resets_annually')
    .eq('company_id', companyId)
  if (error) throw new Error(`Failed to read the dimension registry: ${error.message}`)
  return ((data ?? []) as Array<{ id: string; sie_dim_no: number | string; resets_annually: boolean }>).map((row) => ({
    id: row.id,
    sie_dim_no: String(Number(row.sie_dim_no)),
    resets_annually: row.resets_annually !== false,
  }))
}

async function readAccountNames(supabase: SupabaseClient, companyId: string, accounts: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  for (const part of chunks(accounts)) {
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .select('account_number, account_name')
      .eq('company_id', companyId)
      .in('account_number', part)
    if (error) throw new Error(`Failed to read the chart of accounts: ${error.message}`)
    for (const row of (data ?? []) as Array<{ account_number: string; account_name: string | null }>) {
      if (row.account_name && !names.has(row.account_number)) names.set(row.account_number, row.account_name)
    }
  }
  return names
}

async function readLinesWithDocuments(supabase: SupabaseClient, lineIds: string[]): Promise<Set<string>> {
  const linked = new Set<string>()
  for (const part of chunks(lineIds)) {
    const { data, error } = await supabase
      .from('document_attachments')
      .select('journal_entry_line_id')
      .in('journal_entry_line_id', part)
    if (error) throw new Error(`Failed to read line-level underlag links: ${error.message}`)
    for (const row of (data ?? []) as Array<{ journal_entry_line_id: string | null }>) {
      if (row.journal_entry_line_id) linked.add(row.journal_entry_line_id)
    }
  }
  return linked
}

/**
 * Every bag the split would write, resolved against the registry: the key a
 * dimension that accumulates, the code an existing value of it. Archived
 * values (and archived dimensions) resolve: their balances are carried from
 * posted history, as the year-end does. Strict, not fail-open: the RPC
 * inserts whatever it is handed (#3257).
 */
async function resolveBags(
  supabase: SupabaseClient,
  companyId: string,
  registry: readonly RegistryDimension[],
  accounts: readonly SplitAccountPlan[],
): Promise<{
  unresolved: UnresolvedDimension[]
  values: Array<{ sie_dim_no: string; code: string; name: string; is_active: boolean }>
}> {
  const used = new Map<string, { sie_dim_no: string; code: string; accounts: Set<string> }>()
  for (const account of accounts) {
    for (const line of account.proposed_lines) {
      for (const [dimNo, code] of Object.entries(line.dimensions)) {
        const key = `${dimNo}\u0000${code}`
        const entry = used.get(key) ?? { sie_dim_no: dimNo, code, accounts: new Set<string>() }
        entry.accounts.add(account.account_number)
        used.set(key, entry)
      }
    }
  }
  if (used.size === 0) return { unresolved: [], values: [] }

  const byNo = new Map(registry.map((dimension) => [dimension.sie_dim_no, dimension]))
  const unresolved: UnresolvedDimension[] = []
  const lookups: Array<{ dimension: RegistryDimension; code: string; accounts: Set<string> }> = []
  for (const entry of used.values()) {
    const dimension = byNo.get(entry.sie_dim_no)
    const reason = !dimension ? 'unknown_dimension' : dimension.resets_annually ? 'resetting_dimension' : null
    if (reason) {
      unresolved.push({ sie_dim_no: entry.sie_dim_no, code: entry.code, reason, accounts: [...entry.accounts].sort() })
    } else {
      lookups.push({ dimension: dimension!, code: entry.code, accounts: entry.accounts })
    }
  }

  const found = new Map<string, { name: string; is_active: boolean }>()
  const dimensionIds = [...new Set(lookups.map((lookup) => lookup.dimension.id))]
  for (const part of chunks([...new Set(lookups.map((lookup) => lookup.code))])) {
    if (dimensionIds.length === 0) break
    const { data, error } = await supabase
      .from('dimension_values')
      .select('dimension_id, code, name, is_active')
      .eq('company_id', companyId)
      .in('dimension_id', dimensionIds)
      .in('code', part)
    if (error) throw new Error(`Failed to read dimension values: ${error.message}`)
    for (const row of (data ?? []) as Array<{ dimension_id: string; code: string; name: string | null; is_active: boolean | null }>) {
      found.set(`${row.dimension_id}\u0000${row.code}`, { name: row.name ?? row.code, is_active: row.is_active !== false })
    }
  }

  const values: Array<{ sie_dim_no: string; code: string; name: string; is_active: boolean }> = []
  for (const lookup of lookups) {
    const value = found.get(`${lookup.dimension.id}\u0000${lookup.code}`)
    if (value) {
      values.push({ sie_dim_no: lookup.dimension.sie_dim_no, code: lookup.code, ...value })
    } else {
      unresolved.push({
        sie_dim_no: lookup.dimension.sie_dim_no,
        code: lookup.code,
        reason: 'unknown_value',
        accounts: [...lookup.accounts].sort(),
      })
    }
  }
  const order = (a: { sie_dim_no: string; code: string }, b: { sie_dim_no: string; code: string }) =>
    Number(a.sie_dim_no) - Number(b.sie_dim_no) || a.code.localeCompare(b.code, 'sv')
  return { unresolved: unresolved.sort(order), values: values.sort(order) }
}

function blocker(code: string, details?: Record<string, unknown>, messageSv?: string): SplitBlocker {
  const entry = getErrorEntry(code)
  return {
    code,
    message_sv: messageSv ?? entry?.message_sv ?? code,
    message_en: entry?.message_en ?? code,
    ...(details ? { details } : {}),
  }
}

function unresolvedMessage(unresolved: readonly UnresolvedDimension[]): string {
  const codes = unresolved.slice(0, 5).map((u) => `${u.code} (dimension ${u.sie_dim_no})`)
  const more = unresolved.length > 5 ? ` och ${unresolved.length - 5} till` : ''
  return `Följande objekt med saldo finns inte i dimensionsregistret som en dimension som förs vidare mellan år: ${codes.join(', ')}${more}. Lägg upp dem under Dimensioner och försök igen.`
}

interface SplitState {
  preview: OpeningBalanceSplitPreview
  /** The IB's lines as read, for the apply's staleness check. */
  currentLines: CurrentIbLine[]
}

/**
 * Read everything the split needs and plan it. The plan is computed whenever
 * the year has an IB and a previous year, even when the year is locked, so
 * the preview can show what would change and what to open first.
 */
async function loadSplitState(ctx: OperationContext, fiscalPeriodId: string): Promise<SplitState | Failure> {
  const { supabase, companyId } = ctx

  const { data: periodData, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end, is_closed, locked_at, opening_balances_set, opening_balance_entry_id, previous_period_id')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (periodError) throw new Error(`Failed to read the fiscal year: ${periodError.message}`)
  if (!periodData) return { ok: false, code: 'OB_PERIOD_NOT_FOUND' }
  const period = periodData as PeriodRow

  const preview: OpeningBalanceSplitPreview = {
    fiscal_period_id: period.id,
    fiscal_period_name: period.name ?? null,
    journal_entry_id: null,
    voucher: null,
    source: 'previous_year',
    source_fiscal_period_id: null,
    source_fiscal_period_name: null,
    source_period_closed: null,
    accumulating_dimensions: [],
    method: 'inline_rattelse',
    accounts_to_change: 0,
    accounts_unchanged: 0,
    accounts_skipped: 0,
    changed_amount_sek: 0,
    can_apply: false,
    blocked: null,
    unresolved_dimensions: [],
    dimension_values: [],
    accounts: [],
    fingerprint: splitFingerprint(null, []),
  }

  // The IB verifikat: the period's CURRENT linked entry, posted (the
  // RPC's own target rule).
  let entry: IbEntryRow | null = null
  if (period.opening_balances_set && period.opening_balance_entry_id) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, status, entry_date, voucher_series, voucher_number')
      .eq('id', period.opening_balance_entry_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw new Error(`Failed to read the opening balance entry: ${error.message}`)
    entry = (data as IbEntryRow | null) ?? null
  }
  if (!entry || entry.status !== 'posted') {
    preview.blocked = blocker('OB_CORRECT_NO_EXISTING')
    return { preview, currentLines: [] }
  }
  preview.journal_entry_id = entry.id
  preview.voucher = entry.voucher_series && entry.voucher_number ? `${entry.voucher_series}${entry.voucher_number}` : null

  const previous = await readPreviousPeriod(supabase, companyId, period)
  if (!previous) {
    preview.blocked = blocker('OB_SPLIT_NO_PREVIOUS_YEAR')
    return { preview, currentLines: [] }
  }
  preview.source_fiscal_period_id = previous.id
  preview.source_fiscal_period_name = previous.name
  preview.source_period_closed = previous.is_closed

  const registry = await readRegistry(supabase, companyId)
  const accumulating = new Set(registry.filter((d) => !d.resets_annually).map((d) => d.sie_dim_no))
  preview.accumulating_dimensions = [...accumulating].sort((a, b) => Number(a) - Number(b))

  const [currentLines, objectBalances] = await Promise.all([
    readIbLines(supabase, entry.id),
    fetchObjectClosingBalances(supabase, companyId, previous.id, accumulating),
  ])

  const candidates = [...objectBalances.keys()].filter((account) => carriesObjectBalances(account))
  const candidateLineIds = currentLines.filter((line) => candidates.includes(line.account_number)).map((line) => line.id)
  const [accountNames, lineIdsWithDocuments] = await Promise.all([
    readAccountNames(supabase, companyId, candidates),
    readLinesWithDocuments(supabase, candidateLineIds),
  ])

  const accounts = planOpeningBalanceSplit({
    currentLines,
    objectBalances,
    accountNames,
    lineIdsWithDocuments,
    accumulatingDimensions: accumulating,
  })
  const changing = accounts.filter((account) => account.status === 'change')
  const { unresolved, values } = await resolveBags(supabase, companyId, registry, accounts)

  preview.accounts = accounts
  preview.accounts_to_change = changing.length
  preview.accounts_unchanged = accounts.filter((account) => account.status === 'unchanged').length
  preview.accounts_skipped = accounts.filter((account) => account.status === 'skipped').length
  preview.changed_amount_sek = changedAmount(changing)
  preview.unresolved_dimensions = unresolved
  preview.dimension_values = values
  preview.fingerprint = splitFingerprint(entry.id, accounts)

  // What would block the apply, in the order the user has to fix it.
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('bookkeeping_locked_through')
    .eq('company_id', companyId)
    .maybeSingle()
  // A failed read must not look like "no lock date": the preview would offer
  // a split the RPC then refuses.
  if (settingsError) throw new Error(`Failed to read the company lock date: ${settingsError.message}`)
  const lockDate = ((settings as { bookkeeping_locked_through?: string | null } | null)?.bookkeeping_locked_through ?? null) as string | null
  const { count: yearEndCount, error: yearEndError } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('fiscal_period_id', period.id)
    .eq('source_type', 'year_end')
    .eq('status', 'posted')
  if (yearEndError) throw new Error(`Failed to read the year-end state: ${yearEndError.message}`)

  const unresolvedChanging = unresolved.filter((u) => u.accounts.some((a) => changing.some((c) => c.account_number === a)))
  if (period.is_closed) preview.blocked = blocker('OB_SPLIT_PERIOD_CLOSED')
  else if (period.locked_at) preview.blocked = blocker('OB_SPLIT_PERIOD_LOCKED')
  else if (lockDate && entry.entry_date <= lockDate) {
    // The dated sentence the error mapper composes for this code.
    const messageSv = getUserErrorMessage({ error: { code: 'OB_COMPANY_LOCK_DATE', details: { lockDate } } }, { locale: 'sv' })
    preview.blocked = blocker('OB_COMPANY_LOCK_DATE', { lockDate, entryDate: entry.entry_date }, messageSv)
  } else if ((yearEndCount ?? 0) > 0) preview.blocked = blocker('OB_CORRECT_YEAR_END_EXISTS')
  else if (unresolvedChanging.length > 0) {
    preview.blocked = blocker('OB_SPLIT_DIMENSION_UNRESOLVED', { unresolved: unresolvedChanging }, unresolvedMessage(unresolvedChanging))
  }
  preview.can_apply = preview.accounts_to_change > 0 && preview.blocked === null

  return { preview, currentLines }
}

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

function unexpected(ctx: OperationContext, err: unknown, message: string): Failure {
  ctx.log.error(message, err as Error)
  return { ok: false, code: 'OB_SPLIT_FAILED', details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' } }
}

/**
 * The split as it would run now: per account the current lines and the
 * proposed ones, which accounts change, and what (if anything) blocks the
 * apply. Writes nothing.
 */
export async function previewOpeningBalanceSplit(
  ctx: OperationContext,
  input: { fiscal_period_id: string },
): Promise<OperationOutcome<OpeningBalanceSplitPreview>> {
  try {
    const state = await loadSplitState(ctx, input.fiscal_period_id)
    if ('ok' in state) return state
    return { ok: true, data: state.preview }
  } catch (err) {
    return unexpected(ctx, err, 'opening balance split preview failed')
  }
}

interface AppliedSoFar {
  entryId: string
  accounts: string[]
  logIds: string[]
}

/**
 * What earlier calls of this run already applied, for a failure after one of
 * them committed: in the details (accounts_changed, rattelse_log_ids) and as
 * partialPostedIds, so a staged approval lands in failed_partial with the
 * rättelser it made instead of reading as a clean rejection (#842). The books
 * are consistent either way: every call keeps each account at its total, and
 * a rerun continues from where this one stopped.
 */
function appliedSoFar(done: AppliedSoFar): Pick<Failure, 'details' | 'partialPostedIds'> {
  if (done.logIds.length === 0 && done.accounts.length === 0) return {}
  return {
    details: { accounts_changed: [...done.accounts], rattelse_log_ids: [...done.logIds] },
    partialPostedIds: {
      journal_entry_id: done.entryId,
      ...(done.logIds.length ? { rattelse_log_ids: done.logIds.join(',') } : {}),
      accounts_changed: done.accounts.join(','),
    },
  }
}

/** A refusal from correct_entry_lines_inline, mapped to the code the pre-flight would answer. */
function rpcFailure(error: { code?: string; message?: string }, done: AppliedSoFar): Failure {
  const partial = appliedSoFar(done)
  const message = error.message ?? ''
  if (error.code === '42501') return { ok: false, code: 'FORBIDDEN', ...partial }
  if (error.code === 'P0001') {
    // The RPC points at storno for a locked year; for a split that is the
    // wrong advice (storno carries no bags), so answer this action's own codes.
    if (/stängd eller låst/i.test(message)) return { ok: false, code: 'OB_SPLIT_PERIOD_LOCKED', ...partial }
    if (/Bokföringen är låst/i.test(message)) return { ok: false, code: 'OB_COMPANY_LOCK_DATE', ...partial }
    if (/bokslut/i.test(message)) return { ok: false, code: 'OB_CORRECT_YEAR_END_EXISTS', ...partial }
    return { ok: false, code: 'OB_SPLIT_REFUSED', ...partial, messageSv: getUserErrorMessage(error, { locale: 'sv' }) }
  }
  return {
    ok: false,
    code: 'OB_SPLIT_FAILED',
    ...partial,
    details: { ...(partial.details ?? {}), reason: getUserErrorMessage(error) },
  }
}

/**
 * Split the year's IB verifikat per project through inline rättelse. With
 * dryRun it answers the preview and writes nothing (also the MCP staging
 * preview). A split that is already in place answers applied: false; its dry
 * run answers OB_SPLIT_NOTHING_TO_DO, so nobody stages (and has to approve)
 * an operation that would write nothing.
 */
export async function splitOpeningBalancesPerProject(
  ctx: OperationContext,
  input: OpeningBalanceSplitInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<OpeningBalanceSplitResult>> {
  const { supabase, companyId, userId, log } = ctx
  let state: SplitState
  try {
    const loaded = await loadSplitState(ctx, input.fiscal_period_id)
    if ('ok' in loaded) return loaded
    state = loaded
  } catch (err) {
    return unexpected(ctx, err, 'opening balance split failed to load')
  }
  const { preview } = state

  if (input.expected_fingerprint && input.expected_fingerprint !== preview.fingerprint) {
    return { ok: false, code: 'OB_SPLIT_PROPOSAL_CHANGED', details: { fingerprint: preview.fingerprint } }
  }

  const changing = preview.accounts.filter((account) => account.status === 'change')
  const skipped = preview.accounts
    .filter((account) => account.status === 'skipped' && account.skip_reason)
    .map((account) => ({ account_number: account.account_number, reason: account.skip_reason! }))

  // Nothing to change is a no-op whatever state the year is in (a split
  // already in place is never refused, so running it twice is harmless), but
  // only once there was an IB and a previous year to compare with.
  const nothingToDo =
    changing.length === 0 && preview.journal_entry_id !== null && preview.source_fiscal_period_id !== null
  if (!nothingToDo && preview.blocked) {
    return {
      ok: false,
      code: preview.blocked.code,
      ...(preview.blocked.details ? { details: preview.blocked.details } : {}),
      ...(preview.blocked.code === 'OB_SPLIT_DIMENSION_UNRESOLVED' ? { messageSv: preview.blocked.message_sv } : {}),
    }
  }

  if (options.dryRun) {
    if (nothingToDo) {
      return {
        ok: false,
        code: 'OB_SPLIT_NOTHING_TO_DO',
        details: { accounts_unchanged: preview.accounts_unchanged, accounts_skipped: skipped },
      }
    }
    return { ok: true, dryRun: true, preview: preview as unknown as Record<string, unknown> }
  }

  const entryId = preview.journal_entry_id!
  if (nothingToDo) {
    return {
      ok: true,
      data: {
        fiscal_period_id: preview.fiscal_period_id,
        journal_entry_id: entryId,
        applied: false,
        accounts_changed: [],
        accounts_skipped: skipped,
        lines_struck: 0,
        lines_added: 0,
        rattelse_log_ids: [],
        fingerprint: preview.fingerprint,
      },
    }
  }

  const plannedStrikes = new Map(
    changing.map((account) => [account.account_number, account.current_lines.map((line) => line.journal_entry_line_id)]),
  )
  const calls = planRattelseCalls(changing)
  const done: AppliedSoFar = { entryId, accounts: [], logIds: [] }
  const started = new Set<string>()
  let linesStruck = 0
  let linesAdded = 0

  try {
    let lines = state.currentLines
    for (const [index, call] of calls.entries()) {
      if (index > 0) lines = await readIbLines(supabase, entryId)
      const strike: string[] = []
      for (const step of call) {
        const accountLines = lines.filter((line) => line.account_number === step.account_number)
        if (!started.has(step.account_number)) {
          // An account's first step: the lines the plan saw must still be the
          // account's lines. A concurrent edit means the split is no longer
          // the one previewed.
          started.add(step.account_number)
          const planned = new Set(plannedStrikes.get(step.account_number) ?? [])
          const ids = accountLines.map((line) => line.id)
          if (ids.length !== planned.size || ids.some((id) => !planned.has(id))) {
            const partial = appliedSoFar(done)
            return {
              ok: false,
              code: 'OB_SPLIT_PROPOSAL_CHANGED',
              ...partial,
              details: { ...(partial.details ?? {}), fingerprint: preview.fingerprint },
            }
          }
        }
        // initial: every line of the account; continue: the interim untagged
        // remainder (the project lines already in place stay).
        const struck = step.kind === 'initial' ? accountLines : accountLines.filter((line) => isUntagged(line.dimensions))
        strike.push(...struck.map((line) => line.id))
      }
      const newLines = call.flatMap((step) =>
        step.add.map((line) => ({
          account_number: step.account_number,
          debit_amount: line.debit_amount,
          credit_amount: line.credit_amount,
          line_description: line.line_description,
          dimensions: line.dimensions,
        })),
      )

      const { data, error } = await supabase.rpc('correct_entry_lines_inline', {
        p_company_id: companyId,
        p_entry_id: entryId,
        p_strike_line_ids: strike,
        p_new_lines: newLines,
        p_user_id: userId,
      })
      if (error) {
        log.error('opening balance split: inline rättelse refused', new Error(error.message), {
          entryId,
          accounts: call.map((step) => step.account_number),
          accountsChanged: done.accounts,
        })
        return rpcFailure(error, done)
      }
      const logId = (data as { log_id?: string } | null)?.log_id
      if (logId) done.logIds.push(logId)
      linesStruck += strike.length
      linesAdded += newLines.length
      for (const step of call) if (!done.accounts.includes(step.account_number)) done.accounts.push(step.account_number)
    }
  } catch (err) {
    const failure = unexpected(ctx, err, 'opening balance split failed')
    const partial = appliedSoFar(done)
    return { ...failure, ...partial, details: { ...(partial.details ?? {}), ...failure.details } }
  }

  // Post-check: every account still nets to its IB. The RPC keeps the entry
  // balanced; this catches a per-account drift, which must never happen.
  try {
    const after = await readIbLines(supabase, entryId)
    for (const account of changing) {
      const net = roundOre(after.filter((l) => l.account_number === account.account_number).reduce((s, l) => s + signed(l), 0))
      if (Math.abs(net - account.total) >= ORE_TOLERANCE) {
        log.error('opening balance split moved an account total', new Error('per-account IB drift'), {
          alert: true,
          companyId,
          entryId,
          account: account.account_number,
          expected: account.total,
          actual: net,
        })
      }
    }
  } catch (err) {
    log.warn('opening balance split: post-check read failed', { error: err instanceof Error ? err.message : String(err) })
  }

  log.info('audit: opening balance split per project', {
    audit: true,
    event: 'opening_balance.split_per_project',
    companyId,
    userId,
    fiscalPeriodId: preview.fiscal_period_id,
    entryId,
    accounts: done.accounts,
    rattelseLogIds: done.logIds,
  })

  return {
    ok: true,
    data: {
      fiscal_period_id: preview.fiscal_period_id,
      journal_entry_id: entryId,
      applied: true,
      accounts_changed: done.accounts,
      accounts_skipped: skipped,
      lines_struck: linesStruck,
      lines_added: linesAdded,
      rattelse_log_ids: done.logIds,
      fingerprint: preview.fingerprint,
    },
  }
}
