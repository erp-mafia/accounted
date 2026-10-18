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

/** What `dropRepeatedBankRows` reads from a fetched row. */
export interface BankRowIdentity {
  /** The bank's own id for the row (entry_reference / transaction_id), when it sent one. */
  providerTransactionId?: string | null
  date: string
  amount: number | string
  description: string
}

/**
 * Drop the repeats of a bank row that ONE fetched response served more than
 * once, keeping the first.
 *
 * Some banks page their transaction lists unstably: a later page repeats rows
 * an earlier page already served and leaves others out (observed at Nordea
 * through Enable Banking, crm#1295). `buildStableExternalIds` gives each copy
 * its own occurrence index, so every copy was stored as a transaction of its
 * own. A stored copy then also swallows a genuinely new row in a later sync:
 * no incoming row bridges the copy, so `reconcileStableExternalIds` pairs the
 * new row with it by id alone and Layer 1 skips it as a duplicate.
 *
 * A repeat carries the same non-empty bank id AND the same booking date,
 * amount (öre) and description as an earlier row of the response: one bank
 * entry, not two payments. Rows without a bank id are never dropped: two
 * equal payments on the same day are real, and only the bank's id tells them
 * apart from a repeat. The id is compared only within one response, so a bank
 * that changes its ids between requests (the reason the stored key is not the
 * bank's id) is unaffected. Callers apply this before building the ids, so
 * the occurrence index counts each entry once.
 */
