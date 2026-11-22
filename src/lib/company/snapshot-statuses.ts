/**
 * The registry statuses the Bolagsuppgifter panel shows for a company, read
 * from the cached TIC snapshot (companies.tic_snapshot): the dated entries
 * that still describe the firm today.
 *
 * Lens keeps a firm's whole status history. A sole trader who restarts under
 * a registration struck off years ago keeps that strike-off in it: an old
 * "Avregistrerad p g a verksamheten upphört" next to a later "Är verksam"
 * and live F-skatt and moms. The registration at Bolagsverket ended, the
 * business did not. The snapshot's `activityStatus`
 * is Lens's current state, already folded by the TIC extension's rule
 * (activityStatus wins over the old ceased flag). When it says the firm is
 * active, a ceased entry is history that state has overtaken, and the panel
 * showing it as a status (in red) told the owner the firm was deregistered.
 *
 * Undated entries are dropped too: Bolagsverket emits informational flags
 * like "Har aldrig varit verksam" with no date that read as noise next to
 * the real ones. The snapshot is unvalidated registry JSON, so every level
 * is checked defensively.
 */
export interface SnapshotStatus {
  statusDate?: string | null
  isCeased?: boolean | null
}

export function statusesInForce<T extends SnapshotStatus>(
  snapshot: { activityStatus?: unknown; statuses?: T[] | null } | null | undefined,
): T[] {
  const statuses = Array.isArray(snapshot?.statuses) ? snapshot.statuses : []
  const activeToday = snapshot?.activityStatus === 'isActive'
  return statuses.filter(
    (s): s is T =>
      Boolean(s && typeof s === 'object' && s.statusDate) && !(activeToday && s.isCeased === true),
  )
}
