/**
 * The events a dimension value change emits (accounted#193): created,
 * renamed, archived and unarchived, each a public webhook event and a row in
 * the GET /api/events feed. An integration that keeps its own project list
 * (a construction company's project system) learns of a change in
 * Accounted without polling the register.
 *
 * One definition of which change is which event, for every door that writes
 * a value: the register service (dashboard, v1, MCP and the approval of a
 * staged create), "Importera befintliga koder" and the SIE import. A door
 * that writes dimension_values without going through here would leave the
 * receivers silently out of date, which is the bug this module exists to
 * prevent.
 *
 *   - no value before:          created (a value created archived is only created)
 *   - name changed:             renamed, with previousName
 *   - is_active true to false:  archived
 *   - is_active false to true:  unarchived
 *
 * A change of dates alone emits nothing: the issue's receivers track
 * identity and status, and start/end dates ride along in every payload.
 */
import { eventBus } from '@/lib/events/bus'
import type { DimensionValueSnapshot } from '@/lib/events/types'

export type DimensionValueEventType =
  | 'dimension_value.created'
  | 'dimension_value.renamed'
  | 'dimension_value.archived'
  | 'dimension_value.unarchived'

type ValueState = Pick<DimensionValueSnapshot, 'name' | 'is_active'>

/** The events one write emits, in the order they are emitted. Pure. */
export function dimensionValueEventTypes(before: ValueState | null, after: ValueState): DimensionValueEventType[] {
  if (!before) return ['dimension_value.created']
  const types: DimensionValueEventType[] = []
  if (before.name !== after.name) types.push('dimension_value.renamed')
  if (before.is_active && !after.is_active) types.push('dimension_value.archived')
  if (!before.is_active && after.is_active) types.push('dimension_value.unarchived')
  return types
}

/** The value row as the doors read it, and the dimension it belongs to. */
export interface DimensionValueRow {
  id: string
  dimension_id: string
  code: string
  name: string
  is_active: boolean
  start_date: string | null
  end_date: string | null
}

export function dimensionValueSnapshot(
  row: DimensionValueRow,
  dimension: { sie_dim_no: number; name: string },
): DimensionValueSnapshot {
  return {
    id: row.id,
    dimension_id: row.dimension_id,
    sie_dim_no: dimension.sie_dim_no,
    dimension_name: dimension.name,
    code: row.code,
    name: row.name,
    is_active: row.is_active,
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
  }
}

/**
 * Emit the events of one write, after it committed. Awaited, so the
 * handlers (event_log, webhooks, extensions) finish inside the request; a
 * handler failure never fails the write (the bus settles every handler).
 */
export async function emitDimensionValueEvents(input: {
  companyId: string
  userId: string
  before: ValueState | null
  after: DimensionValueSnapshot
}): Promise<void> {
  for (const type of dimensionValueEventTypes(input.before, input.after)) {
    await eventBus.emit({
      type,
      payload: {
        dimensionValue: input.after,
        previousName: type === 'dimension_value.renamed' ? input.before!.name : null,
        userId: input.userId,
        companyId: input.companyId,
      },
    })
  }
}

/** Events emitted at once by a bulk door: bounded, so a large import neither stalls nor floods the pool. */
const BULK_EMIT_CONCURRENCY = 8

/**
 * dimension_value.created for each value a bulk door inserted ("Importera
 * befintliga koder", the SIE import), a few at a time.
 */
export async function emitDimensionValuesCreated(input: {
  companyId: string
  userId: string
  values: readonly DimensionValueSnapshot[]
}): Promise<void> {
  for (let i = 0; i < input.values.length; i += BULK_EMIT_CONCURRENCY) {
    await Promise.all(
      input.values.slice(i, i + BULK_EMIT_CONCURRENCY).map((after) =>
        emitDimensionValueEvents({ companyId: input.companyId, userId: input.userId, before: null, after }),
      ),
    )
  }
}
