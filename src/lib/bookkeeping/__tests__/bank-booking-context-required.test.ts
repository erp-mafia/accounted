/**
 * guard_bank_booking_context refuses (23514, BANK_BOOKING_CONTEXT_REQUIRED) to
 * post a verifikat with source_type 'bank_transaction' whose
 * bank_booking_context does not name its source row. The refusal is answered
 * by its own name, with where to book the row, not as the generic database
 * error.
 *
 * 2026-11-16: such a draft (left without its context) was committed from the
 * verifikat list and the person read "Verifikationen kunde inte sparas.
 * Försök igen.", twice. A bank_transaction draft that does name its row
 * (an API integration's own) still commits through the generic commit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const emit = vi.fn().mockResolvedValue([])
vi.mock('@/lib/events', () => ({
  eventBus: { emit: (...args: unknown[]) => emit(...args) },
}))

vi.mock('@/lib/logger', async (importOriginal) => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  logger.child.mockReturnValue(logger)
  return { ...(await importOriginal<typeof import('@/lib/logger')>()), createLogger: () => logger }
})

const { commitEntry } = await import('../engine')
const { BookkeepingDatabaseError } = await import('../errors')
const { errorResponse } = await import('@/lib/errors/get-structured-error')
const { getErrorMessage } = await import('@/lib/errors/get-error-message')

const COMPANY = 'company-1'
const USER = 'user-1'
const SENTENCE =
  'Utkastet kommer från en banktransaktion men saknar kopplingen till den, så det kan inte bokföras härifrån. ' +
  'Öppna transaktionen under Transaktioner och bokför den där. Är den redan bokförd behövs inte utkastet.'
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('BANK_BOOKING_CONTEXT_REQUIRED', () => {
  it('commitEntry: the guard refusing the draft surfaces as the named code, nothing posted', async () => {
    const mock = createTableMockSupabase({
      journal_entries: { data: { source_type: 'bank_transaction' } },
      'rpc:commit_journal_entry': { error: { code: '23514', message: 'BANK_BOOKING_CONTEXT_REQUIRED' } },
    })

    const failure = await commitEntry(mock.supabase as never, COMPANY, USER, 'draft-1').catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(BookkeepingDatabaseError)
    expect(failure).toMatchObject({ code: 'BANK_BOOKING_CONTEXT_REQUIRED', pgCode: '23514' })
    expect(emit).not.toHaveBeenCalled()
  })

  it('commitEntry: a bank_transaction draft that names its row is committed as before', async () => {
    const posted = { id: 'draft-1', company_id: COMPANY, status: 'posted', voucher_number: 7, lines: [] }
    const mock = createTableMockSupabase({
      journal_entries: [{ data: { source_type: 'bank_transaction' } }, { data: posted }],
    })

    const entry = await commitEntry(mock.supabase as never, COMPANY, USER, 'draft-1')

    expect(entry).toEqual(posted)
    expect(mock.findCall('rpc:commit_journal_entry', 'rpc')).toEqual([expect.objectContaining({ p_entry_id: 'draft-1' })])
  })

  it('answers 409 with where to book the row, the same sentence wherever it is shown', async () => {
    const error = new BookkeepingDatabaseError('commit_entry', 'BANK_BOOKING_CONTEXT_REQUIRED', '23514')
    const response = errorResponse(error, log as never)
    const body = (await response.json()) as { error: { code: string; message: string } }

    expect(response.status).toBe(409)
    expect(body.error).toMatchObject({ code: 'BANK_BOOKING_CONTEXT_REQUIRED', message: SENTENCE })
    expect(getErrorMessage(error)).toBe(SENTENCE)
  })

  it('leaves every other check violation the generic database error', () => {
    expect(new BookkeepingDatabaseError('commit_entry', 'BANK_BOOKING_CONTEXT_INVALID', '23514').code).toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(new BookkeepingDatabaseError('commit_entry', 'BANK_BOOKING_CONTEXT_REQUIRED', '23505').code).toBe('BOOKKEEPING_DATABASE_ERROR')
  })
})
