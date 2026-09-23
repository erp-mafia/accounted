import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const IMPORT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const statusTool = tools.find(tool => tool.name === 'gnubok_sie_import_status')!
const undoTool = tools.find(tool => tool.name === 'gnubok_undo_sie_import')!
const db = createQueuedMockSupabase()
const call = () => statusTool.execute({ import_id: IMPORT }, 'company-1', 'user-1', db.supabase as never) as Promise<Record<string, unknown>>
const outputValidator = z.fromJSONSchema(statusTool.outputSchema!)

describe('MCP SIE legacy recovery', () => {
  beforeEach(() => { vi.clearAllMocks(); db.reset() })

  it('preserves durable progress', async () => {
    db.enqueue({ data: { id: IMPORT, job_state: 'completed', chunks_done: 4, chunks_total: 4,
      transactions_count: 81, error_message: null, job_result: { completed: true } } })
    const result = await call()
    expect(result).toEqual({ import_id: IMPORT, kind: 'durable', state: 'completed', chunks_done: 4,
      chunks_total: 4, vouchers_written: 81, error_message: null, result: { completed: true } })
    expect(outputValidator.safeParse(result).success).toBe(true)
    expect(outputValidator.safeParse({ ...result, kind: 'legacy' }).success).toBe(false)
  })

  it.each(['failed', 'pending', 'completed', 'undone', 'timed_out'])('reports legacy %s as review-required, with no invented progress', async status => {
    const row = { id: IMPORT, status, job_state: null, fiscal_period_id: 'period-1' }
    db.enqueueMany([{ data: row }, { data: row },
      { data: { id: 'period-1', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: true, locked_at: null, import_hold: null } },
      { data: { bookkeeping_locked_through: '2026-06-30' } }, { count: 6850 }, { count: 6849 }, { count: 6848 },
    ])
    const result = await call()
    expect(result).toMatchObject({ import_id: IMPORT, kind: 'legacy', state: 'review_required',
      chunks_done: null, chunks_total: null, vouchers_written: null, result: null,
      recovery: { legacy_status: status, entry_ownership: 'unverified', mutation_available: false,
        fiscal_period: { fiscal_period_id: 'period-1', is_closed: true },
        period_entries: { all: 6850, posted: 6849, importOrOpening: 6848 },
        company_lock: { known: true, through: '2026-06-30' }, assessment_api_url: `/api/import/sie/${IMPORT}/recovery` },
    })
    expect(outputValidator.safeParse(result).success).toBe(true)
    expect(outputValidator.safeParse({ ...result, kind: 'durable' }).success).toBe(false)
    expect(outputValidator.safeParse({ ...result, recovery: undefined }).success).toBe(false)
    expect(db.calls.some(call => ['insert', 'update', 'delete', 'upsert'].includes(call.method))).toBe(false)
    expect(db.supabase.rpc).not.toHaveBeenCalled()
  })

  it('validates a legacy assessment whose period and entry counts are unknown', async () => {
    const row = { id: IMPORT, status: 'failed', job_state: null, fiscal_period_id: null }
    db.enqueueMany([{ data: row }, { data: row }, { data: null }])
    const result = await call()
    expect(result).toMatchObject({ kind: 'legacy', recovery: { fiscal_period: null, period_entries: null,
      company_lock: { known: false, through: null } } })
    expect(outputValidator.safeParse(result).success).toBe(true)
  })

  it('does not leak an import outside the active company', async () => {
    db.enqueueMany([{ data: null }, { data: null }])
    await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(db.findCalls('sie_imports', 'eq').filter(args => args[0] === 'company_id')).toEqual([
      ['company_id', 'company-1'], ['company_id', 'company-1'],
    ])
  })

  it('preserves database errors', async () => {
    const error = { code: '57014', message: 'statement timeout' }
    db.enqueue({ error })
    await expect(call()).rejects.toThrow('statement timeout')
  })

  it.each(['failed', 'completed'])('does not stage undo for legacy %s', async status => {
    db.enqueue({ data: { id: IMPORT, status, job_state: null } })
    await expect(undoTool.execute({ import_id: IMPORT }, 'company-1', 'user-1', db.supabase as never))
      .rejects.toMatchObject({ code: 'SIE_IMPORT_LEGACY_REVIEW_REQUIRED' })
    expect(db.findCalls('pending_operations', 'insert')).toHaveLength(0)
    expect(db.supabase.rpc).not.toHaveBeenCalled()
  })
})

describe('gnubok_sie_import_status without an import_id', () => {
  beforeEach(() => { vi.clearAllMocks(); db.reset() })

  it('lists the company\'s recent imports instead of querying with the string "undefined"', async () => {
    db.enqueue({ data: [
      { id: IMPORT, filename: 'migration-sie-2026-01-01.se', status: 'completed', job_state: 'completed', created_at: '2026-09-15T14:34:28Z', replaced_at: null },
      { id: OTHER, filename: 'migration-sie-2025-01-01.se', status: 'completed', job_state: 'completed', created_at: '2026-09-15T14:23:52Z', replaced_at: null },
    ] })
    const result = await statusTool.execute({}, 'company-1', 'user-1', db.supabase as never) as Record<string, unknown>
    expect(result).toMatchObject({ kind: 'list', count: 2, imports: [
      { import_id: IMPORT, filename: 'migration-sie-2026-01-01.se', status: 'completed', job_state: 'completed', replaced_at: null },
      { import_id: OTHER },
    ] })
    expect(outputValidator.safeParse(result).success).toBe(true)
    expect(db.findCalls('sie_imports', 'eq')).toEqual([['company_id', 'company-1']])
    expect(db.findCall('sie_imports', 'order')).toEqual(['created_at', { ascending: false }])
    expect(db.findCall('sie_imports', 'limit')).toEqual([10])
  })

  it('answers a company with no imports with an empty list, not an error', async () => {
    const result = await statusTool.execute({}, 'company-1', 'user-1', db.supabase as never) as Record<string, unknown>
    expect(result).toMatchObject({ kind: 'list', count: 0, imports: [] })
    expect(outputValidator.safeParse(result).success).toBe(true)
  })

  it.each(['import-1', 'undefined', 42])('rejects import_id %s before any query', async (bad) => {
    await expect(statusTool.execute({ import_id: bad }, 'company-1', 'user-1', db.supabase as never))
      .rejects.toThrow(/import_id must be the UUID/)
    expect(db.calls).toHaveLength(0)
  })

  it('no longer lists import_id as required, so an omitted id is a list, not a schema violation', () => {
    expect((statusTool.inputSchema as { required?: string[] }).required).toBeUndefined()
  })
})
