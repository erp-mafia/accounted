/**
 * Shared helpers for deriving stable bank-transaction `external_id`s and for
 * normalizing monetary amounts used in dedup keys.
 *
 * Why this exists
 * ---------------
 * The transactions table is deduplicated on `(company_id, external_id)` (a
 * partial unique index, see migration 20260330130000). The dedup is therefore
 * only as good as the stability of `external_id` across re-syncs.
 *
 * For Enable Banking (PSD2 / Berlin Group) the previous scheme keyed
 * `external_id` off the bank's `entry_reference` / `transaction_id`
 * (`eb_{account}_{tx.id}`). Many Swedish ASPSPs do NOT return those fields
 * stably across requests: a later "synka nu" can return the same underlying
 * transaction with a different id, which produced a *new* `external_id` and
 * therefore a duplicate row (including for transactions the user had already
 * booked). See `buildStableExternalIds` for the content-derived replacement.
 */

/**
 * Normalize a monetary amount to integer öre (hundredths) for stable,
 * representation-agnostic comparison.
 *
 * PostgREST may return a `numeric` column as a JS number OR as a string
 * (preserving precision), so `1234.5` and the string `"1234.50"` can describe
 * the same amount. Interpolating either directly into a dedup key yields
 * different strings (`"1234.5"` vs `"1234.50"`), silently breaking content
 * dedup. Rounding to integer öre collapses both to `123450`.
 *
 * Uses the project-standard `Math.round(x * 100)` (never `toFixed`).
 */
export function amountToOre(amount: number | string): number {
  return Math.round(Number(amount) * 100)
}

/**
 * Swedish-first placeholder for transactions a bank/import source gives no
 * usable title. Centralized so every import path and the tests agree.
 */
export const FALLBACK_DESCRIPTION = 'Okänd transaktion'

/**
 * Normalize an imported transaction title for storage and display.
 *
 * Maps both an empty/whitespace title AND the legacy English 'Unknown'
 * sentinel (still emitted by the bank-file format parsers and as the Enable
 * Banking converter's last resort) to a Swedish-first neutral. Applied once at
 * the ingest boundary so every source (PSD2 sync + CSV/CAMT import) inherits
 * it; the bank's verbatim text is preserved separately in
 * `transactions.original_description`. Match on the exact 'unknown' sentinel
 * (case-insensitive) so a real description that merely contains the word is
 * never clobbered.
 */
export function normalizeImportedDescription(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed || trimmed.toLowerCase() === 'unknown') return FALLBACK_DESCRIPTION
  return trimmed
}

/**
 * Build stable, collision-safe `external_id`s for a batch of bank transactions
 * whose provider does not supply a reliable stable id (e.g. Enable Banking).
 *
 * The id is derived from content: `{prefix}_{accountScope}_{date}_{öre}_{n}`,
 * where `n` is an occurrence index that disambiguates genuinely identical
 * transactions (same account, date and amount) within the batch.
 *
 * ⚠️ THE FORMAT STRING IS A STORED KEY. It is persisted to
 * `transactions.external_id` and dedup compares incoming ids against the stored
 * ones byte-for-byte. Changing this template silently orphans every prior row
 * (its stored id no longer matches the new scheme) and re-imports them all on
 * the next sync: this is exactly what happened in the June 2026 fleet-wide
 * incident. Any format change MUST ship a coordinated backfill of existing rows
 * and is locked by a frozen-format test (see `external-id.test.ts`).
 *
 * Properties this guarantees:
 * - **Re-sync dedupe**: the same set of transactions produces the same *set*
 *   of ids regardless of the order the ASPSP returns them in, so a repeat sync
 *   collides with the existing rows on `(company_id, external_id)` and is
 *   skipped, even after the user has booked them. (The id *set* is what the
 *   unique index enforces; which physical row maps to `..._0` vs `..._1` need
 *   not be stable, only the set.)
 * - **No false dedupe**: two legitimately distinct transactions that share a
 *   date and amount get different ids (`..._0`, `..._1`) and are both kept.
 *   This is the safeguard the bank-file importer already relies on via its
 *   `rowIndex` component (see `lib/import/bank-file/parser.ts`).
 *
 * Why description is NOT an input here (but IS in the content bridge): the
 * `external_id` must be a *stable unique key*, so it cannot depend on a field
 * that drifts: PSD2 enriches/reorders descriptions between a transaction's
 * pending and booked states. The occurrence index gives uniqueness without
 * that fragility. The content bridge (`contentBucketKey` + `descriptionsBridge`)
 * has the opposite job: it is a best-effort *bridge* that must avoid dropping
 * real transactions, so it keeps the description (see those for the trade-off).
 *
 * @param prefix       Source tag, e.g. `'eb'` for Enable Banking.
 * @param accountScope Stable per-account scope (prefer IBAN, fall back to the
 *                     provider account uid). Keeps ids unique across accounts.
 *                     Callers should pass a whitespace/case-normalized IBAN so
 *                     formatting variants ("SE45 5000…" vs "SE455000…") don't
 *                     produce different ids for the same account.
 * @param txns         Batch in provider order; each needs `date` + `amount`.
 */
