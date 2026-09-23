/**
 * Error-contract tests for the årsredovisning narrative service.
 *
 * The service used to re-wrap Supabase's PostgrestError in a plain
 * `new Error(...)`, which kept only `.message` and dropped `.code`. Without the
 * SQLSTATE, errorResponse() could not recognise the failure as a Postgres
 * constraint violation and returned INTERNAL_ERROR / 500 for what is a caller
 * mistake. These tests pin the SQLSTATE pass-through and the resulting envelope.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { errorResponse, type ErrorEnvelope } from '@/lib/errors/get-structured-error'
import { getNarrative, upsertNarrative } from '../narrative-service'

const noopLogger = { error: () => {}, warn: () => {} }

/**
 * Shape PostgREST actually returns for a failed CHECK: the constraint name is
 * in `message`, the failing row in `details`, and the SQLSTATE in `code`.
 */
function checkViolation(constraint: string) {
  return Object.assign(
    new Error(
      `new row for relation "arsredovisning_narratives" violates check constraint "${constraint}"`,
    ),
    {
      name: 'PostgrestError',
      code: '23514',
      details: 'Failing row contains (...)',
      hint: null,
    },
  )
}

async function envelopeFor(err: unknown): Promise<{ status: number; body: ErrorEnvelope }> {
  const res = errorResponse(err, noopLogger, { requestId: 'req_test' })
  return { status: res.status, body: (await res.json()) as ErrorEnvelope }
}

const narrativeRow = {
  id: 'narrative-1',
  company_id: 'company-1',
  fiscal_period_id: 'period-1',
  description: 'Bolaget bedriver konsultverksamhet.',
  agm_disposition_outcome: null,
  agm_disposition_decision: null,
  updated_at: '2026-01-15T10:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('upsertNarrative', () => {
  it('returns the persisted row on the happy path', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: narrativeRow })
    const result = await upsertNarrative(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      'period-1',
      { description: 'Bolaget bedriver konsultverksamhet.' },
    )
    expect(result).toEqual(narrativeRow)
  })

  it('preserves the Postgres SQLSTATE on a CHECK violation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: checkViolation('arsredovisning_narratives_agm_decision_consistency') })
    const err = await upsertNarrative(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      'period-1',
      { agm_disposition_outcome: 'alternative_decision' },
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ code: '23514' })
    expect((err as Error).message).toContain(
      'arsredovisning_narratives_agm_decision_consistency',
    )
  })

  it('maps a CHECK violation to 400 with a Swedish message', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: checkViolation('arsredovisning_narratives_agm_decision_consistency') })
    const err = await upsertNarrative(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      'period-1',
      { agm_disposition_decision: '   ' },
    ).catch((e: unknown) => e)

    const { status, body } = await envelopeFor(err)
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toBe('Förfrågan innehåller ogiltiga uppgifter.')
    expect(body.error.details).toMatchObject({ pgCode: '23514' })
    // The failing row must not reach the client.
    expect(JSON.stringify(body)).not.toContain('Failing row')
  })

  it('still yields 500 for a genuine internal database failure', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      error: Object.assign(new Error('internal error occurred'), {
        name: 'PostgrestError',
        // XX000 internal_error: not a caller mistake, must not become a 400.
        code: 'XX000',
        details: null,
        hint: null,
      }),
    })
    const err = await upsertNarrative(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      'period-1',
      { description: 'x' },
    ).catch((e: unknown) => e)

    const { status, body } = await envelopeFor(err)
    expect(status).toBe(500)
    expect(body.error.code).toBe('INTERNAL_ERROR')
  })

  it('still yields 500 when the write reports no row and no error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const err = await upsertNarrative(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      'period-1',
      { description: 'x' },
    ).catch((e: unknown) => e)

    expect((await envelopeFor(err)).status).toBe(500)
  })
})

describe('getNarrative', () => {
  it('returns null when nothing has been customised yet', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const result = await getNarrative(
      supabase as unknown as SupabaseClient,
      'company-1',
      'period-1',
    )
    expect(result).toBeNull()
  })

  it('preserves the Postgres SQLSTATE on a read failure', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      error: Object.assign(new Error('permission denied for table arsredovisning_narratives'), {
        name: 'PostgrestError',
        code: '42501',
        details: null,
        hint: null,
      }),
    })
    const err = await getNarrative(
      supabase as unknown as SupabaseClient,
      'company-1',
      'period-1',
    ).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: '42501' })
    expect((await envelopeFor(err)).status).toBe(403)
  })
})
