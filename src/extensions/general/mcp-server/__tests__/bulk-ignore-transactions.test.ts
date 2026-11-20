/**
 * gnubok_bulk_ignore_transactions (crm#1647): stage ignoring the unbooked
 * bank rows of one cash account dated before a cutoff, as the existing
 * ignore_transaction operation over pinned ids. The selection itself is
 * covered in lib/transactions/__tests__/bulk-ignore.test.ts, the commit in
 * lib/pending-operations/__tests__/ignore-transaction-executor.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools, isDefaultCatalogTool } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { BULK_IGNORE_MAX_ROWS } from '@/lib/transactions/bulk-ignore'

const tool = tools.find((t) => t.name === 'gnubok_bulk_ignore_transactions')!

const CASH = '00000000-0000-4000-8000-0000000000ca'
const ACCOUNT = { id: CASH, name: 'Företagskonto', ledger_account: '1930' }
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ROWS = [
  { id: id(1), date: '2024-02-01' },
  { id: id(2), date: '2025-06-30' },
  { id: id(3), date: '2025-12-30' },
]

const noopSupabase = { from: vi.fn() } as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_bulk_ignore_transactions: registration', () => {
  it('is a search-only staging write (reached through gnubok_stage_tool), strict and transactions:write', () => {
    expect(tool).toBeDefined()
    expect(isDefaultCatalogTool(tool)).toBe(false)
    expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    expect((tool.inputSchema as { required?: string[] }).required).toEqual(['cash_account_id', 'before_date'])
    expect((tool.outputSchema as { required?: string[] }).required).toContain('staged')
    expect(tool.description.length).toBeLessThanOrEqual(280)
    expect(TOOL_SCOPE_MAP.gnubok_bulk_ignore_transactions).toBe('transactions:write')
  })

  it('is where a refused bank-file undo points an agent holding a live-feed row', () => {
    expect(getErrorEntry('BANK_FILE_UNDO_NOT_FOUND')?.remediation?.tool).toBe('gnubok_bulk_ignore_transactions')
  })
})

describe('gnubok_bulk_ignore_transactions: validation', () => {
  it('rejects a cash_account_id that is no UUID before any DB call', async () => {
    await expect(
      tool.execute({ cash_account_id: '1930', before_date: '2026-01-01' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/cash_account_id/)
    expect((noopSupabase as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled()
  })

  it('rejects a before_date that is no YYYY-MM-DD date', async () => {
    await expect(
      tool.execute({ cash_account_id: CASH, before_date: '2026-13-45' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/before_date/)
  })

  it('refuses a cash account that is not the company\'s with CASH_ACCOUNT_NOT_FOUND', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null }) // cash_accounts
    await expect(
      tool.execute({ cash_account_id: CASH, before_date: '2026-01-01' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'CASH_ACCOUNT_NOT_FOUND' })
    expect(findCalls('pending_operations', 'insert')).toEqual([])
  })

  it('answers NOT_FOUND when no unbooked row predates the date, staging nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    enqueue({ data: [], count: 0 }) // open_bank_rows
    await expect(
      tool.execute({ cash_account_id: CASH, before_date: '2026-01-01' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/nothing to ignore/) })
    expect(findCalls('pending_operations', 'insert')).toEqual([])
  })

  it('past the cap: refuses with the earlier before_date that fits in one operation', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    const rows = Array.from({ length: BULK_IGNORE_MAX_ROWS + 1 }, (_, i) => ({
      id: id(i + 1),
      date: i < BULK_IGNORE_MAX_ROWS ? '2024-05-01' : '2024-11-20',
    }))
    enqueue({ data: rows, count: 700 })
    await expect(
      tool.execute({ cash_account_id: CASH, before_date: '2026-01-01' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringMatching(/700 rows.*before_date 2024-11-20 first/) })
    expect(findCalls('pending_operations', 'insert')).toEqual([])
  })
})

describe('gnubok_bulk_ignore_transactions: staging', () => {
  it('stages ignore_transaction over the pinned ids with the selection, and writes no row itself', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    enqueue({ data: ROWS, count: 3 })
    enqueue({ data: { id: 'op-1' }, error: null }) // pending_operations insert

    const result = (await tool.execute(
      { cash_account_id: CASH, before_date: '2026-01-01' },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as { staged: boolean; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('low')
    expect(result.preview).toMatchObject({
      row_count: 3,
      bank_account: '1930 Företagskonto',
      before_date: '2026-01-01',
      first_date: '2024-02-01',
      last_date: '2025-12-30',
      will_be_ignored: true,
      writes_verifikat: false,
    })
    const inserts = findCalls('pending_operations', 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0][0]).toMatchObject({
      operation_type: 'ignore_transaction',
      title: 'Ignorera 3 obokförda bankrader före 2026-01-01 (2024-02-01 t.o.m. 2025-12-30)',
      params: {
        transaction_ids: [id(1), id(2), id(3)],
        cash_account_id: CASH,
        before_date: '2026-01-01',
        ignored: true,
      },
    })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('restore: true stages ignored: false over the ignored rows before the date', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    enqueue({ data: ROWS.slice(0, 1), count: 1 }) // transactions (ignored rows)
    enqueue({ data: { id: 'op-2' }, error: null })

    const result = (await tool.execute(
      { cash_account_id: CASH, before_date: '2026-01-01', restore: true },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as { staged: boolean }

    expect(result.staged).toBe(true)
    expect(findCalls('open_bank_rows', 'select')).toEqual([])
    expect(findCalls('pending_operations', 'insert')[0][0]).toMatchObject({
      title: 'Återställ 1 ignorerade bankrader före 2026-01-01 (2024-02-01 t.o.m. 2024-02-01)',
      params: { transaction_ids: [id(1)], ignored: false },
    })
  })

  it('dry run previews and inserts nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: ACCOUNT })
    enqueue({ data: ROWS, count: 3 })

    const result = (await tool.execute(
      { cash_account_id: CASH, before_date: '2026-01-01', dry_run: true },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as { staged: boolean; dry_run?: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.preview).toMatchObject({ row_count: 3 })
    expect(findCalls('pending_operations', 'insert')).toEqual([])
  })
})