export function dropRepeatedBankRows<T>(rows: readonly T[], identity: (row: T) => BankRowIdentity): T[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const { providerTransactionId, date, amount, description } = identity(row)
    const bankId = (providerTransactionId ?? '').trim()
    if (bankId === '') return true
    const key = JSON.stringify([bankId, date, amountToOre(amount), description])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Splits a `buildStableExternalIds` id into its `{prefix}_{scope}_{date}_{öre}` family and index. */
const STABLE_EXTERNAL_ID = /^(.+_\d{4}-\d{2}-\d{2}_-?\d+)_(\d+)$/

/**
 * Re-key incoming stable ids so each one names the SAME physical transaction
 * as the stored row that carries it.
 *
 * The occurrence index in `buildStableExternalIds` follows the order the ASPSP
 * returns rows in, so it identifies a transaction only while the set of
 * same-(account, date, amount) rows never changes. When the bank books one
 * more such transaction after an earlier sync stored the others, the newcomer
 * can land on an index a stored row already holds and be skipped as a Layer-1
 * duplicate, while the displaced stored transaction takes the fresh index and
 * is content-bridged to its own stored twin: the new transaction is lost.
 *
 * Within each id family that already has stored rows, incoming rows pair with
 * stored rows by: the same id with a bridging description, then any bridging
 * description (longest stored description first, as in the content bridge),
 * then the same id alone (a description that drifted without bridging dedups
 * exactly as before). Paired rows take the stored row's id; the rest are new
 * and keep their id, or take the lowest index no stored or paired row holds.
 * Ids outside the stable format, and families with no stored rows, pass
 * through unchanged.
 */
export function reconcileStableExternalIds(
  incoming: Array<{ external_id: string; description: string }>,
  stored: Array<{ externalId: string | null; desc: string }>
): string[] {
  const ids = incoming.map((tx) => tx.external_id)
  const storedByFamily = new Map<string, Map<string, string>>()
  for (const row of stored) {
    const match = row.externalId ? STABLE_EXTERNAL_ID.exec(row.externalId) : null
    if (!match) continue
    const family = storedByFamily.get(match[1]) ?? new Map<string, string>()
    family.set(match[0], row.desc)
    storedByFamily.set(match[1], family)
  }
  const incomingByFamily = new Map<string, number[]>()
  incoming.forEach((tx, i) => {
    const match = STABLE_EXTERNAL_ID.exec(tx.external_id)
    if (!match || !storedByFamily.has(match[1])) return
    incomingByFamily.set(match[1], [...(incomingByFamily.get(match[1]) ?? []), i])
  })

  for (const [family, members] of incomingByFamily) {
    const storedDesc = storedByFamily.get(family)!
    const unpaired = new Set(storedDesc.keys())
    const tryPair = (i: number, storedId: string | null): boolean => {
      if (storedId === null || !unpaired.has(storedId)) return false
      ids[i] = storedId
      unpaired.delete(storedId)
      return true
    }
    const bridges = (i: number, storedId: string) => descriptionsBridge(incoming[i].description, storedDesc.get(storedId))
    const longestBridging = (i: number): string | null => {
      let best: string | null = null
      for (const storedId of unpaired) {
        if (bridges(i, storedId) && (best === null || storedDesc.get(storedId)!.length > storedDesc.get(best)!.length)) {
          best = storedId
        }
      }
      return best
    }
    let pending = members.filter((i) => !(unpaired.has(ids[i]) && bridges(i, ids[i]) && tryPair(i, ids[i])))
    pending = pending.filter((i) => !tryPair(i, longestBridging(i)))
    pending = pending.filter((i) => !tryPair(i, ids[i]))

    const taken = new Set([...storedDesc.keys(), ...members.filter((i) => !pending.includes(i)).map((i) => ids[i])])
    for (const i of pending) {
      let n = 0
      while (taken.has(ids[i])) ids[i] = `${family}_${n++}`
      taken.add(ids[i])
    }
  }
  return ids
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
 * re-imported. Whitespace is not part of the signal: both sides are compared
 * with ALL whitespace stripped, because banks reformat spacing between API
 * sessions (see the inline comment). A blank description carries no signal, so it never bridges a
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
  // Whitespace is stripped ENTIRELY (not collapsed) before comparing: the same
  // bank renders the same transaction with drifting whitespace between API
  // sessions ("BaBylissURSPRUNGLIGT" vs "BaByliss URSPRUNGLIGT", CRLF vs
  // space), and a collapse-only normalization still misses the dropped-space
  // form. Observed in the 2026-08-18 reconnect incident: five historical rows
  // re-imported as twins whose descriptions differed only in whitespace, and
  // every dedup layer missed them. Stripping is safe for the title-prefix
  // bridge too: char-filtering is concatenation-homomorphic, so every existing
  // prefix relation is preserved (it can only ADD bridges, never remove one).
  // The compare stays confined to a (date, öre) bucket, so the widened match
  // can only collapse same-day same-amount rows.
  const x = (a ?? '').toLowerCase().replace(/\s+/g, '')
  const y = (b ?? '').toLowerCase().replace(/\s+/g, '')
  // A blank never wildcards a described row; only two blanks bridge each other.
  if (x === '' || y === '') return x === y
  return x.startsWith(y) || y.startsWith(x)
}

/**
 * Import feeds whose STORED `transactions.external_id` is the provider's own
 * per-booking reference: the same booking always carries the same id, and a
 * different id is a different booking.
 *
 * This is the per-ROW form of `IngestOptions.stableExternalIds`, which a feed
 * states per batch at ingest and which is not stored on the row. Code that
 * meets the row later (the booking-time duplicate guard) reads the statement
 * from here instead. A feed belongs here only when its ingest call passes
 * `stableExternalIds: true`; ids derived from content or position never
 * qualify (the Enable Banking / Open Payments occurrence index from
 * buildStableExternalIds, bank-file row hashes, ids an agent typed into
 * create_transactions), because the same booking can come back under another
 * one of those.
 *
 * - 'stripe': `stripe_{account}_{balance_txn}` and its `_fee` row
 *   (extensions/general/stripe/lib/transaction-sync.ts). A Stripe balance
 *   transaction id names one movement on the Stripe balance for good.
 */
export const PROVIDER_BOOKING_ID_SOURCES: ReadonlySet<string> = new Set(['stripe'])

/** The `transactions` columns that say which feed a row came from and under which id. */
export interface TransactionIdentity {
  external_id?: string | null
  import_source?: string | null
  bank_connection_id?: string | null
}

/**
 * True when the ids ALONE prove two rows are different bookings: both rows
 * come from the same provider feed whose ids are per-booking references (same
 * import_source in PROVIDER_BOOKING_ID_SOURCES, same bank connection), both
 * carry an id, and the ids differ.
 *
 * False whenever the ids cannot speak: a missing id on either side, rows from
 * two different feeds (a bank file and the feed, a hand-entered row), or a
 * feed whose ids are derived. Callers then judge on content, as before.
 * Mirrors the ingest-time identity guard (isOtherBookingOfSameFeed in
 * lib/transactions/ingest.ts), so a row the ingest kept apart from its
 * look-alike is not called that look-alike's copy at booking time.
 */
export function idsProveDistinctBookings(a: TransactionIdentity, b: TransactionIdentity): boolean {
  const source = a.import_source ?? null
  if (source === null || !PROVIDER_BOOKING_ID_SOURCES.has(source)) return false
  if ((b.import_source ?? null) !== source) return false
  if ((a.bank_connection_id ?? null) !== (b.bank_connection_id ?? null)) return false
  const idA = a.external_id ?? null
  const idB = b.external_id ?? null
  if (!idA || !idB) return false
  return idA !== idB
}
