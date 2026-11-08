/**
 * The SIE import's door for dimension value events (accounted#193): once the
 * registry step is done, every value the import created (created_by_import_id)
 * is announced as dimension_value.created. Values the company already had are
 * never touched by the import and never announced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import type { SIEJob } from '../sie-job-contract'
import { announceCreatedDimensionValues } from '../sie-job-preparation'

const job = (manifest: Record<string, unknown> = {}) =>
  ({
    id: 'import-1',
    company_id: 'company-1',
    user_id: 'user-1',
    execution_actor_id: null,
    worker_id: 'worker-1',
    job_attempt: 1,
    prepared_through: 0,
    manifest,
  }) as unknown as SIEJob
const LATER = () => Date.now() + 60_000
const VALUE = {
  id: 'val-1',
  dimension_id: 'dim-6',
  code: '1042',
  name: 'Villa Almgren',
  is_active: true,
  start_date: null,
  end_date: null,
}

describe('announceCreatedDimensionValues', () => {
  beforeEach(() => {
    eventBus.clear()
  })

  it('announces the values this import created, with their dimension, scoped to the import and the company', async () => {
    const created = vi.fn()
    eventBus.on('dimension_value.created', created)
    const mock = createTableMockSupabase({
      dimension_values: { data: [VALUE] },
      dimensions: { data: [{ id: 'dim-6', sie_dim_no: 6, name: 'Projekt' }] },
    })

    expect(await announceCreatedDimensionValues(mock.supabase as never, job(), LATER())).toBe(true)

    expect(mock.findCalls('dimension_values', 'eq')).toEqual(
      expect.arrayContaining([
        ['company_id', 'company-1'],
        ['created_by_import_id', 'import-1'],
      ]),
    )
    expect(created).toHaveBeenCalledTimes(1)
    expect(created.mock.calls[0][0]).toEqual({
      dimensionValue: {
        id: 'val-1',
        dimension_id: 'dim-6',
        sie_dim_no: 6,
        dimension_name: 'Projekt',
        code: '1042',
        name: 'Villa Almgren',
        is_active: true,
        start_date: null,
        end_date: null,
      },
      previousName: null,
      userId: 'user-1',
      companyId: 'company-1',
    })
  })

  it('announces nothing when the import created no value', async () => {
    const created = vi.fn()
    eventBus.on('dimension_value.created', created)
    const mock = createTableMockSupabase({ dimension_values: { data: [] } })

    expect(await announceCreatedDimensionValues(mock.supabase as never, job(), LATER())).toBe(true)

    expect(created).not.toHaveBeenCalled()
  })

  it('records how far it got, and resumes there instead of announcing again', async () => {
    const created = vi.fn()
    eventBus.on('dimension_value.created', created)
    const mock = createTableMockSupabase({
      dimension_values: { data: [VALUE] },
      dimensions: { data: [{ id: 'dim-6', sie_dim_no: 6, name: 'Projekt' }] },
    })

    await announceCreatedDimensionValues(mock.supabase as never, job({ dimensionValuesAnnounced: 400 }), LATER())

    // The page after the 400 already announced.
    expect(mock.findCall('dimension_values', 'range')).toEqual([400, 599])
    const checkpoint = mock.findCall('rpc:checkpoint_sie_preparation', 'rpc')?.[0] as { p_manifest: Record<string, unknown> }
    expect(checkpoint.p_manifest.dimensionValuesAnnounced).toBe(401)
  })

  it('stops when the invocation is out of time, announcing nothing', async () => {
    const created = vi.fn()
    eventBus.on('dimension_value.created', created)
    const mock = createTableMockSupabase({ dimension_values: { data: [VALUE] } })

    expect(await announceCreatedDimensionValues(mock.supabase as never, job(), Date.now() - 1)).toBe(false)

    expect(created).not.toHaveBeenCalled()
    expect(mock.findCall('dimension_values', 'select')).toBeUndefined()
  })
})
