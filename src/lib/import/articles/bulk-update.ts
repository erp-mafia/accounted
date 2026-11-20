/** The merged fields for one existing article, and the file rows that named it. */
export interface PlannedArticleUpdate {
  id: string
  merged: Record<string, unknown>
  rows: { row_index: number; name: string }[]
}

/** One existing article as a row of an upsert statement. */
export interface ArticleUpsertRow {
  planned: PlannedArticleUpdate
  payload: Record<string, unknown>
}

/**
 * The merge-updates of an article import as upsert statements on the primary
 * key. PostgREST writes many rows with different values in one statement only
 * as an upsert, and the columns it sets are the union of the rows' keys: a row
 * without one of those keys would have that field set to null. So the updates
 * are grouped by the fields they change, and each group goes in slices of at
 * most `sliceSize` rows.
 *
 * The insert half of an upsert needs the NOT NULL columns without a default
 * (company, owner, name). They come from the undo snapshot read before the
 * import (snapshotRowsForUndo), so the statement writes back what is stored
 * and changes only the merged fields (and the name when the file carries it).
 * An article the snapshot does not hold (removed since the match) goes to
 * `rowByRow`: a plain update then fails for that row alone, where an upsert
 * would create it again.
 */
export function planArticleUpserts(
  updates: readonly PlannedArticleUpdate[],
  snapshot: ReadonlyMap<string, Record<string, unknown>>,
  companyId: string,
  sliceSize: number,
): { slices: ArticleUpsertRow[][]; rowByRow: PlannedArticleUpdate[] } {
  const groups = new Map<string, ArticleUpsertRow[]>()
  const rowByRow: PlannedArticleUpdate[] = []
  for (const planned of updates) {
    const stored = snapshot.get(planned.id)
    if (
      !stored ||
      stored.company_id !== companyId ||
      typeof stored.user_id !== 'string' ||
      typeof stored.name !== 'string'
    ) {
      rowByRow.push(planned)
      continue
    }
    const payload: Record<string, unknown> = {
      id: planned.id,
      company_id: companyId,
      user_id: stored.user_id,
      name: stored.name,
      ...planned.merged,
    }
    const fields = Object.keys(payload).sort().join(',')
    const group = groups.get(fields)
    if (group) group.push({ planned, payload })
    else groups.set(fields, [{ planned, payload }])
  }

  const slices: ArticleUpsertRow[][] = []
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += sliceSize) slices.push(group.slice(i, i + sliceSize))
  }
  return { slices, rowByRow }
}
