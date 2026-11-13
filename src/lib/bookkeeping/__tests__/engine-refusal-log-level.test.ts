/**
 * A refusal the database raises on purpose (PT409 conflict, period lock) is
 * an expected answer the doors turn into a 4xx: the engine logs it at warn,
 * so Vercel's runtime errors keep only real failures. Anything else stays an
 * error (prod 2026-10-27: CASH_ACCOUNT_OPERATION_BUSY logged as an error).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}))

vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => logger,
}))

import { commitEntry } from '../engine'
import { BookkeepingDatabaseError } from '../errors'

const COMMIT_FAILED = 'commit_journal_entry RPC failed'

/** The calls of one level that logged the failed commit (commitEntry may warn about other things first). */
function commitLogs(fn: typeof logger.warn): unknown[][] {
  return fn.mock.calls.filter((call) => call[0] === COMMIT_FAILED)
}

/** The draft's source_type read (a periodisering draft is refused before the RPC), then the failing RPC. */
function supabaseFailingCommit(error: Record<string, unknown>) {
  const draftHeader = () => {
    const chain: Record<string, unknown> = {}
    chain.eq = vi.fn(() => chain)
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: { source_type: 'manual' }, error: null })
    return { select: vi.fn(() => chain) }
  }
  return {
    from: vi.fn((table: string) => (table === 'journal_entries' ? draftHeader() : undefined)),
    rpc: vi.fn().mockResolvedValue({ data: null, error }),
  }
}

describe('engine: the log level of a failed commit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a PT409 conflict is a warning', async () => {
    const supabase = supabaseFailingCommit({ code: 'PT409', message: 'CASH_ACCOUNT_OPERATION_BUSY', details: null, hint: null })
    await expect(commitEntry(supabase as never, 'co-1', 'user-1', 'entry-1')).rejects.toThrow(BookkeepingDatabaseError)
    expect(logger.warn).toHaveBeenCalledWith(COMMIT_FAILED, expect.anything(), expect.objectContaining({ pgCode: 'PT409' }))
    expect(commitLogs(logger.error)).toHaveLength(0)
  })

  it('a write behind a period lock is a warning', async () => {
    const supabase = supabaseFailingCommit({
      code: 'P0001',
      message: 'Cannot write to locked/closed fiscal period "2025" (is_closed=t, locked_at=2026-10-16)',
      details: null,
      hint: null,
    })
    await expect(commitEntry(supabase as never, 'co-1', 'user-1', 'entry-1')).rejects.toThrow(BookkeepingDatabaseError)
    expect(commitLogs(logger.warn)).toHaveLength(1)
    expect(commitLogs(logger.error)).toHaveLength(0)
  })

  it('any other database failure stays an error', async () => {
    const supabase = supabaseFailingCommit({ code: '23514', message: 'BANK_BOOKING_CASH_ACCOUNT_MISSING', details: null, hint: null })
    await expect(commitEntry(supabase as never, 'co-1', 'user-1', 'entry-1')).rejects.toThrow(BookkeepingDatabaseError)
    expect(logger.error).toHaveBeenCalledWith(COMMIT_FAILED, expect.anything(), expect.objectContaining({ pgCode: '23514' }))
    expect(commitLogs(logger.warn)).toHaveLength(0)
  })
})
