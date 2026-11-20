/**
 * One classification behind every door. REST (errorResponse, and v1 through
 * it) and MCP (getStructuredError) used to decide the code each on their own,
 * and the same failure answered differently: a statement timeout was a 500 on
 * REST and TRANSIENT_ERROR to an agent, a unique violation VALIDATION_ERROR on
 * REST and UNKNOWN_ERROR to an agent, a refusal written for the reader a coded
 * 400 on REST and UNKNOWN_ERROR to an agent. Now both take classifyError's
 * code; they differ only in wording and in the name of the fallback.
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { classifyError, errorResponse, getStructuredError } from '../get-structured-error'
import { badArgument, codedRefusal } from '../refusal'
import { userFacing } from '../user-facing'
import { JournalEntryNotFoundError } from '@/lib/bookkeeping/errors'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

async function restCode(err: unknown): Promise<{ code: string; status: number }> {
  const res = errorResponse(err, log as never, { requestId: 'req-1' })
  const body = (await res.json()) as { error: { code: string } }
  return { code: body.error.code, status: res.status }
}

const zodFailure = (() => {
  const parsed = z.object({ amount: z.number() }).safeParse({ amount: 'tio' })
  if (parsed.success) throw new Error('fixture must fail')
  return parsed.error
})()

const cases: Array<[string, unknown, string]> = [
  ['a typed bookkeeping error', new JournalEntryNotFoundError(), 'JOURNAL_ENTRY_NOT_FOUND'],
  ['a Zod parse that threw past its site', zodFailure, 'VALIDATION_ERROR'],
  ['a .single() that matched no row', { code: 'PGRST116', details: 'The result contains 0 rows', message: 'no rows' }, 'NOT_FOUND'],
  [
    'a delete other rows still reference',
    {
      code: '23503',
      message: 'update or delete on table "customers" violates foreign key constraint "invoices_customer_id_fkey" on table "invoices"',
      details: 'Key (id)=(4bbade92-9d6c-43cd-b0ff-700d18c78a3c) is still referenced from table "invoices".',
    },
    'RECORD_STILL_REFERENCED',
  ],
  ['a unique violation', { code: '23505', message: 'duplicate key value violates unique constraint "x"' }, 'VALIDATION_ERROR'],
  ['a serialization failure', { code: '40001', message: 'could not serialize access' }, 'TRANSIENT_ERROR'],
  ['a statement timeout', { code: '57014', message: 'canceling statement due to statement timeout' }, 'TRANSIENT_ERROR'],
  ['a refused connection', new Error('connect ECONNREFUSED 127.0.0.1:5432'), 'TRANSIENT_ERROR'],
  // What AbortSignal.timeout rejects a fetch with: a 500 on REST and
  // UNKNOWN_ERROR to an agent until the timeout was read by its name.
  ['a call that ran out of time', new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 'TRANSIENT_ERROR'],
  ['a coded refusal', codedRefusal('PERIOD_NOT_LOCKED', 'Period must be locked before closing'), 'PERIOD_NOT_LOCKED'],
  ['an argument check', badArgument('invoice_id', 'invoice_id is required'), 'VALIDATION_ERROR'],
  [
    'a refusal written for the reader',
    userFacing(new Error('Kan inte låsa period: 2 banktransaktion(er) i perioden saknar bokföring.'), 'PERIOD_HAS_UNBOOKED_TRANSACTIONS'),
    'PERIOD_HAS_UNBOOKED_TRANSACTIONS',
  ],
  [
    'the period-lock trigger',
    { code: 'P0001', message: 'Cannot write to locked/closed fiscal period "2025" (is_closed=t, locked_at=2026-01-31)' },
    'PERIOD_LOCKED',
  ],
]

describe('classifyError: the same code on every door', () => {
  it.each(cases)('%s', async (_label, err, code) => {
    expect(classifyError(err).code).toBe(code)
    expect(getStructuredError(err).code).toBe(code)
    expect((await restCode(err)).code).toBe(code)
  })

  it('names an unidentified failure by each door\'s own fallback', async () => {
    const err = new Error('Cannot read properties of undefined')
    expect(classifyError(err).code).toBe('UNKNOWN_ERROR')
    expect(getStructuredError(err).code).toBe('UNKNOWN_ERROR')
    expect(await restCode(err)).toEqual({ code: 'INTERNAL_ERROR', status: 500 })
  })

  it('keeps an unregistered code out of the REST contract', async () => {
    const err = Object.assign(new Error('provider said no'), { code: 'SOME_PROVIDER_REFUSAL' })
    expect(getStructuredError(err).code).toBe('SOME_PROVIDER_REFUSAL')
    expect((await restCode(err)).code).toBe('INTERNAL_ERROR')
  })

  it('reads a code with a digit inside a word, never a bare SQLSTATE', async () => {
    const k3 = Object.assign(new Error('Komponenterna stämmer inte.'), { code: 'INVALID_K3_COMPONENTS' })
    expect(classifyError(k3).code).toBe('INVALID_K3_COMPONENTS')
    expect(await restCode(k3)).toEqual({ code: 'INVALID_K3_COMPONENTS', status: 400 })
    expect(classifyError(Object.assign(new Error('no data'), { code: 'P0002' })).code).not.toBe('P0002')
  })

  it('answers the registry status for a coded refusal', async () => {
    expect(await restCode(codedRefusal('PERIOD_LOCK_ALREADY_LOCKED', 'Period is already locked'))).toEqual({
      code: 'PERIOD_LOCK_ALREADY_LOCKED',
      status: 409,
    })
  })

  it('carries an argument check\'s field issues into the REST details and message', async () => {
    const res = errorResponse(badArgument('invoice_id', 'invoice_id is required'), log as never, { requestId: 'req-1' })
    const body = (await res.json()) as { error: { message: string; details: { issues: unknown[] } } }
    expect(res.status).toBe(400)
    expect(body.error.details.issues).toEqual([{ field: 'invoice_id', message: 'Obligatoriskt fält saknas.' }])
    expect(body.error.message).toContain('invoice_id')
  })
})
