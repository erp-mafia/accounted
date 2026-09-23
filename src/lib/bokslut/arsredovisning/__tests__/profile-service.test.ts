/**
 * Error-contract tests for the annual-report profile service.
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
import { getAnnualReportProfile, upsertAnnualReportProfile } from '../profile-service'

const noopLogger = { error: () => {}, warn: () => {} }

/**
 * Shape PostgREST actually returns for a failed CHECK: the constraint name is
 * in `message`, the failing row in `details`, and the SQLSTATE in `code`.
 */
function checkViolation(constraint: string) {
  return Object.assign(
    new Error(
      `new row for relation "annual_report_profiles" violates check constraint "${constraint}"`,
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

const profileRow = {
  id: 'profile-1',
  company_id: 'company-1',
  fiscal_period_id: 'period-1',
  is_parent_company: false,
  reporting_currency: 'SEK',
  updated_at: '2026-01-15T10:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('upsertAnnualReportProfile', () => {
  it('returns the persisted row on the happy path', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: profileRow })
    const result = await upsertAnnualReportProfile(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      'period-1',
      { reporting_currency: 'SEK' },
    )
    expect(result).toEqual(profileRow)
  })

  it('preserves the Postgres SQLSTATE on a CHECK violation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: checkViolation('annual_report_profiles_parent_consistency') })
    const err = await upsertAnnualReportProfile(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      'period-1',
      { parent_group_size: 'small' },
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ code: '23514' })
    expect((err as Error).message).toContain('annual_report_profiles_parent_consistency')
  })

  it('maps a CHECK violation to 400 with a Swedish message', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: checkViolation('annual_report_profiles_parent_consistency') })
    const err = await upsertAnnualReportProfile(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      'period-1',
      { prepares_consolidated_accounts: true },
    ).catch((e: unknown) => e)

    const { status, body } = await envelopeFor(err)
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toBe('Förfrågan innehåller ogiltiga uppgifter.')
    expect(body.error.details).toMatchObject({ pgCode: '23514' })
    // The failing row must not reach the client.
    expect(JSON.stringify(body)).not.toContain('Failing row')
  })

  it('maps an RLS refusal to 403 instead of 500', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      error: Object.assign(
        new Error('new row violates row-level security policy for table "annual_report_profiles"'),
        { name: 'PostgrestError', code: '42501', details: null, hint: null },
      ),
    })
    const err = await upsertAnnualReportProfile(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      'period-1',
      { reporting_currency: 'SEK' },
    ).catch((e: unknown) => e)

    const { status, body } = await envelopeFor(err)
    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
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
    const err = await upsertAnnualReportProfile(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      'period-1',
      { reporting_currency: 'SEK' },
    ).catch((e: unknown) => e)

    const { status, body } = await envelopeFor(err)
    expect(status).toBe(500)
    expect(body.error.code).toBe('INTERNAL_ERROR')
  })

  it('still yields 500 when the write reports no row and no error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const err = await upsertAnnualReportProfile(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      'period-1',
      { reporting_currency: 'SEK' },
    ).catch((e: unknown) => e)

    expect((await envelopeFor(err)).status).toBe(500)
  })
})

describe('getAnnualReportProfile', () => {
  it('falls back to the empty profile when no row exists', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const result = await getAnnualReportProfile(
      supabase as unknown as SupabaseClient,
      'company-1',
      'period-1',
    )
    expect(result.company_id).toBe('company-1')
    expect(result.fiscal_period_id).toBe('period-1')
  })

  it('preserves the Postgres SQLSTATE on a read failure', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      error: Object.assign(new Error('permission denied for table annual_report_profiles'), {
        name: 'PostgrestError',
        code: '42501',
        details: null,
        hint: null,
      }),
    })
    const err = await getAnnualReportProfile(
      supabase as unknown as SupabaseClient,
      'company-1',
      'period-1',
    ).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: '42501' })
    expect((await envelopeFor(err)).status).toBe(403)
  })
})
