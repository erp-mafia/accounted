/**
 * createDimensionValue: the one rule set behind every door that creates a
 * dimension value (dashboard POST /api/dimensions/[id]/values, v1 POST
 * .../dimensions/{id}/values, the gnubok_create_dimension_value commit).
 * Before it the v1 copy dropped is_active and skipped the date rule the
 * other two enforced.
 */
import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { createDimensionValue } from '../registry-service'

const log = createLogger('test')

function setup() {
  const mock = createQueuedMockSupabase()
  const ctx = { supabase: mock.supabase as never, companyId: 'company-1', userId: 'user-1', log }
  return { ...mock, ctx }
}

const CREATED = {
  id: 'val-1',
  dimension_id: 'dim-6',
  code: 'P001',
  name: 'Villa Almgren',
  is_active: true,
  start_date: null,
  end_date: null,
  created_at: '2026-09-27T12:00:00Z',
}

describe('createDimensionValue', () => {
  it('looks the dimension up inside the company and answers DIMENSION_NOT_FOUND when it is not there', async () => {
    const { ctx, enqueue, findCalls } = setup()
    enqueue({ data: null }) // dimension lookup

    const outcome = await createDimensionValue(ctx, 'dim-x', { code: 'P001', name: 'X' })

    expect(outcome).toMatchObject({ ok: false, code: 'DIMENSION_NOT_FOUND', details: { dimension_id: 'dim-x' } })
    expect(findCalls('dimensions', 'eq')).toEqual(
      expect.arrayContaining([
        ['id', 'dim-x'],
        ['company_id', 'company-1'],
      ]),
    )
  })

  it('refuses start/end dates on a resets-annually dimension and writes nothing', async () => {
    const { ctx, enqueue, findCall } = setup()
    enqueue({ data: { id: 'dim-1', resets_annually: true } })

    const outcome = await createDimensionValue(ctx, 'dim-1', { code: 'KS01', name: 'Kontoret', end_date: '2026-12-31' })

    expect(outcome).toMatchObject({ ok: false, code: 'DIMENSION_VALUE_DATES_NOT_ALLOWED' })
    expect(findCall('dimension_values', 'insert')).toBeUndefined()
  })

  it('treats explicit null dates on a resets-annually dimension as no dates', async () => {
    const { ctx, enqueue, findCall } = setup()
    enqueue({ data: { id: 'dim-1', resets_annually: true } })
    enqueue({ data: { ...CREATED, dimension_id: 'dim-1', code: 'KS01' } })

    const outcome = await createDimensionValue(ctx, 'dim-1', {
      code: 'KS01',
      name: 'Kontoret',
      start_date: null,
      end_date: null,
    })

    expect(outcome.ok).toBe(true)
    expect(findCall('dimension_values', 'insert')?.[0]).toMatchObject({ start_date: null, end_date: null })
  })

  it('inserts company-scoped, active by default, and answers created', async () => {
    const { ctx, enqueue, findCall } = setup()
    enqueue({ data: { id: 'dim-6', resets_annually: false } })
    enqueue({ data: CREATED })

    const outcome = await createDimensionValue(ctx, 'dim-6', {
      code: 'P001',
      name: 'Villa Almgren',
      start_date: '2026-01-01',
    })

    expect(outcome).toEqual({ ok: true, data: CREATED, created: true })
    expect(findCall('dimension_values', 'insert')?.[0]).toEqual({
      company_id: 'company-1',
      dimension_id: 'dim-6',
      code: 'P001',
      name: 'Villa Almgren',
      is_active: true,
      start_date: '2026-01-01',
      end_date: null,
    })
  })

  it('honours is_active=false: the value is created archived in one write', async () => {
    const { ctx, enqueue, findCall } = setup()
    enqueue({ data: { id: 'dim-6', resets_annually: false } })
    enqueue({ data: { ...CREATED, is_active: false } })

    const outcome = await createDimensionValue(ctx, 'dim-6', { code: 'P001', name: 'Villa Almgren', is_active: false })

    expect(outcome.ok).toBe(true)
    expect(findCall('dimension_values', 'insert')?.[0]).toMatchObject({ is_active: false })
  })

  it('a dry run checks the dimension and the date rule, previews the row and writes nothing', async () => {
    const { ctx, enqueue, findCall } = setup()
    enqueue({ data: { id: 'dim-6', resets_annually: false } })

    const outcome = await createDimensionValue(
      ctx,
      'dim-6',
      { code: 'P001', name: 'Villa Almgren', is_active: false },
      { dryRun: true },
    )

    expect(outcome).toEqual({
      ok: true,
      dryRun: true,
      preview: {
        id: null,
        dimension_id: 'dim-6',
        code: 'P001',
        name: 'Villa Almgren',
        is_active: false,
        start_date: null,
        end_date: null,
        created_at: null,
      },
    })
    expect(findCall('dimension_values', 'insert')).toBeUndefined()
  })

  it('answers DIMENSION_VALUE_DUPLICATE_CODE when the UNIQUE refuses the code', async () => {
    const { ctx, enqueue } = setup()
    enqueue({ data: { id: 'dim-6', resets_annually: false } })
    enqueue({ error: { code: '23505', message: 'duplicate key value' } })

    const outcome = await createDimensionValue(ctx, 'dim-6', { code: 'P001', name: 'Villa Almgren' })

    expect(outcome).toMatchObject({ ok: false, code: 'DIMENSION_VALUE_DUPLICATE_CODE', details: { code: 'P001' } })
  })

  it('answers DIMENSION_VALUE_CREATE_FAILED for any other insert failure', async () => {
    const { ctx, enqueue } = setup()
    enqueue({ data: { id: 'dim-6', resets_annually: false } })
    enqueue({ error: { code: '23514', message: 'check violation' } })

    const outcome = await createDimensionValue(ctx, 'dim-6', { code: 'P001', name: 'Villa Almgren' })

    expect(outcome).toMatchObject({ ok: false, code: 'DIMENSION_VALUE_CREATE_FAILED' })
  })

  it('hands a failed dimension lookup to the door as the raw error', async () => {
    const { ctx, enqueue } = setup()
    const dbError = { code: '57014', message: 'canceling statement due to statement timeout' }
    enqueue({ error: dbError })

    const outcome = await createDimensionValue(ctx, 'dim-6', { code: 'P001', name: 'Villa Almgren' })

    expect(outcome).toMatchObject({ ok: false, code: 'UNKNOWN_ERROR', error: dbError })
  })
})
