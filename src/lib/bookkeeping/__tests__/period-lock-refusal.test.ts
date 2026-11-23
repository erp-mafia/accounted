/**
 * A write behind a period lock, a closed year or the company lock date is
 * refused by the database triggers (enforce_period_lock, migration 017;
 * enforce_company_lock_date) as plain text under SQLSTATE P0001. The refusal
 * is an answer, not a failure: every door names it PERIOD_LOCKED.
 *
 * 2026-11-22 in production: a verifikat dated in a year that had been locked
 * three minutes earlier. The draft insert was refused and the dashboard door
 * answered 500 BOOKKEEPING_DATABASE_ERROR, which the registry marks
 * retryable, so the server reported its own failure for a lock that holds.
 */
import { describe, expect, it, vi } from 'vitest'
import { BookkeepingDatabaseError, bookkeepingErrorResponse } from '../errors'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'

const PERIOD_LOCK =
  'Cannot write to locked/closed fiscal period "Räkenskapsår 2025" (is_closed=t, locked_at=2026-11-22 11:03:58.82+00)'
// enforce_company_lock_date's own text (20260401200000_settings_restructure.sql).
const LOCK_DATE = 'Bokföringen är låst t.o.m. 2025-12-31. Kan inte skapa verifikation med datum 2025-11-30.'
const DOCUMENT_LOCK = 'Cannot attach documents to entries in a locked/closed fiscal period'

const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }

describe('a lock refusal from the database', () => {
  it('is PERIOD_LOCKED, for a period lock and for the company lock date', () => {
    expect(new BookkeepingDatabaseError('create_draft_entry', PERIOD_LOCK, 'P0001').code).toBe('PERIOD_LOCKED')
    expect(new BookkeepingDatabaseError('commit_entry', LOCK_DATE, 'P0001').code).toBe('PERIOD_LOCKED')
  })

  it('keeps the document trigger its own code', () => {
    expect(new BookkeepingDatabaseError('create_draft_entry', DOCUMENT_LOCK, 'P0001').code).toBe('DOC_UPLOAD_PERIOD_LOCKED')
  })

  it('leaves every other database failure the generic database error', () => {
    expect(new BookkeepingDatabaseError('create_draft_entry', 'duplicate key value violates unique constraint', '23505').code)
      .toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(new BookkeepingDatabaseError('create_draft_entry', 'Entry is not balanced', 'P0001').code)
      .toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(new BookkeepingDatabaseError('create_draft_entry', undefined).code).toBe('BOOKKEEPING_DATABASE_ERROR')
  })

  it('answers 400 PERIOD_LOCKED at the dashboard doors, with the lock in the sentence the form shows', async () => {
    const response = bookkeepingErrorResponse(new BookkeepingDatabaseError('create_draft_entry', PERIOD_LOCK, 'P0001'))!
    const body = (await response.json()) as { error: { code: string; details: { operation: string } } }

    expect(response.status).toBe(400)
    expect(body.error).toMatchObject({ code: 'PERIOD_LOCKED', details: { operation: 'create_draft_entry' } })
    expect(getErrorMessage(body)).toBe('Perioden är låst. Verifikationen kan inte skapas i en stängd eller låst period.')
  })

  it('keeps the lock date in the sentence for a write behind the company lock date', async () => {
    const response = bookkeepingErrorResponse(new BookkeepingDatabaseError('commit_entry', LOCK_DATE, 'P0001'))!

    expect(response.status).toBe(400)
    expect(getErrorMessage(await response.json())).toBe('Bokföringen är låst t.o.m. 2025-12-31.')
  })

  it('answers 400 PERIOD_LOCKED through the registry at the v1, MCP and commit doors', async () => {
    const response = errorResponse(new BookkeepingDatabaseError('create_draft_entry', PERIOD_LOCK, 'P0001'), log as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('PERIOD_LOCKED')
  })

  it('still answers a database failure as the retryable 500 it is', async () => {
    const response = bookkeepingErrorResponse(new BookkeepingDatabaseError('create_draft_entry', 'connection reset', '08006'))!
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(500)
    expect(body.error.code).toBe('BOOKKEEPING_DATABASE_ERROR')
  })
})
