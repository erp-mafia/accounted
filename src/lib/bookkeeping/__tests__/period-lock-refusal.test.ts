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
import {
  errorResponse,
  getStructuredError,
  isLockDateRefusal,
  isPeriodLockRefusal,
} from '@/lib/errors/get-structured-error'
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

/**
 * The engine's posting functions check the lock themselves before they
 * commit, in their own words: "Cannot <act> in a locked or closed fiscal
 * period" and "Bookkeeping is locked through <date>", under 23514 (P0001 for
 * the opening balance replacement). A draft inserted while the year was open
 * meets them when the year is locked before its commit, and a disposal with
 * nothing to post meets them first. They answered 500
 * BOOKKEEPING_DATABASE_ERROR, retryable, for a lock no retry passes.
 */
describe('a lock refusal raised by an engine posting function', () => {
  // Each function's own text, as its latest migration raises it.
  const PERIOD_LOCKS = [
    ['commit_asset_disposal', 'Cannot dispose asset in a locked or closed fiscal period'],
    ['commit_asset_component_replacement', 'Cannot derecognise a component in a locked or closed fiscal period'],
    ['commit_asset_value_adjustment', 'Cannot adjust an asset in a locked or closed fiscal period'],
    ['commit_deferred_tax', 'Cannot post deferred tax in a locked or closed fiscal period'],
    ['commit_contract_revenue', 'Cannot post contract revenue in a locked or closed fiscal period'],
    ['commit_k3_transition', 'Cannot book the K3 transition in a locked or closed fiscal period'],
  ] as const
  const ENGINE_LOCK_DATE = 'Bookkeeping is locked through 2025-12-31'

  it.each(PERIOD_LOCKS)('is PERIOD_LOCKED for %s', (operation, text) => {
    const refusal = new BookkeepingDatabaseError(operation, text, '23514')

    expect(refusal.code).toBe('PERIOD_LOCKED')
    expect(isPeriodLockRefusal(refusal)).toBe(true)
    expect(isLockDateRefusal(refusal)).toBe(false)
  })

  it('is PERIOD_LOCKED for the company lock date, and reads as the lock date', () => {
    for (const refusal of [
      new BookkeepingDatabaseError('commit_deferred_tax', ENGINE_LOCK_DATE, '23514'),
      new BookkeepingDatabaseError('replace_opening_balance', ENGINE_LOCK_DATE, 'P0001'),
    ]) {
      expect(refusal.code).toBe('PERIOD_LOCKED')
      expect(isLockDateRefusal(refusal)).toBe(true)
    }
  })

  it('answers 400 PERIOD_LOCKED, not retryable, at every door', async () => {
    const refusal = new BookkeepingDatabaseError('commit_asset_disposal', PERIOD_LOCKS[0][1], '23514')

    const dashboard = errorResponse(refusal, log as never)
    expect(dashboard.status).toBe(400)
    expect(((await dashboard.json()) as { error: { code: string } }).error.code).toBe('PERIOD_LOCKED')

    const engineDoor = bookkeepingErrorResponse(refusal)!
    expect(engineDoor.status).toBe(400)
    expect(getErrorMessage(await engineDoor.json())).toBe('Bokföringen är låst för denna period.')

    expect(getStructuredError(refusal)).toMatchObject({ code: 'PERIOD_LOCKED', retryable: false })
  })

  it('leaves the same functions\' other refusals as they were', () => {
    expect(new BookkeepingDatabaseError('commit_asset_disposal', 'Disposal VAT cannot exceed gross proceeds', '23514').code)
      .toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(new BookkeepingDatabaseError('commit_deferred_tax', 'Fiscal period not found: 0c1e', 'P0002').code)
      .toBe('BOOKKEEPING_DATABASE_ERROR')
  })
})
