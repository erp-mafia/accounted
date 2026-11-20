import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import type { DimensionValueEventPayload } from '@/lib/events/types'
import {
  dimensionValueEventTypes,
  dimensionValueSnapshot,
  emitDimensionValueEvents,
  emitDimensionValuesCreated,
} from '../value-events'

const ROW = {
  id: 'val-1',
  dimension_id: 'dim-6',
  code: 'P1042',
  name: 'Villa Almgren tak',
  is_active: true,
  start_date: '2026-03-01',
  end_date: null,
}
const PROJEKT = { sie_dim_no: 6, name: 'Projekt' }

function record() {
  const seen: Array<{ type: string; payload: DimensionValueEventPayload }> = []
  for (const type of [
    'dimension_value.created',
    'dimension_value.renamed',
    'dimension_value.archived',
    'dimension_value.unarchived',
  ] as const) {
    eventBus.on(type, (payload) => {
      seen.push({ type, payload })
    })
  }
  return seen
}

describe('dimensionValueEventTypes', () => {
  it('a new value is created, also when it is created archived', () => {
    expect(dimensionValueEventTypes(null, { name: 'A', is_active: true })).toEqual(['dimension_value.created'])
    expect(dimensionValueEventTypes(null, { name: 'A', is_active: false })).toEqual(['dimension_value.created'])
  })

  it('names each kind of change once, a rename before a status change', () => {
    expect(dimensionValueEventTypes({ name: 'A', is_active: true }, { name: 'B', is_active: true })).toEqual([
      'dimension_value.renamed',
    ])
    expect(dimensionValueEventTypes({ name: 'A', is_active: true }, { name: 'A', is_active: false })).toEqual([
      'dimension_value.archived',
    ])
    expect(dimensionValueEventTypes({ name: 'A', is_active: false }, { name: 'A', is_active: true })).toEqual([
      'dimension_value.unarchived',
    ])
    expect(dimensionValueEventTypes({ name: 'A', is_active: true }, { name: 'B', is_active: false })).toEqual([
      'dimension_value.renamed',
      'dimension_value.archived',
    ])
  })

  it('a change of dates alone, or nothing at all, emits nothing', () => {
    expect(dimensionValueEventTypes({ name: 'A', is_active: true }, { name: 'A', is_active: true })).toEqual([])
  })
})

describe('emitDimensionValueEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('carries the value with its dimension, and the old name on a rename only', async () => {
    const seen = record()
    const after = dimensionValueSnapshot({ ...ROW, name: 'Villa Almgren tak och fasad', is_active: false }, PROJEKT)

    await emitDimensionValueEvents({
      companyId: 'company-1',
      userId: 'user-1',
      before: { name: 'Villa Almgren tak', is_active: true },
      after,
    })

    expect(seen.map((e) => e.type)).toEqual(['dimension_value.renamed', 'dimension_value.archived'])
    expect(seen[0].payload).toEqual({
      dimensionValue: {
        id: 'val-1',
        dimension_id: 'dim-6',
        sie_dim_no: 6,
        dimension_name: 'Projekt',
        code: 'P1042',
        name: 'Villa Almgren tak och fasad',
        is_active: false,
        start_date: '2026-03-01',
        end_date: null,
      },
      previousName: 'Villa Almgren tak',
      userId: 'user-1',
      companyId: 'company-1',
    })
    expect(seen[1].payload.previousName).toBeNull()
  })

  it('a bulk door announces every created value', async () => {
    const seen = record()
    const values = Array.from({ length: 19 }, (_, i) =>
      dimensionValueSnapshot({ ...ROW, id: `val-${i}`, code: `P${i}`, name: `P${i}`, is_active: false }, PROJEKT),
    )

    await emitDimensionValuesCreated({ companyId: 'company-1', userId: 'user-1', values })

    expect(seen).toHaveLength(19)
    expect(new Set(seen.map((e) => e.payload.dimensionValue.id)).size).toBe(19)
    expect(seen.every((e) => e.type === 'dimension_value.created' && e.payload.previousName === null)).toBe(true)
  })
})
