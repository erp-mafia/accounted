/**
 * One pending_operations row for a test, behind createTableMockSupabase.
 *
 * A read answers the row (a list for `.in()`). An update lands only when it
 * carries the `status = 'pending'` filter and the row is still pending, as
 * the compare-and-set does in Postgres, so a test sees a write that lost the
 * race change nothing. `beforeUpdate` runs between the reads and the write:
 * the place to let another session claim the row.
 */
import type { TableMockResolver } from '@/tests/helpers'

export type OperationRow = Record<string, unknown>

export function operationRowDouble(initial: OperationRow | null, beforeUpdate?: (row: OperationRow) => void) {
  const state = { row: initial ? { ...initial } : null, updates: [] as OperationRow[] }
  const resolver: TableMockResolver = (calls) => {
    const update = calls.find((c) => c.method === 'update')
    const asList = calls.some((c) => c.method === 'in')
    if (!state.row) return { data: asList ? [] : null }
    if (!update) return { data: asList ? [{ ...state.row }] : { ...state.row } }
    beforeUpdate?.(state.row)
    const whilePending = calls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'pending')
    if (!whilePending || state.row.status !== 'pending') return { data: [] }
    const patch = update.args[0] as OperationRow
    state.updates.push(patch)
    state.row = { ...state.row, ...patch }
    return { data: [{ id: state.row.id }] }
  }
  return { state, resolver }
}