export function buildStableExternalIds(
  prefix: string,
  accountScope: string,
  txns: Array<{ date: string; amount: number | string }>
): string[] {
  const occurrences = new Map<string, number>()
  return txns.map((tx) => {
    const fingerprint = `${tx.date}_${amountToOre(tx.amount)}`
    const n = occurrences.get(fingerprint) ?? 0
    occurrences.set(fingerprint, n + 1)
    return `${prefix}_${accountScope}_${fingerprint}_${n}`
  })
}

/**
 * Bucket key for the content-dedup bridge: `{date}|{öre}`, deliberately NO
 * description. Transactions that share a date and amount fall into the same
 * bucket; `descriptionsBridge` then decides, per pair, whether two rows in that
 * bucket are the same transaction. Splitting bucketing (date+öre) from matching
 * (description) is what lets the bridge survive description drift while still
 * keeping genuinely-distinct same-(date,amount) transactions apart.
 *
 * öre via `amountToOre` so a JS number (`-250`) and a PostgREST numeric string
 * (`"-250.00"`) collapse to the same bucket, otherwise dedup silently misses.
 */
export function contentBucketKey(date: string, amount: number | string): string {
  return `${date}|${amountToOre(amount)}`
}

/**
 * Decide whether two normalized descriptions (same date+öre bucket) describe the
 * same underlying transaction, the matching half of the content-dedup bridge.
 *
 * Returns true when either description is a prefix of the other. PSD2 enrichment
 * is **prefix-preserving**: the same transaction's title grows between syncs
 * ("TIC" → "TIC  BG 0000005786439 Bg-bet. via internet", "UTBETALNING" →
 * "UTBETALNING Insättning"), so prefix-containment bridges the two where a
 * fixed-length prefix *equality* check (the pre-June-2026 scheme) missed and
 * re-imported. A blank description carries no signal, so it never bridges a
 * *described* row: otherwise an empty title would wildcard-match any
 * same-(date,öre) transaction and could silently consume a real one; only two
 * blanks bridge each other (date+öre identity). In practice every caller
 * normalizes blanks to FALLBACK_DESCRIPTION upstream (see
 * normalizeImportedDescription), so the blank path is defense-in-depth.
 * Genuinely distinct descriptions ("Coffee" vs "Lunch", or two different
 * reference codes that share a date and amount) are NOT prefixes of one another
 * and never bridge, so two real same-(date,amount) transactions are kept apart.
 *
 * This is a *best-effort* signal, consumed with COUNTING semantics in the ingest
 * pipeline (N existing matches consume N incoming): its job is to skip re-imports
 * WITHOUT ever dropping a real transaction. The asymmetry favours keeping a
 * visible, user-deletable duplicate over silently losing a row.
 */
export function descriptionsBridge(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const x = (a ?? '').toLowerCase().trim()
  const y = (b ?? '').toLowerCase().trim()
  // A blank never wildcards a described row; only two blanks bridge each other.
  if (x === '' || y === '') return x === y
  return x.startsWith(y) || y.startsWith(x)
}

/**
 * Shift an ISO `YYYY-MM-DD` date by a whole number of days, returning a new
 * `YYYY-MM-DD` string. Deterministic and INPUT-ONLY: it does the arithmetic
 * with `Date.UTC` on the parsed components and `new Date(ms)`, never the wall
 * clock (`Date.now()` / argless `new Date()`), so it is safe in dedup code that
 * must not depend on the current time. Correctly crosses month, year and
 * leap-day boundaries via UTC epoch math.
 *
 * Used to enumerate the adjacent date buckets the date-drift dedup shadow
 * inspects: a booking date that drifts a day between syncs lands its twin in
 * `contentBucketKey(shiftIsoDate(date, ±1), amount)`, which the exact-date
 * content bridge cannot see.
 */
export function shiftIsoDate(date: string, deltaDays: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d) + deltaDays * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}
