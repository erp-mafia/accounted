import crypto from 'crypto'

/**
 * Dedup identity for skattekonto_transactions rows.
 *
 * Lives in core (not the skatteverket extension) because two producers write
 * the table: the extension's API sync and the core skattekontoutdrag file
 * importer. Both must compute byte-identical keys or every row would double
 * on the next sync. Same pattern as SKATTEKONTO_ACCOUNT in
 * manual-verifikat-prefill.ts: core owns the constant, the extension imports
 * it back.
 *
 * Key forms:
 * - `id:<transaktionsidentitet>` when Skatteverket's stable id is present
 *   (always on tidigare from the API, sometimes on kommande).
 * - `h:sha256(transaktionsdatum|beloppSkatteverket|transaktionstext)` when
 *   it is not: kommande rows, and every file-imported row (statement exports
 *   carry no transaktionsidentitet).
 *
 * The amount is interpolated with JS number formatting. Both producers hold
 * the amount as a number, so `500` stringifies as "500" on both sides; a
 * parser must never feed a pre-formatted string in here.
 */

/**
 * Compute the dedup key for a transaction.
 *
 * The point of this function is reproducibility: the same logical
 * transaction must always produce the same dedup_key. The material format
 * is a stored contract (every existing hash row in prod was written with
 * it): never change it.
 */
export function computeDedupKey(tx: {
  transaktionsidentitet?: number | null
  transaktionsdatum: string
  beloppSkatteverket: number
  transaktionstext: string
}): string {
  if (tx.transaktionsidentitet != null) {
    return `id:${tx.transaktionsidentitet}`
  }
  return `h:${hashMaterial(contentSignature(tx.transaktionsdatum, tx.beloppSkatteverket, tx.transaktionstext))}`
}

/**
 * The content identity of a row independent of which producer wrote it and
 * which key form it got. Exactly the hash material of the `h:` key form, so
 * `computeDedupKey` for an id-less row is `h:sha256(contentSignature(...))`.
 * Used to pair file rows against `id:`-keyed API rows (import-time duplicate
 * detection) and API rows against `h:`-keyed imported rows (sync-time
 * takeover).
 */
export function contentSignature(
  transaktionsdatum: string,
  beloppSkatteverket: number,
  transaktionstext: string,
): string {
  return `${transaktionsdatum}|${beloppSkatteverket}|${transaktionstext}`
}

function hashMaterial(material: string): string {
  return crypto.createHash('sha256').update(material).digest('hex')
}

/** The subset of a parsed statement row that dedup identity is built from. */
export interface SkattekontoFileRowIdentity {
  transaktionsdatum: string
  transaktionstext: string
  /** SKV sign convention: positive = credit on the tax account. */
  belopp: number
}

/**
 * Assign dedup keys to parsed file rows.
 *
 * Identical rows within one file are legal (two equal payments on the same
 * day). The first occurrence gets the plain content hash; later occurrences
 * suffix the material with `|2`, `|3`, ... by occurrence order. This is
 * deterministic per file content, so re-importing the same or an overlapping
 * file resolves onto the same keys instead of inserting twice.
 */
export function assignFileDedupKeys(
  rows: SkattekontoFileRowIdentity[],
): { row: SkattekontoFileRowIdentity; index: number; dedupKey: string }[] {
  const seen = new Map<string, number>()
  return rows.map((row, index) => {
    const sig = contentSignature(row.transaktionsdatum, row.belopp, row.transaktionstext)
    const occurrence = (seen.get(sig) ?? 0) + 1
    seen.set(sig, occurrence)
    const material = occurrence === 1 ? sig : `${sig}|${occurrence}`
    return { row, index, dedupKey: `h:${hashMaterial(material)}` }
  })
}

/** Existing table rows needed to partition an incoming file. */
export interface ExistingSkattekontoRow {
  id: string
  dedup_key: string
  status: 'booked' | 'upcoming'
  transaktionsdatum: string
  transaktionstext: string
  belopp_skatteverket: number
}

export interface SkattekontoFilePartition {
  /** New rows to insert as booked file_import rows. */
  toInsert: { row: SkattekontoFileRowIdentity; index: number; dedupKey: string }[]
  /**
   * Existing upcoming rows the statement proves have settled: flip their
   * status to booked in place (keeps id, journal_entry_id, forfallodatum).
   */
  promotions: { row: SkattekontoFileRowIdentity; index: number; existingId: string }[]
  /** File rows already present as booked rows (either key form): skip. */
  duplicates: { row: SkattekontoFileRowIdentity; index: number; existingId: string }[]
}

/**
 * Partition parsed file rows against the rows already in the table.
 *
 * Matching is by content signature, not by dedup key, because the API writes
 * `id:` keys for the same logical transactions a file hash-keys. Multiset
 * semantics: each existing row is consumed at most once, so two identical
 * file rows against one existing row yield one duplicate and one insert.
 * Booked matches win over upcoming matches (a booked row IS this
 * transaction; an upcoming row merely predicts it).
 */
export function partitionFileRows(
  keyed: { row: SkattekontoFileRowIdentity; index: number; dedupKey: string }[],
  existing: ExistingSkattekontoRow[],
): SkattekontoFilePartition {
  const bookedBySig = new Map<string, ExistingSkattekontoRow[]>()
  const upcomingBySig = new Map<string, ExistingSkattekontoRow[]>()
  for (const row of existing) {
    const sig = contentSignature(
      row.transaktionsdatum,
      row.belopp_skatteverket,
      row.transaktionstext,
    )
    const bucket = row.status === 'booked' ? bookedBySig : upcomingBySig
    const queue = bucket.get(sig)
    if (queue) queue.push(row)
    else bucket.set(sig, [row])
  }

  const result: SkattekontoFilePartition = { toInsert: [], promotions: [], duplicates: [] }
  for (const entry of keyed) {
    const sig = contentSignature(
      entry.row.transaktionsdatum,
      entry.row.belopp,
      entry.row.transaktionstext,
    )
    const booked = bookedBySig.get(sig)
    if (booked && booked.length > 0) {
      const match = booked.shift() as ExistingSkattekontoRow
      result.duplicates.push({ row: entry.row, index: entry.index, existingId: match.id })
      continue
    }
    const upcoming = upcomingBySig.get(sig)
    if (upcoming && upcoming.length > 0) {
      const match = upcoming.shift() as ExistingSkattekontoRow
      result.promotions.push({ row: entry.row, index: entry.index, existingId: match.id })
      continue
    }
    result.toInsert.push(entry)
  }
  return result
}
