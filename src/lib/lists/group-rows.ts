/**
 * Bucket an already-sorted list into labelled sections and flatten it back
 * into one array, so paging, range selection and the detail pager all walk
 * the exact order the table renders.
 *
 * Sorting stays the caller's job: rows arrive sorted and keep that order
 * inside every bucket. This only decides which bucket a row belongs to, what
 * the section is called, and in which order the sections appear.
 */

export interface GroupedRow<T> {
  row: T
  /** null when grouping is off: the caller renders one flat list. */
  groupKey: string | null
}

export interface GroupMeta {
  label: string
  count: number
}

export interface GroupRowsResult<T> {
  rows: GroupedRow<T>[]
  meta: Map<string, GroupMeta>
}

export interface GroupRowsOptions<T> {
  /** Bucket identity plus its display label. Bucket by id, never by a name:
   *  two customers can share one. */
  keyOf: (row: T) => { key: string; label: string }
  /**
   * Section order. A fixed array pins a semantic order (status sections);
   * a comparator sorts the keys that actually occurred (customer by label,
   * month descending). Keys missing from a fixed array are dropped, so it
   * doubles as a whitelist.
   */
  order: readonly string[] | ((a: GroupMeta & { key: string }, b: GroupMeta & { key: string }) => number)
}

/** Grouping off: every row in one flat section with no key. */
export function ungrouped<T>(rows: readonly T[]): GroupRowsResult<T> {
  return { rows: rows.map((row) => ({ row, groupKey: null })), meta: new Map() }
}

export function groupRows<T>(rows: readonly T[], options: GroupRowsOptions<T>): GroupRowsResult<T> {
  const buckets = new Map<string, { label: string; rows: T[] }>()
  for (const row of rows) {
    const { key, label } = options.keyOf(row)
    const bucket = buckets.get(key) ?? { label, rows: [] }
    bucket.rows.push(row)
    buckets.set(key, bucket)
  }

  const keys = Array.isArray(options.order)
    ? (options.order as readonly string[]).filter((key) => buckets.has(key))
    : [...buckets.keys()].sort((a, b) => {
        const compare = options.order as Exclude<GroupRowsOptions<T>['order'], readonly string[]>
        return compare(
          { key: a, label: buckets.get(a)!.label, count: buckets.get(a)!.rows.length },
          { key: b, label: buckets.get(b)!.label, count: buckets.get(b)!.rows.length },
        )
      })

  const flat: GroupedRow<T>[] = []
  const meta = new Map<string, GroupMeta>()
  for (const key of keys) {
    const bucket = buckets.get(key)!
    meta.set(key, { label: bucket.label, count: bucket.rows.length })
    for (const row of bucket.rows) flat.push({ row, groupKey: key })
  }
  return { rows: flat, meta }
}
