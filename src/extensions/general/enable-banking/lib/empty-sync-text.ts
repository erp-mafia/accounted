/**
 * What a sync that brought in nothing tells the person (PH 221).
 *
 * "0 nya transaktioner" next to a freshly read balance looked like a
 * connection that only reads the balance. The bank's answer was one of two
 * different things, and each gets its own sentence:
 * - 'not_booked': it sent entries, none of them booked yet (pending card
 *   purchases and the like). They are imported once the bank books them.
 * - 'nothing': it sent no entries for the window. Transactions the person
 *   sees in the bank but not here come in as a bank file.
 * Null whenever something came in, was already here (duplicates) or failed
 * (errors): the ordinary count, or the error, already says what happened.
 */
export interface SyncCounts {
  imported: number
  duplicates: number
  errors?: number
  notBooked?: number
}

export type EmptySyncKind = 'not_booked' | 'nothing'

export function emptySyncKind(counts: SyncCounts): EmptySyncKind | null {
  if (counts.imported > 0 || counts.duplicates > 0 || (counts.errors ?? 0) > 0) return null
  return (counts.notBooked ?? 0) > 0 ? 'not_booked' : 'nothing'
}

export function describeEmptySync(counts: SyncCounts): string | null {
  const kind = emptySyncKind(counts)
  if (kind === 'not_booked') {
    const n = counts.notBooked ?? 0
    return n === 1
      ? 'Banken skickade 1 transaktion som den inte har bokfört än. Den kommer in här när banken har bokfört den.'
      : `Banken skickade ${n} transaktioner som den inte har bokfört än. De kommer in här när banken har bokfört dem.`
  }
  if (kind === 'nothing') {
    return 'Banken skickade inga transaktioner för perioden. Syns transaktioner i banken som saknas här? Importera kontoutdraget som bankfil.'
  }
  return null
}
