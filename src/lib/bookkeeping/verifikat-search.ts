import { parseAmountTerm } from '@/lib/money'
import { isAccountNumber, isSaneDateString } from '@/lib/invariants'
import { addDaysIso, addMonthsIso } from '@/lib/dates/iso'
import { parseVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { escapeLikePattern } from '@/lib/supabase/like-pattern'

/**
 * What a search over verifikat reads in its needle besides plain text. One
 * reading for the two boxes that search verifikat: the verifikat list (the
 * journal-entries route turns it into its query, readVerifikatQuerySearch)
 * and the huvudbok's row search (lib/reports/general-ledger-rows.ts), so
 * "A71", "12 500 kr" and "2026-03-15" mean the same thing in both. Pure and
 * client-safe.
 *
 * Every reading is an addition to the text match, never a replacement: a
 * needle that is also an amount still finds the verifikat that mention its
 * digits. A needle can be several things at once ("1930" is an account number
 * and 1 930 kr), and then all of them apply.
 */
export interface VerifikatSearch {
  /** A voucher label: "A209", "a 209", "A-209". */
  voucher: { series: string; number: number } | null
  /** A four-digit account number, as text. */
  account: string | null
  /**
   * An amount above zero, as its magnitude in kronor to the öre: "12 500",
   * "12500", "12 500,50", "12500.5", "12 500 kr" (parseAmountTerm, the search
   * boxes' one amount parser).
   */
  amount: number | null
  /**
   * A bokföringsdatum, first and last day inclusive: one day ("2026-03-15")
   * or a whole month ("2026-03"). A bare year is not a date here: four digits
   * are an account number and an amount, and a year matches most of the list.
   */
  dates: { from: string; to: string } | null
}

/**
 * Past this an amount is no longer the digits that were typed (a double
 * stops holding whole öre near 9e13) and prints with an exponent further up.
 * No ledger line comes near it.
 */
const MAX_SEARCH_AMOUNT = 1e13

const MONTH_RE = /^\d{4}-\d{2}$/

function readAmount(needle: string): number | null {
  const amount = parseAmountTerm(needle)
  // Zero is not an amount to look for: every line has one side at zero.
  return amount !== null && amount > 0 && amount < MAX_SEARCH_AMOUNT ? amount : null
}

function readDates(needle: string): { from: string; to: string } | null {
  if (isSaneDateString(needle)) return { from: needle, to: needle }
  if (!MONTH_RE.test(needle)) return null
  const first = `${needle}-01`
  if (!isSaneDateString(first)) return null
  return { from: first, to: addDaysIso(addMonthsIso(first, 1), -1) }
}

export function readVerifikatSearch(search: string): VerifikatSearch {
  const needle = search.trim()
  return {
    voucher: parseVoucher(needle),
    account: isAccountNumber(needle) ? needle : null,
    amount: readAmount(needle),
    dates: readDates(needle),
  }
}

/** What bounds the verifikat a journal_entries query searches: the fiscal period it is filtered to, if any. */
export interface VerifikatSearchScope {
  periodId: string | null | undefined
}

/**
 * Whether a search over journal_entries may read an amount. An amount is
 * looked up on the lines, one probe per verifikat of the set (no index holds
 * an amount), so its cost follows the set. Inside one fiscal period the count
 * answers within two seconds also for a year of tens of thousands of
 * verifikat; across every year of a very large ledger the count and the first
 * page each pass the 8 s statement timeout. Bounded therefore means
 * filtered to one fiscal period. A date range is not a bound: it can be open
 * at one end or span every year.
 */
export function isBoundedVerifikatScope(scope: VerifikatSearchScope): boolean {
  return Boolean(scope.periodId)
}

/**
 * The reading of a needle that a journal_entries query applies: what
 * readVerifikatSearch reads, without the amount when the query is not
 * bounded. An unbounded search then finds what it found before amounts were
 * read (text, the voucher label, the account) and a date, which is a column
 * of the verifikat itself. This is the one place that decides:
 * verifikatSearchJoins and applyVerifikatSearch take the needle it returns,
 * so the joins in the select and the filters on them cannot disagree.
 */
export function readVerifikatQuerySearch(search: string, scope: VerifikatSearchScope): VerifikatSearch {
  const needle = readVerifikatSearch(search)
  return isBoundedVerifikatScope(scope) ? needle : { ...needle, amount: null }
}

/**
 * What a needle is read as, for a log line: the readings, never the needle.
 * The text match always applies.
 */
export function verifikatSearchReadings(needle: VerifikatSearch): string[] {
  return [
    'text',
    ...(needle.voucher ? ['voucher'] : []),
    ...(needle.account ? ['account'] : []),
    ...(needle.amount !== null ? ['amount'] : []),
    ...(needle.dates ? ['date'] : []),
  ]
}

/**
 * The ILIKE pattern of the text match. Escapes LIKE wildcards (\ % _) so they
 * match literally, and caps the needle length (200 chars): both in
 * escapeLikePattern. The cap bounds DB work against oversized input
 * (compliance A.8.28 / ASVS V1.2.5); escaping keeps "50%" from over-matching.
 */
function textPattern(search: string): string {
  return `%${escapeLikePattern(search.trim())}%`
}

/** applyVerifikatSearch's search as the parameters of list_verifikat_by_amount. */
export interface VerifikatSearchParams {
  p_search_pattern: string | null
  p_search_voucher_series: string | null
  p_search_voucher_number: number | null
  p_search_account: string | null
  p_search_amount: number | null
  p_search_date_from: string | null
  p_search_date_to: string | null
}

/**
 * The same search as applyVerifikatSearch, for an RPC that filters verifikat
 * in SQL (list_verifikat_by_amount): each reading of `needle` is its own
 * parameter, NULL when the needle is not read that way, and the RPC puts
 * every reading as an arm next to the text match, as applyVerifikatSearch
 * does. `needle` is the reading from readVerifikatQuerySearch, so the RPC and
 * the direct query read a needle alike. No search: every parameter NULL.
 *
 * The pattern is the one PostgREST hands Postgres for the direct query:
 * PostgREST reads `*` in a like pattern as `%`, so "A*B" matches "A%B" there,
 * and so here.
 */
export function verifikatSearchParams(search: string | null, needle: VerifikatSearch | null): VerifikatSearchParams {
  if (!search || !needle) {
    return {
      p_search_pattern: null,
      p_search_voucher_series: null,
      p_search_voucher_number: null,
      p_search_account: null,
      p_search_amount: null,
      p_search_date_from: null,
      p_search_date_to: null,
    }
  }
  return {
    p_search_pattern: textPattern(search).replace(/\*/g, '%'),
    p_search_voucher_series: needle.voucher?.series ?? null,
    p_search_voucher_number: needle.voucher?.number ?? null,
    p_search_account: needle.account,
    p_search_amount: needle.amount,
    p_search_date_from: needle.dates?.from ?? null,
    p_search_date_to: needle.dates?.to ?? null,
  }
}

/**
 * The PostgREST filters applyVerifikatSearch needs. It takes any builder that
 * has them and hands the same builder type back; the constraint names the
 * methods only (see excludeCreditNotes, lib/bookkeeping/credit-note-state.ts,
 * for why not their full signatures).
 */
interface VerifikatSearchQuery {
  eq(column: string, value: string): VerifikatSearchQuery
  ilike(column: string, pattern: string): VerifikatSearchQuery
  or(filters: string, options?: { referencedTable?: string }): VerifikatSearchQuery
}

/**
 * The joins applyVerifikatSearch filters, to append to the query's select.
 * The account and the amount look at the lines, so each joins them once more
 * under its own alias, with no columns selected: the query's own `lines`
 * embed keeps every line of the verifikat.
 */
export function verifikatSearchJoins(needle: VerifikatSearch): string {
  return (
    (needle.account ? ', account_match:journal_entry_lines()' : '') +
    (needle.amount !== null ? ', amount_match:journal_entry_lines()' : '')
  )
}

/**
 * Narrows a `journal_entries` query to the verifikat a search finds: the ones
 * that mention the needle in their text, plus the ones that ARE what the
 * needle names (its voucher label, a line on its account, a line of its
 * amount, its bokföringsdatum). Every reading is an arm next to the text
 * match, so the result only grows. `needle` is the reading the query's
 * select was built from (verifikatSearchJoins), from
 * readVerifikatQuerySearch.
 *
 * `<alias>.not.is.null` is PostgREST's test that a filtered join found a
 * row; inside or() it sits next to an ordinary column. The database probes
 * the lines of one verifikat at a time through their journal_entry_id index,
 * for the verifikat the query's other filters left, so a count and a page
 * stay one statement and nothing is fetched to build an id list. For the
 * account, idx_journal_entry_lines_entry_account says without the heap that
 * a verifikat has no line on it. An amount is in no index: its probe reads
 * the verifikat's lines, which is why it needs a bounded set
 * (isBoundedVerifikatScope).
 */
export function applyVerifikatSearch<Q extends { [K in keyof VerifikatSearchQuery]: unknown }>(
  query: Q,
  search: string,
  needle: VerifikatSearch,
): Q {
  let q = query as unknown as VerifikatSearchQuery
  // Supabase parameterises the value.
  const pattern = textPattern(search)
  const arms: string[] = []
  // The first thing a user searches for is the voucher's own label ("A209").
  // A description-only match never finds it (only OTHER vouchers that
  // mention A209 in their text).
  if (needle.voucher) {
    arms.push(`and(voucher_series.eq.${needle.voucher.series},voucher_number.eq.${needle.voucher.number})`)
  }
  if (needle.account) {
    q = q.eq('account_match.account_number', needle.account)
    arms.push('account_match.not.is.null')
  }
  // A line carries one side, so its amount is its debit or its credit. The
  // amount the list's Belopp column shows is such a line's amount, except
  // for a verifikat with several lines on both sides and no single money
  // line: its omslutning sits on no line and only the Belopp rule
  // (verifikat_display_amounts) knows it. That rule reads every verifikat in
  // scope, where this is an index probe: it orders the list, it does not
  // filter it.
  if (needle.amount !== null) {
    q = q.or(`debit_amount.eq.${needle.amount},credit_amount.eq.${needle.amount}`, {
      referencedTable: 'amount_match',
    })
    arms.push('amount_match.not.is.null')
  }
  if (needle.dates) {
    const { from, to } = needle.dates
    arms.push(from === to ? `entry_date.eq.${from}` : `and(entry_date.gte.${from},entry_date.lte.${to})`)
  }
  if (arms.length === 0) return q.ilike('description', pattern) as unknown as Q
  // The OR is a PostgREST filter list, so the pattern is double-quoted to
  // keep its commas and parentheses literal.
  const quotedPattern = `"${pattern.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return q.or([`description.ilike.${quotedPattern}`, ...arms].join(',')) as unknown as Q
}
