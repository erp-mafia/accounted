import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { closedPeriodRefusal, ensureFiscalPeriod } from '../sie-import'
import { assertSIEReportingAccounts, SIEJobValidationError } from '../sie-jobs'
import { userFacingCode } from '@/lib/errors/user-facing'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'

// The two places the SIE import marks its refusals user-facing, exercised
// through the real error envelope: the marker is only worth something if the
// sentence survives errorResponse at the call sites that set it.

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

type Envelope = {
  error: { code: string; message: string; message_en: string; details?: Record<string, unknown> }
}

async function envelope(err: unknown) {
  const res = errorResponse(err, log as never, { requestId: 'req-1' })
  return { status: res.status, body: (await res.json()) as Envelope }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected the promise to reject')
}

describe('ensureFiscalPeriod refusals reach the reader', () => {
  const klarmarkerat = {
    id: 'fy-2021',
    name: '2021',
    period_start: '2021-01-01',
    period_end: '2021-12-31',
    is_closed: true,
    locked_at: null,
    closed_externally: true,
    closing_entry_id: null,
  }

  it('answers a klarmarkerat containing year with a 400 carrying the reopen sentence, not a 500', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: klarmarkerat, error: null }]) // containing check

    const err = await rejection(
      ensureFiscalPeriod(supabase as unknown as SupabaseClient, 'company-id', '2021-01-01', '2021-12-31'),
    )
    expect(userFacingCode(err)).toBe('VALIDATION_ERROR')

    const expected = closedPeriodRefusal(klarmarkerat)
    expect(expected).toContain('Öppna igen')
    const { status, body } = await envelope(err)
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toBe(expected)
    expect(body.error.message_en).toBe(expected)
    // Nothing was written: the refusal comes from the read-only precheck.
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('answers a locked containing year with the unlock sentence', async () => {
    const locked = { ...klarmarkerat, is_closed: false, closed_externally: false, locked_at: '2022-03-01T00:00:00Z' }
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: locked, error: null }])

    const err = await rejection(
      ensureFiscalPeriod(supabase as unknown as SupabaseClient, 'company-id', '2021-01-01', '2021-12-31'),
    )
    const { status, body } = await envelope(err)
    expect(status).toBe(400)
    expect(body.error.message).toBe(closedPeriodRefusal(locked))
    expect(body.error.message).toContain('Lås upp')
  })

  it('answers a BFL 3 kap. shape refusal (over 18 months) with its own sentence', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null }, // containing check, no match
      { data: [], error: null }, // overlapping check, none
    ])

    const err = await rejection(
      ensureFiscalPeriod(supabase as unknown as SupabaseClient, 'company-id', '2025-06-01', '2026-12-31'),
    )
    const { status, body } = await envelope(err)
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toMatch(/omfattar 19 månader[\s\S]*högst 18 månader \(BFL 3 kap\.\)/)
  })
})

describe('SIEJobValidationError marking', () => {
  it('marks the generic VALIDATION_ERROR so its sentence replaces the registry line', async () => {
    const sentence = 'Nya SIE-importer är tillfälligt pausade. Pågående importer fortsätter.'
    const err = new SIEJobValidationError(sentence)
    expect(userFacingCode(err)).toBe('VALIDATION_ERROR')

    const { status, body } = await envelope(err)
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toBe(sentence)
    expect(body.error.message_en).toBe(sentence)
  })

  it('leaves SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS unmarked so it keeps its bilingual registry text', async () => {
    let err: unknown
    try {
      assertSIEReportingAccounts(['1930', '9999'])
    } catch (thrown) {
      err = thrown
    }
    expect(err).toBeInstanceOf(SIEJobValidationError)
    expect((err as SIEJobValidationError).code).toBe('SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS')
    expect(userFacingCode(err)).toBeNull()

    const entry = getErrorEntry('SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS')!
    const { status, body } = await envelope(err)
    expect(status).toBe(400)
    expect(body.error.code).toBe('SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS')
    expect(body.error.message).toBe(entry.message_sv)
    // The English client keeps English: the validator's sentence is Swedish only.
    expect(body.error.message_en).toBe(entry.message_en)
  })
})
